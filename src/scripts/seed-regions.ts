import { XMLParser } from 'fast-xml-parser';
import { closeDb, query } from '../lib/db';
import { env } from '../lib/env';
import { safeFetch, stripDangerousKeys } from '../lib/security';
import { clean } from '../lib/text';

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

/**
 * 광역시도 목록.
 *
 * 주의: **광주광역시와 전라남도는 '전남광주통합특별시' 로 통합되었다.** 구 명칭으로
 * 조회하면 데이터가 없다고 응답한다(INFO-3). 실측으로 확인했으며, 통합 시도에
 * 광주 5개 구 + 전남 22개 시군 = 27건이 들어 있다.
 *
 * 행정구역은 앞으로도 바뀔 수 있으므로 nameAliases() 로 부분 일치 폴백을 둔다.
 */
const SIDO = [
  '서울특별시', '부산광역시', '대구광역시', '인천광역시', '전남광주통합특별시',
  '대전광역시', '울산광역시', '세종특별자치시', '경기도', '강원특별자치도',
  '충청북도', '충청남도', '전북특별자치도', '경상북도',
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

const PAGE_SIZE = 1000;

interface Page {
  rows: Record<string, unknown>[];
  totalCount: number;
}

/**
 * 한 페이지를 가져온다.
 *
 * 이 API 는 리·동 단위까지 전부 반환한다. 시군구 레벨 행은 그 안에 흩어져 있어서
 * 첫 페이지만 읽으면 리가 많은 도(경북·전남 등)의 뒤쪽 시군구가 통째로 누락된다.
 * 그래서 totalCount 를 보고 끝까지 페이징해야 한다.
 */
async function fetchPage(path: string, sido: string | null, pageNo: number): Promise<Page> {
  const url = new URL(`https://${HOST}${path}`);
  // 이 API 는 파라미터명이 ServiceKey(대문자 S)다. serviceKey 로 보내면 인증 실패한다.
  url.searchParams.set('ServiceKey', env.molitKey);
  url.searchParams.set('pageNo', String(pageNo));
  url.searchParams.set('numOfRows', String(PAGE_SIZE));
  url.searchParams.set('type', 'xml');
  if (sido) url.searchParams.set('locatadd_nm', sido);

  const res = await safeFetch(url, {
    allowHosts: [HOST],
    maxRedirects: 0,
    maxBytes: 32 * 1024 * 1024,
    timeoutMs: 40_000,
  });
  // 403 = 경로는 맞지만 이 API 에 대한 활용신청이 없는 상태.
  // 400/404 = 경로 자체가 틀림. 이 구분이 원인 판별을 빠르게 한다.
  if (res.status === 403) throw new Error('HTTP 403 (경로는 유효, 활용신청 필요)');
  if (res.status !== 200) throw new Error(`HTTP ${res.status} (경로 불일치로 추정)`);

  const parsed = stripDangerousKeys(parser.parse(res.text)) as Record<string, any>;
  const root = parsed.StanReginCd ?? parsed.response ?? parsed;

  // head 는 두 개의 <head> 로 오는 경우가 있어 배열이 된다(카운트용 / RESULT용).
  const heads: any[] = root?.head ? (Array.isArray(root.head) ? root.head : [root.head]) : [];
  const totalCount = Number(heads.map((h) => h?.totalCount).find((v) => v != null) ?? 0);
  const resultCode = heads.map((h) => h?.RESULT?.resultCode).find((v) => v != null);

  const rows = root?.row;
  if (!rows) {
    // INFO-3 = 데이터 없음. 조회 범위를 벗어난 페이지에서도 나오므로 정상 종료로 취급한다.
    if (String(resultCode ?? '').includes('INFO-3') || String(res.text).includes('INFO-3')) {
      return { rows: [], totalCount };
    }
    const msg =
      resultCode ??
      parsed?.OpenAPI_ServiceResponse?.cmmMsgHeader?.errMsg ??
      parsed?.response?.header?.resultMsg;
    throw new Error(msg ? String(msg) : `응답 형식을 해석할 수 없습니다: ${res.text.slice(0, 200)}`);
  }

  return { rows: Array.isArray(rows) ? rows : [rows], totalCount };
}

/**
 * 지역명 검색 후보를 만든다.
 *
 * 실측: `locatadd_nm=광주광역시` 와 `전라남도` 는 데이터를 반환하지 않는다(INFO-3).
 * 다른 15개 시도는 정상이라 API 쪽 문제로 보인다. 접미사를 떼거나 앞 두 글자로
 * 부분 일치를 시도하면 잡힌다. 다른 시도 행이 섞여 들어와도 코드로 중복 제거되고
 * 시도명은 locatadd_nm 에서 다시 읽으므로 해가 없다.
 */
function nameAliases(sido: string): string[] {
  const stripped = sido.replace(/(특별자치시|특별자치도|특별시|광역시|도)$/, '');
  return [...new Set([sido, stripped, sido.slice(0, 2)])].filter((s) => s.length >= 2);
}

/** 한 시도(또는 전체)를 끝까지 페이징해 모든 행을 모은다. */
async function fetchAll(path: string, sido: string | null): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  let pageNo = 1;
  let total = 0;

  while (true) {
    const page = await retry(() => fetchPage(path, sido, pageNo));
    if (pageNo === 1) total = page.totalCount;
    if (page.rows.length === 0) break;

    out.push(...page.rows);
    if (out.length >= total && total > 0) break;
    if (page.rows.length < PAGE_SIZE) break;

    pageNo += 1;
    if (pageNo > 200) break; // 폭주 방지
    await sleep(150); // 공공 API 예절
  }
  return out;
}

/** 일시적 오류(INFO-3 오탐, 타임아웃)를 흡수한다. */
async function retry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      // 활용신청 문제는 재시도해도 소용없다. 즉시 던진다.
      if (String(e).includes('403')) throw e;
      await sleep(800 * (i + 1));
    }
  }
  throw last;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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
      // 경로 유효성만 1페이지로 확인한다. 본 수집은 아래에서 페이징으로 한다.
      const probe = await fetchPage(path, SIDO[0]!, 1);
      if (probe.rows.length > 0) {
        workingPath = path;
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

  const failed: string[] = [];

  for (const sido of SIDO) {
    let done = false;
    for (const alias of nameAliases(sido)) {
      try {
        const items = await fetchAll(workingPath, alias);
        const rows = toSigunguRows(items);
        if (rows.length === 0) continue; // 다음 별칭으로 재시도
        for (const r of rows) all.set(r.code, r);
        const via = alias === sido ? '' : `  (별칭 '${alias}')`;
        console.log(
          `  ${sido.padEnd(10)} 전체 ${String(items.length).padStart(6)}행 → 시군구 ${rows.length}건${via}`,
        );
        done = true;
        break;
      } catch (e) {
        if (String(e).includes('403')) throw e;
        console.error(`  ! ${sido} (${alias}) 실패: ${String(e).slice(0, 100)}`);
      }
    }
    if (!done) {
      failed.push(sido);
      console.error(`  ! ${sido}: 모든 별칭 실패`);
    }
    await sleep(200); // 공공 API 예절
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
  const total = Number(count?.n ?? 0);
  console.log('');
  console.log(`법정동코드(시군구) ${rows.length}건 적재. 테이블 총 ${total}건.`);

  // 전국 시군구는 일반구를 포함해 약 250건이다. 크게 모자라면 페이징이
  // 끝까지 돌지 않았거나 일부 시도가 실패한 것이므로 조용히 넘기지 않는다.
  if (failed.length) {
    console.error(`  ! 실패한 시도: ${failed.join(', ')} — 다시 실행하면 이어서 채워집니다`);
    process.exitCode = 1;
  }
  if (total < 200) {
    console.error(`  ! 전국 시군구는 약 250건이어야 합니다. ${total}건은 누락이 있는 상태입니다.`);
    process.exitCode = 1;
  }

  const bySido = await query<{ sido: string; n: string }>(
    `SELECT sido, count(*) AS n FROM region_code GROUP BY sido ORDER BY sido`,
  );
  console.log('');
  console.log('── 시도별 ──────────────────────────────────');
  for (const r of bySido) console.log(`  ${r.sido.padEnd(12)} ${r.n}`);
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
