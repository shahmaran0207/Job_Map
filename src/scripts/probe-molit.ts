import { XMLParser } from 'fast-xml-parser';
import { env } from '../lib/env.ts';
import { safeFetch, stripDangerousKeys } from '../lib/security.ts';

/**
 * 국토부 실거래가 API 엔드포인트·필드 탐색기.
 *
 * 공공데이터포털은 엔드포인트 URL 을 Swagger 안에만 두고 문서 페이지에
 * 노출하지 않는다. 워크넷에서 엔드포인트를 추측하다 시간을 버렸으므로,
 * 이번에는 후보를 자동으로 훑어 동작하는 것을 찾아낸다.
 *
 * 동시에 **실제 응답 필드명을 덤프**한다. 주택 유형별로 필드명이 다르기
 * 때문이다(아파트는 보증금액/월세금액, 오피스텔은 보증금/월세). 이 출력을 보고
 * 수집기 매핑을 확정한다.
 */
const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false, trimValues: true });

/** 국토교통부 기관코드 */
const ORG = '1613000';
const HOST = 'apis.data.go.kr';

interface Service {
  /** 주택 유형 */
  kind: 'apt' | 'offi' | 'rh' | 'sh';
  label: string;
  /** 후보 서비스 경로. 첫 번째로 성공한 것을 채택한다. */
  candidates: string[];
}

const SERVICES: Service[] = [
  {
    kind: 'apt',
    label: '아파트 전월세',
    candidates: [
      `/${ORG}/RTMSDataSvcAptRent/getRTMSDataSvcAptRent`,
      `/${ORG}/RTMSDataSvcAptRent/getRTMSDataSvcAptRentDev`,
    ],
  },
  {
    kind: 'offi',
    label: '오피스텔 전월세',
    candidates: [
      `/${ORG}/RTMSDataSvcOffiRent/getRTMSDataSvcOffiRent`,
      `/${ORG}/RTMSDataSvcOffiRent/getRTMSDataSvcOffiRentDev`,
    ],
  },
  {
    kind: 'rh',
    label: '연립다세대 전월세',
    candidates: [
      `/${ORG}/RTMSDataSvcRHRent/getRTMSDataSvcRHRent`,
      `/${ORG}/RTMSDataSvcRHRent/getRTMSDataSvcRHRentDev`,
    ],
  },
  {
    kind: 'sh',
    label: '단독다가구 전월세',
    candidates: [
      `/${ORG}/RTMSDataSvcSHRent/getRTMSDataSvcSHRent`,
      `/${ORG}/RTMSDataSvcSHRent/getRTMSDataSvcSHRentDev`,
    ],
  },
];

/** 서울 강남구. 거래량이 많아 응답이 비어 있을 위험이 적다. */
const PROBE_LAWD_CD = '11680';

/** 최근 완료된 달을 쓴다. 당월은 신고가 아직 안 쌓여 비어 있을 수 있다. */
function probeYearMonth(): string {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth() - 2, 1);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
}

async function probe(path: string, ym: string): Promise<'ok' | 'fail'> {
  const url = new URL(`https://${HOST}${path}`);
  url.searchParams.set('serviceKey', env.molitKey);
  url.searchParams.set('LAWD_CD', PROBE_LAWD_CD);
  url.searchParams.set('DEAL_YMD', ym);
  url.searchParams.set('numOfRows', '5');
  url.searchParams.set('pageNo', '1');

  try {
    const res = await safeFetch(url, {
      allowHosts: [HOST],
      maxRedirects: 0,
      maxBytes: 4 * 1024 * 1024,
      timeoutMs: 25_000,
    });

    if (res.status !== 200) {
      console.log(`    ✗ HTTP ${res.status}  ${path}`);
      return 'fail';
    }

    const parsed = stripDangerousKeys(parser.parse(res.text)) as Record<string, any>;
    const header = parsed?.response?.header;
    const items = parsed?.response?.body?.items?.item;

    // 공공데이터포털은 오류도 HTTP 200 으로 준다. resultCode 를 봐야 한다.
    const code = header?.resultCode ?? parsed?.OpenAPI_ServiceResponse?.cmmMsgHeader?.returnReasonCode;
    const msg = header?.resultMsg ?? parsed?.OpenAPI_ServiceResponse?.cmmMsgHeader?.errMsg;

    if (!items) {
      console.log(`    ✗ ${path}`);
      console.log(`      resultCode=${code ?? '?'} ${msg ?? ''}`.trimEnd());
      if (!code) console.log(`      응답: ${res.text.replace(/\s+/g, ' ').slice(0, 180)}`);
      return 'fail';
    }

    const list = Array.isArray(items) ? items : [items];
    console.log(`    ✓ ${path}`);
    console.log(`      ${list.length}건 수신 (전체 ${parsed?.response?.body?.totalCount ?? '?'}건)`);

    const first = list[0] as Record<string, unknown>;
    console.log(`      필드: ${Object.keys(first).join(', ')}`);

    // 값의 실제 형태를 봐야 한다. 특히 금액 단위(원 vs 만원)와 쉼표 포함 여부는
    // 틀리면 시세가 1만배 어긋나면서도 예외가 나지 않는 종류의 오류다.
    for (const item of list.slice(0, 2)) {
      const rec = item as Record<string, unknown>;
      const sample = Object.entries(rec)
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(' ');
      console.log(`      표본: ${sample}`);
    }
    return 'ok';
  } catch (e) {
    console.log(`    ✗ ${path}  요청 실패: ${String(e).slice(0, 120)}`);
    return 'fail';
  }
}

async function main(): Promise<void> {
  const key = env.molitKey;
  const ym = probeYearMonth();
  console.log(`인증키 ${key.slice(0, 8)}… (${key.length}자)`);
  console.log(`조회 조건: 지역 ${PROBE_LAWD_CD}(서울 강남구), 계약년월 ${ym}\n`);

  const working: string[] = [];

  for (const svc of SERVICES) {
    console.log(`[${svc.kind}] ${svc.label}`);
    let found = false;
    for (const path of svc.candidates) {
      if (await probe(path, ym) === 'ok') {
        working.push(`${svc.kind}: ${path}`);
        found = true;
        break;
      }
    }
    if (!found) console.log('    -> 동작하는 후보 없음');
    console.log('');
  }

  console.log('── 결과 ────────────────────────────────────');
  if (working.length === 0) {
    console.log('동작하는 엔드포인트가 없습니다. 확인 사항:');
    console.log('  - MOLIT_API_KEY 가 공공데이터포털 "일반 인증키(Decoding)" 인지');
    console.log('    (Encoding 키를 넣으면 이중 인코딩되어 인증이 실패합니다)');
    console.log('  - 해당 데이터셋 활용신청이 승인되었는지 (자동승인이지만 반영에 최대 1시간)');
    console.log('  - resultCode 30=등록되지 않은 키, 22=트래픽 초과, 20=서비스 접근 거부');
    process.exitCode = 1;
    return;
  }
  for (const w of working) console.log(`  ${w}`);
  console.log('');
  console.log('위 필드 목록으로 수집기 매핑을 확정합니다.');
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
