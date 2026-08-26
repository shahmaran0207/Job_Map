import { capRawPayload, safeExternalUrl, safeFetch, stripDangerousKeys } from '../lib/security.ts';
import { clean, parseCareerYears, parseDate, parseSalary } from '../lib/text.ts';
import type { Collector, CollectorResult, NormalizedPosting } from './types.ts';
import { XMLParser } from 'fast-xml-parser';
import { env } from '../lib/env.ts';

/**
 * 채용정보 API 엔드포인트가 두 갈래로 갈려 있다.
 *
 * 1) work24 — 고용24 개편 후의 신규 포털 (openapi.work.go.kr 에서 이전됨).
 *    인증키가 UUID(36자)다. 단, **채용정보 API 는 기업·기관회원 전용**이라
 *    개인회원 키로 호출하면 "개인회원은 사용할 수 없는 OPEN-API입니다" 가 온다.
 *
 * 2) legacy — 구 워크넷 엔드포인트. 공공데이터포털(data.go.kr)에서 발급한
 *    서비스키로 호출한다. 개인도 자동승인으로 받을 수 있다.
 *    라이선스가 KOGL 제4유형(비상업적 이용만 가능)이므로 상업적 활용은 불가하다.
 *
 * 어느 쪽 키를 가졌는지에 따라 엔드포인트가 달라지므로 환경변수로 고른다.
 * `npm run keys:check` 가 양쪽을 모두 시도해 어느 것이 동작하는지 알려준다.
 */
export type WorknetFlavor = 'work24' | 'legacy';

interface Endpoint {
  host: string;
  listUrl: string;
}

const ENDPOINTS: Record<WorknetFlavor, Endpoint> = {
  // 210L01 = 채용정보 목록, 210D01 = 채용정보 상세
  work24: {
    host: 'www.work24.go.kr',
    listUrl: 'https://www.work24.go.kr/cm/openApi/call/wk/callOpenApiSvcInfo210L01.do',
  },
  legacy: {
    host: 'openapi.work.go.kr',
    listUrl: 'https://openapi.work.go.kr/opi/opi/opia/wantedApi.do',
  },
};

export const WORKNET_FLAVORS = Object.keys(ENDPOINTS) as WorknetFlavor[];

export function endpointOf(flavor: WorknetFlavor): Endpoint {
  return ENDPOINTS[flavor];
}

const PAGE_SIZE = 100; // API 상한
const MAX_PAGE_BYTES = 8 * 1024 * 1024;

/** 알려진 엔드포인트 호스트만 허용한다. 설정 오류로 임의 호스트에 키를 보내는 것을 막는다. */
export function assertKnownHost(hostname: string): string {
  const known = WORKNET_FLAVORS.some((f) => ENDPOINTS[f].host === hostname);
  if (!known) throw new Error(`알려지지 않은 워크넷 API 호스트입니다: ${hostname}`);
  return hostname;
}

/** 목록 조회 URL. 검사 스크립트와 수집기가 같은 코드를 쓰도록 export 한다. */
export function buildListUrl(
  page: number,
  display = PAGE_SIZE,
  flavor: WorknetFlavor = env.worknetFlavor,
): URL {
  const url = new URL(ENDPOINTS[flavor].listUrl);
  url.searchParams.set('authKey', env.worknetKey);
  url.searchParams.set('callTp', 'L');
  url.searchParams.set('returnType', 'XML');
  url.searchParams.set('startPage', String(page));
  url.searchParams.set('display', String(display));
  return url;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: false, // 값을 숫자/불리언으로 자동 변환하지 않는다 (타입 혼동 방지)
  trimValues: true,
  // 태그명을 그대로 객체 키로 쓰므로 프로토타입 오염 위험이 있다.
  // 파싱 직후 stripDangerousKeys 로 위험 키를 잘라낸다.
});

/**
 * 고용24(워크넷) 채용정보 오픈API.
 * 공식 무료 API 이므로 약관 리스크가 없고, 전국·전직군을 커버한다. 이 프로젝트의 기반 소스.
 *
 * 주의: 필드명이 문서와 실제 응답에서 미묘하게 다른 경우가 있어 후보 키를 순회하며 찾는다.
 * 매핑이 틀려도 raw 에 원본이 전량 남으므로 나중에 무손실로 재처리할 수 있다.
 */
export const worknetCollector: Collector = {
  source: 'worknet',

  async collect({ maxPages }): Promise<CollectorResult> {
    const postings: NormalizedPosting[] = [];
    const seen = new Set<string>();
    let page = 1;
    let complete = false;

    while (true) {
      if (maxPages > 0 && page > maxPages) break;

      const items = await fetchPage(page);
      if (items.length === 0) {
        complete = true; // 빈 페이지 = 끝까지 읽음
        break;
      }

      for (const item of items) {
        const p = mapItem(item);
        if (p && !seen.has(p.sourceId)) {
          seen.add(p.sourceId);
          postings.push(p);
        }
      }

      if (items.length < PAGE_SIZE) {
        complete = true;
        break;
      }
      page += 1;
      await sleep(250); // 공공 API 예절
    }

    return { postings, pagesRead: page - 1, complete };
  },
};

async function fetchPage(page: number): Promise<Record<string, unknown>[]> {
  const url = buildListUrl(page);
  const xml = await fetchWithRetry(url);
  return parseListXml(xml);
}

/**
 * 목록 응답 XML 을 항목 배열로 변환한다.
 *
 * 네트워크와 분리해 export 한다. XML 파서 라이브러리의 동작 변화(메이저
 * 업그레이드 등)는 API 키 없이도 픽스처로 검증할 수 있어야 한다.
 * 이 파싱이 조용히 깨지면 수집이 0건이 되고 시계열에 결측이 생긴다.
 */
export function parseListXml(xml: string): Record<string, unknown>[] {
  // 외부 XML -> 객체 변환 직후 위험 키를 제거한다. 이 결과는 재귀 순회되고 jsonb 로 저장된다.
  const parsed = stripDangerousKeys(parser.parse(xml)) as Record<string, any>;

  const root =
    parsed.wantedRoot ?? parsed.WantedRoot ?? parsed.GO24 ?? parsed.response ?? parsed;
  const err = clean(root?.error ?? root?.errorMsg ?? root?.message);
  if (err && !root?.wanted) throw new Error(`워크넷 API 오류: ${err}`);

  const wanted = root?.wanted;
  if (!wanted) return [];
  return Array.isArray(wanted) ? wanted : [wanted];
}

/** 항목 하나를 정규화한다. 픽스처 테스트에서 매핑을 검증하기 위해 export 한다. */
export function mapListItem(item: Record<string, unknown>): NormalizedPosting | null {
  return mapItem(item);
}

async function fetchWithRetry(url: URL, attempts = 4): Promise<string> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await safeFetch(url, {
        // 호스트 고정 = DNS rebinding 무관. URL 에서 호스트를 뽑되,
        // 알려진 엔드포인트 목록에 없으면 요청하지 않는다.
        allowHosts: [assertKnownHost(url.hostname)],
        maxBytes: MAX_PAGE_BYTES,
        maxRedirects: 0,
        timeoutMs: 30_000,
      });
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      return res.text;
    } catch (e) {
      lastErr = e;
      await sleep(1000 * 2 ** i); // 지수 백오프
    }
  }
  // url.pathname 만 노출한다. 쿼리스트링에 authKey 가 들어 있으므로 전체 URL 을 찍지 않는다.
  throw new Error(`요청 실패 ${url.pathname}: ${String(lastErr)}`);
}

/** 후보 키를 순서대로 훑어 첫 유효값을 반환. 공공 API 필드명 편차를 흡수한다. */
function pick(item: Record<string, unknown>, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = clean(item[k]);
    if (v) return v;
  }
  return null;
}

/** 객체 전체를 재귀 탐색해 키 이름이 정규식에 걸리는 첫 값을 찾는다. 주소 필드 탐색용. */
function deepFind(obj: unknown, keyPattern: RegExp, depth = 0): string | null {
  if (depth > 5 || obj === null || typeof obj !== 'object') return null;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (keyPattern.test(k)) {
      const s = clean(v);
      if (s) return s;
    }
  }
  for (const v of Object.values(obj as Record<string, unknown>)) {
    const found = deepFind(v, keyPattern, depth + 1);
    if (found) return found;
  }
  return null;
}

function mapItem(item: Record<string, unknown>): NormalizedPosting | null {
  const sourceId = pick(item, 'wantedAuthNo', 'wantedMgstNo', 'empSeqno', 'jobId');
  const title = pick(item, 'title', 'wantedTitle', 'empWantedTitle');
  const companyName = pick(item, 'company', 'coNm', 'empBusiNm', 'companyName');
  if (!sourceId || !title || !companyName) return null;

  const region = pick(item, 'region', 'workRegionNm', 'basicAddr', 'workPlcNm');
  const addr = deepFind(item, /addr/i);

  const salRaw = pick(item, 'sal', 'salary', 'salTp');
  const careerRaw = pick(item, 'career', 'careerCd', 'careerNm');

  return {
    source: 'worknet',
    sourceId,
    // http/https 만 통과시킨다. javascript:/data: 스킴이 <a href> 로 렌더되면 XSS 다.
    url: safeExternalUrl(pick(item, 'wantedInfoUrl', 'infoSvc', 'url')),
    title,
    companyName,
    rawAddress: addr ?? region,
    regionHint: region,
    jobCategory: pick(item, 'jobsNm', 'jobsCdNm', 'occupation'),
    jobCode: pick(item, 'jobsCd', 'jobCd'),
    employmentType: pick(item, 'empTpNm', 'empTpCdNm', 'empTp'),
    careerType: careerRaw,
    careerMinYear: parseCareerYears(careerRaw),
    education: pick(item, 'minEdubg', 'minEdubgNm', 'education'),
    salaryType: pick(item, 'salTpNm', 'salTp'),
    salaryMin: parseSalary(salRaw),
    salaryMax: null, // 리스트 API 는 단일 급여값만 준다. 상세 수집 단계에서 보강.
    workHours: pick(item, 'holidayTpNm', 'workTime'),
    postedOn: parseDate(pick(item, 'regDt', 'regDate', 'wantedStartDt')),
    closesOn: parseDate(pick(item, 'closeDt', 'closeDate', 'wantedEndDt')),
    // jsonb 컬럼이 거대 payload 로 부풀지 않도록 상한을 건다.
    raw: capRawPayload(item),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
