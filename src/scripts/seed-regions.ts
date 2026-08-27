import { XMLParser } from 'fast-xml-parser';
import { closeDb, query } from '../lib/db.ts';
import { env } from '../lib/env.ts';
import { safeFetch, stripDangerousKeys } from '../lib/security.ts';
import { clean } from '../lib/text.ts';

/**
 * 법정동코드(시군구) 마스터 적재.
 *
 * 실거래가 API 는 `LAWD_CD`(법정동코드 앞 5자리) 단위로만 조회된다. 즉 이 목록이
 * 없으면 전국을 훑을 수 없다. 게다가 apt/rh/sh 응답에는 시군구**명**이 없고
 * `sggCd` 만 오므로, 주소를 조립해 지오코딩하려면 코드->이름 매핑이 필요하다.
 *
 * 출처: 행정안전부_행정표준코드_법정동코드 (공공데이터포털 15077871).
 * 공공데이터포털은 계정당 키 1개를 공용으로 쓰므로 MOLIT_API_KEY 를 그대로 쓴다.
 *
 * 이 API 는 벌크 덤프가 아니라 지역명 검색형이다. 시도 17개를 각각 조회해
 * 시군구 레벨(읍면동코드=000, 리코드=00)만 추린다.
 */
const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false, trimValues: true });

const HOST = 'apis.data.go.kr';
/** 행정안전부 기관코드. 후보를 순회해 동작하는 경로를 찾는다. */
const CANDIDATE_PATHS = [
  '/1741000/StanReginCd/getStanReginCdList',
  '/1741000/StanReginCd5/getStanReginCdList',
];

/** 광역시도 17개. 이 목록은 고정이며 자주 바뀌지 않는다. */
const SIDO = [
  '서울특별시', '부산광역시', '대구광역시', '인천광역시', '광주광역시',
  '대전광역시', '울산광역시', '세종특별자치시', '경기도', '강원특별자치도',
  '충청북도', '충청남도', '전북특별자치도', '전라남도', '경상북도',
  '경상남도', '제주특별자치도',
];

interface RegionRow {
  code: string;   // 법정동코드 앞 5자리
  sido: string;
  sigungu: string;
}

/** 후보 키를 순회해 첫 유효값을 반환한다. 공공 API 필드명 편차를 흡수한다. */
function pick(item: Record<string, unknown>, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = clean(item[k], 200);
    if (v) return v;
  }
  return null;
}

async function fetchSido(path: string, sido: string): Promise<Record<string, unknown>[]> {
  const url = new URL(`https://${HOST}${path}`);
  // 이 API 는 파라미터명이 ServiceKey(대문자 S)다. serviceKey 로 보내면 인증 실패한다.
  url.searchParams.set('ServiceKey', env.molitKey);
  url.searchParams.set('pageNo', '1');
  url.searchParams.set('numOfRows', '1000');
  url.searchParams.set('type', 'xml');
  url.searchParams.set('locatadd_nm', sido);

  const res = await safeFetch(url, {
    allowHosts: [HOST],
    maxRedirects: 0,
    maxBytes: 16 * 1024 * 1024,
    timeoutMs: 30_000,
  });
  // 403 = 경로는 맞지만 이 API 에 대한 활용신청이 없는 상태.
  // 400/404 = 경로 자체가 틀림. 이 구분이 원인 판별을 빠르게 한다.
  if (res.status === 403) throw new Error('HTTP 403 (경로는 유효, 활용신청 필요)');
  if (res.status !== 200) throw new Error(`HTTP ${res.status} (경로 불일치로 추정)`);

  const parsed = stripDangerousKeys(parser.parse(res.text)) as Record<string, any>;

  // 정상 응답은 StanReginCd > row[], 오류는 다른 루트로 온다.
  const root = parsed.StanReginCd ?? parsed.response ?? parsed;
  const rows = root?.row;
  if (!rows) {
    const msg =
      root?.head?.RESULT?.resultMsg ??
      parsed?.OpenAPI_ServiceResponse?.cmmMsgHeader?.errMsg ??
      parsed?.response?.header?.resultMsg;
    throw new Error(msg ? String(msg) : `응답 형식을 해석할 수 없습니다: ${res.text.slice(0, 200)}`);
  }
  return Array.isArray(rows) ? rows : [rows];
}

/** 시군구 레벨만 추린다. 읍면동코드가 000, 리코드가 00 인 행이 시군구다. */
function toSigunguRows(items: Record<string, unknown>[]): RegionRow[] {
  const out = new Map<string, RegionRow>();

  for (const item of items) {
    const regionCd = pick(item, 'region_cd', 'regionCd');
    const umdCd = pick(item, 'umd_cd', 'umdCd');
    const riCd = pick(item, 'ri_cd', 'riCd');
    const addr = pick(item, 'locatadd_nm', 'locataddNm');
    if (!regionCd || regionCd.length < 5 || !addr) continue;

    // 시도 자체(시군구코드 000)는 제외한다.
    const sggCd = regionCd.slice(2, 5);
    if (sggCd === '000') continue;
    if (umdCd && umdCd !== '000') continue;
    if (riCd && riCd !== '00') continue;

    const code = regionCd.slice(0, 5);
    // locatadd_nm 은 '서울특별시 종로구' 형태. 세종처럼 시군구가 없는 곳도 있다.
    const parts = addr.split(/\s+/);
    const sido = parts[0] ?? addr;
    const sigungu = parts.slice(1).join(' ') || sido;

    if (!out.has(code)) out.set(code, { code, sido, sigungu });
  }

  return [...out.values()];
}

async function main(): Promise<void> {
  let workingPath: string | null = null;
  const all = new Map<string, RegionRow>();

  for (const path of CANDIDATE_PATHS) {
    try {
      // 첫 시도로 경로 유효성을 확인한다.
      const probe = await fetchSido(path, SIDO[0]!);
      if (probe.length > 0) {
        workingPath = path;
        for (const r of toSigunguRows(probe)) all.set(r.code, r);
        console.log(`엔드포인트 확인: ${path}`);
        break;
      }
    } catch (e) {
      console.log(`  ✗ ${path}: ${String(e).slice(0, 140)}`);
    }
  }

  if (!workingPath) {
    console.error('');
    console.error('법정동코드를 받지 못했습니다.');
    console.error('');
    console.error('위에 403(경로는 유효, 활용신청 필요)이 보이면 신청만 하면 됩니다:');
    console.error('  https://www.data.go.kr/data/15077871/openapi.do');
    console.error('  "행정안전부_행정표준코드_법정동코드" -> 활용신청 (자동승인)');
    console.error('  공공데이터포털은 계정당 키 1개를 공용으로 쓰므로 새 키는 필요 없습니다.');
    console.error('  승인 반영에 최대 1시간 걸릴 수 있습니다.');
    process.exitCode = 1;
    return;
  }

  for (const sido of SIDO.slice(1)) {
    try {
      const items = await fetchSido(workingPath, sido);
      const rows = toSigunguRows(items);
      for (const r of rows) all.set(r.code, r);
      console.log(`  ${sido.padEnd(10)} 시군구 ${rows.length}건`);
    } catch (e) {
      console.error(`  ! ${sido} 실패: ${String(e).slice(0, 120)}`);
    }
    await new Promise((r) => setTimeout(r, 200)); // 공공 API 예절
  }

  const rows = [...all.values()];
  if (rows.length === 0) {
    console.error('시군구를 하나도 얻지 못했습니다.');
    process.exitCode = 1;
    return;
  }

  await query(
    `INSERT INTO region_code (code, sido, sigungu)
     SELECT code, sido, sigungu
       FROM jsonb_to_recordset($1::jsonb) AS x(code text, sido text, sigungu text)
     ON CONFLICT (code) DO UPDATE SET sido = EXCLUDED.sido, sigungu = EXCLUDED.sigungu`,
    [JSON.stringify(rows)],
  );

  const [count] = await query<{ n: string }>(`SELECT count(*) AS n FROM region_code`);
  console.log('');
  console.log(`법정동코드(시군구) ${rows.length}건 적재. 테이블 총 ${count?.n}건.`);
  console.log('');
  console.log('수집 1회전 예상 호출 수:');
  const n = Number(count?.n ?? 0);
  console.log(`  월 1개월 x 주택 4종 = ${n * 4}회`);
  console.log(`  최근 3개월 갱신     = ${n * 4 * 3}회 (일 한도 10,000)`);
  console.log(`  1년 백필            = ${n * 4 * 12}회 (약 ${Math.ceil((n * 4 * 12) / 10000)}일)`);
}

main()
  .catch((e) => {
    console.error('법정동코드 적재 실패:', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(closeDb);
