import { XMLParser } from 'fast-xml-parser';
import { env } from '../lib/env';
import { capRawPayload, safeFetch, stripDangerousKeys } from '../lib/security';
import { buildDealYm, clean, parseArea, parseInt0, parseManwon } from '../lib/text';
import { HOUSING_TYPES, type HousingType, type NormalizedDeal, type Slot } from './molit-types';

/**
 * 국토교통부 전월세 실거래가 수집기.
 *
 * 엔드포인트와 필드명은 문서가 아니라 실측으로 확정했다(`npm run probe:molit`).
 * 문서에는 필드명이 한국어(보증금액/월세금액)로 적혀 있지만 실제 응답은
 * 영문 camelCase 다. 문서를 믿었다면 전 필드가 null 로 적재되면서도 예외는
 * 나지 않는 형태로 깨졌을 것이다.
 */
const HOST = 'apis.data.go.kr';
const ORG = '1613000'; // 국토교통부

const PATHS: Record<HousingType, string> = {
  apt: `/${ORG}/RTMSDataSvcAptRent/getRTMSDataSvcAptRent`,
  offi: `/${ORG}/RTMSDataSvcOffiRent/getRTMSDataSvcOffiRent`,
  rh: `/${ORG}/RTMSDataSvcRHRent/getRTMSDataSvcRHRent`,
  sh: `/${ORG}/RTMSDataSvcSHRent/getRTMSDataSvcSHRent`,
};

const PAGE_SIZE = 1000;
const MAX_PAGES = 20; // 폭주 방지. 시군구 1개월 거래가 2만 건을 넘는 경우는 없다

const parser = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: false, // 값을 숫자로 자동 변환하지 않는다. "70,000" 을 온전히 받아야 한다
  trimValues: true,
});

export interface FetchResult {
  deals: NormalizedDeal[];
  /** API 가 보고한 전체 건수 */
  totalCount: number;
  /** 실제로 소비한 API 호출 수. 일 10,000회 예산 관리에 쓴다 */
  calls: number;
}

export function isHousingType(v: string): v is HousingType {
  return (HOUSING_TYPES as string[]).includes(v);
}

/** 한 슬롯(주택유형 × 시군구 × 계약년월)을 끝까지 페이징해 가져온다. */
export async function fetchSlot(slot: Slot): Promise<FetchResult> {
  const deals: NormalizedDeal[] = [];
  let totalCount = 0;
  let calls = 0;

  for (let pageNo = 1; pageNo <= MAX_PAGES; pageNo++) {
    const page = await fetchPage(slot, pageNo);
    calls += page.calls;
    if (pageNo === 1) totalCount = page.totalCount;

    for (const item of page.items) {
      const d = mapItem(item, slot);
      if (d) deals.push(d);
    }

    if (page.items.length < PAGE_SIZE) break;
    if (totalCount > 0 && deals.length >= totalCount) break;
    await sleep(120); // 공공 API 예절
  }

  return { deals, totalCount, calls };
}

interface Page {
  items: Record<string, unknown>[];
  totalCount: number;
  calls: number;
}

async function fetchPage(slot: Slot, pageNo: number): Promise<Page> {
  const url = new URL(`https://${HOST}${PATHS[slot.housingType]}`);
  url.searchParams.set('serviceKey', env.molitKey);
  url.searchParams.set('LAWD_CD', slot.regionCode);
  url.searchParams.set('DEAL_YMD', slot.dealYm);
  url.searchParams.set('numOfRows', String(PAGE_SIZE));
  url.searchParams.set('pageNo', String(pageNo));

  let calls = 0;
  let lastErr: unknown;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      calls += 1;
      const res = await safeFetch(url, {
        allowHosts: [HOST],
        maxRedirects: 0,
        maxBytes: 32 * 1024 * 1024,
        timeoutMs: 40_000,
      });
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);

      const parsed = stripDangerousKeys(parser.parse(res.text)) as Record<string, any>;

      // 오류도 HTTP 200 으로 온다. resultCode 를 반드시 확인한다.
      const header = parsed?.response?.header;
      const code = clean(header?.resultCode);
      const msg = clean(header?.resultMsg);

      if (code && !/^0*0$/.test(code) && !/^000$/.test(code)) {
        // 03 = NODATA. 그 달 거래가 실제로 0건인 정상 상황이다.
        if (code === '03' || /NODATA/i.test(msg ?? '')) {
          return { items: [], totalCount: 0, calls };
        }
        throw new Error(`resultCode=${code} ${msg ?? ''}`.trim());
      }

      const body = parsed?.response?.body;
      const totalCount = Number(clean(body?.totalCount) ?? 0) || 0;
      const raw = body?.items?.item;
      if (!raw) return { items: [], totalCount, calls };

      return { items: Array.isArray(raw) ? raw : [raw], totalCount, calls };
    } catch (e) {
      lastErr = e;
      // 인증/권한 문제는 재시도해도 소용없다.
      if (/resultCode=(20|22|30|31)/.test(String(e))) throw e;
      await sleep(800 * (attempt + 1));
    }
  }

  throw new Error(
    `${slot.housingType}/${slot.regionCode}/${slot.dealYm} 조회 실패: ${String(lastErr).slice(0, 160)}`,
  );
}

/** 후보 키를 순회해 첫 유효값을 반환한다. 유형별 필드명 차이를 흡수한다. */
function pick(item: Record<string, unknown>, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = clean(item[k], 200);
    if (v) return v;
  }
  return null;
}

/**
 * 응답 항목 하나를 정규화한다.
 *
 * 유형별 차이(실측):
 *   건물명  aptNm / offiNm / mhouseNm / (sh 없음)
 *   면적    excluUseAr / (sh 는 totalFloorAr)
 *   지번    apt·offi·rh 만 있음
 *   도로명  apt 만 있음
 */
export function mapItem(item: Record<string, unknown>, slot: Slot): NormalizedDeal | null {
  const dealYm =
    buildDealYm(item['dealYear'], item['dealMonth']) ?? slot.dealYm;

  const deposit = parseManwon(item['deposit']);
  // 보증금이 없는 임대차 계약은 성립하지 않는다. 파싱 실패로 보고 버린다.
  if (deposit === null) return null;

  // 월세는 전세일 때 빈 값이거나 0 이다. null 을 0 으로 접는다.
  const monthlyRent = parseManwon(item['monthlyRent']) ?? 0;

  const name = pick(item, 'aptNm', 'offiNm', 'mhouseNm');
  const regionCode = pick(item, 'sggCd') ?? slot.regionCode;

  return {
    housingType: slot.housingType,
    regionCode,
    legalDong: pick(item, 'umdNm'),
    jibun: pick(item, 'jibun'),
    name,
    roadAddress: pick(item, 'roadnm'),
    aptSeq: pick(item, 'aptSeq'),
    builtYear: parseInt0(item['buildYear']),
    houseType: pick(item, 'houseType'),

    dealYm,
    dealDay: parseInt0(item['dealDay']),
    deposit,
    monthlyRent,
    area: parseArea(item['excluUseAr'] ?? item['totalFloorAr']),
    floor: parseInt0(item['floor']),
    contractType: pick(item, 'contractType'),
    contractTerm: pick(item, 'contractTerm'),
    renewalRight: pick(item, 'useRRRight'),

    // 매핑이 틀려도 나중에 무손실 재처리할 수 있도록 원본을 보존한다.
    raw: capRawPayload(item),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
