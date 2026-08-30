import { closeDb, query } from '../lib/db';
import { env } from '../lib/env';
import { GeocodeUnavailableError, geocode } from '../lib/geocode';
import { resolvePlace, type Resolution } from '../lib/place-resolver';
import { HOUSING_LABEL, type HousingType } from '../collectors/molit-types';

/**
 * 건물 좌표 확정 배치.
 *
 * 실거래가 API 는 좌표를 주지 않으므로 이 단계가 지도의 전제다. 유형별로 가진
 * 주소 정보가 다르고(실측 확인), 그에 따라 최선의 질의가 달라진다.
 *
 *   apt     도로명 100%  -> "{시도} {시군구} {도로명}"       건물 정밀도
 *   offi/rh 지번 100%    -> "{시도} {시군구} {법정동} {지번}" 건물 정밀도
 *   sh      법정동만     -> "{시도} {시군구} {법정동}"        법정동 중심점
 *
 * 수집과 분리한 이유는 Kakao 일일 쿼터에 수집이 발목 잡히면 시계열에 결측이
 * 생기기 때문이다. 수집은 절대 멈추지 않아야 한다.
 *
 * 거래가 많은 건물을 먼저 처리한다. 중간에 멈춰도 지도에서 실제로 보게 될
 * 건물이 먼저 채워진다.
 *
 * 사용법
 *   npm run geocode:buildings
 *   npm run geocode:buildings -- --improve          통근 계산 불가 건물만 재시도
 *   npm run geocode:buildings -- --limit=5000
 *   npm run geocode:buildings -- --concurrency=8
 */
interface Row {
  id: string;
  housing_type: HousingType;
  name: string | null;
  road_address: string | null;
  legal_dong: string | null;
  jibun: string | null;
  sido: string;
  sigungu: string;
  deals: string;
}

/**
 * 동시 실행 수.
 *
 * 순차로 돌리면 건당 왕복 200ms 로 7만 건에 4시간이 넘는다. Kakao Local API 는
 * 동시 호출을 허용하므로 병렬로 처리한다. 너무 높이면 429 가 나서 오히려
 * 느려지므로 보수적으로 잡는다.
 */
const DEFAULT_CONCURRENCY = 6;

/** 좌표 갱신을 모아서 한 번에 쓴다. 건당 UPDATE 면 7만 번의 왕복이 된다. */
const FLUSH_EVERY = 250;

function arg(name: string): string | null {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}

/** 유형별 최선의 주소 문자열. 없으면 null. */
function bestAddress(r: Row): string | null {
  const region = `${r.sido} ${r.sigungu}`;
  if (r.road_address) return `${region} ${r.road_address}`;
  if (r.legal_dong && r.jibun) return `${region} ${r.legal_dong} ${r.jibun}`;
  if (r.legal_dong) return `${region} ${r.legal_dong}`;
  return null;
}

/**
 * 단독/다가구 전용 경로.
 *
 * 지번·건물명이 없어 건물을 특정할 수 없다. 법정동 중심점으로 두고 통근 계산에서
 * 제외한다. 정밀도를 강제로 'dong' 으로 강등하는 이유는 Kakao 가 법정동 질의에
 * building 정밀도를 돌려주는 경우가 있어서다(주민센터 등). 그걸 믿으면 지도가
 * 조용히 거짓말을 한다.
 */
async function resolveDongCentroid(r: Row): Promise<Resolution | null> {
  const q = r.legal_dong ? `${r.sido} ${r.sigungu} ${r.legal_dong}` : `${r.sido} ${r.sigungu}`;
  const hit = await geocode(q);
  if (!hit) return null;
  return {
    lon: hit.lon,
    lat: hit.lat,
    address: hit.address,
    regionCode: hit.regionCode,
    sido: hit.sido,
    sigungu: hit.sigungu,
    precision: r.legal_dong ? ('dong' as Resolution['precision']) : 'sigungu',
    confidence: r.legal_dong ? 0.55 : 0.4,
    strategy: 'region_centroid',
    query: q,
    commuteUsable: false,
  };
}

function resolveOne(b: Row): Promise<Resolution | null> {
  if (b.housing_type === 'sh' || (!b.road_address && !b.jibun)) {
    return resolveDongCentroid(b);
  }
  return resolvePlace({
    name: b.name ?? b.legal_dong ?? b.sigungu,
    rawAddress: bestAddress(b),
    regionHint: `${b.sido} ${b.sigungu}`,
  });
}

interface Update {
  id: number;
  lon: number | null;
  lat: number | null;
  address: string | null;
  sido: string | null;
  sigungu: string | null;
  precision: string | null;
  confidence: number;
  strategy: string | null;
  geo_query: string | null;
  commute_usable: boolean;
}

/** 좌표 갱신 배치 적용. 실패(좌표 없음)도 기록해 다음 실행의 무한 재시도를 막는다. */
async function flush(batch: Update[]): Promise<void> {
  if (batch.length === 0) return;
  await query(
    `UPDATE building b
        SET geom = CASE WHEN x.lon IS NULL THEN b.geom
                        ELSE ST_SetSRID(ST_MakePoint(x.lon, x.lat), 4326)::geography END,
            address        = coalesce(x.address, b.address),
            sido           = coalesce(x.sido, b.sido),
            sigungu        = coalesce(x.sigungu, b.sigungu),
            geo_precision  = coalesce(x.precision, b.geo_precision),
            geo_confidence = x.confidence,
            geo_strategy   = coalesce(x.strategy, b.geo_strategy),
            geo_query      = coalesce(x.geo_query, b.geo_query),
            commute_usable = x.commute_usable,
            geo_resolved_at = now(),
            updated_at     = now()
       FROM jsonb_to_recordset($1::jsonb) AS x(
              id bigint, lon double precision, lat double precision,
              address text, sido text, sigungu text, precision text,
              confidence real, strategy text, geo_query text, commute_usable boolean
            )
      WHERE b.id = x.id`,
    [JSON.stringify(batch)],
  );
}

async function main(): Promise<void> {
  const limit = Number(arg('limit') ?? env.geocodeDailyLimit);
  const concurrency = Math.max(1, Math.min(12, Number(arg('concurrency') ?? DEFAULT_CONCURRENCY)));
  const improve = process.argv.includes('--improve');
  const where = improve ? 'NOT b.commute_usable' : 'b.geom IS NULL';

  const pending = await query<Row>(
    `SELECT b.id, b.housing_type, b.name, b.road_address, b.legal_dong, b.jibun,
            r.sido, r.sigungu, count(d.id) AS deals
       FROM building b
       JOIN region_code r ON r.code = b.region_code
       LEFT JOIN rent_deal d ON d.building_id = b.id
      WHERE ${where}
      GROUP BY b.id, b.housing_type, b.name, b.road_address, b.legal_dong, b.jibun,
               r.sido, r.sigungu
      ORDER BY count(d.id) DESC, b.id
      LIMIT $1`,
    [limit],
  );

  console.log(
    `대상 ${pending.length.toLocaleString('ko-KR')}건 ` +
      `(${improve ? '정밀도 개선' : '신규 해결'}, 동시 ${concurrency})`,
  );
  console.log('');

  const byStrategy = new Map<string, number>();
  const byType = new Map<string, { usable: number; total: number }>();
  let usable = 0;
  let miss = 0;
  let processed = 0;
  let aborted: string | null = null;

  let cursor = 0;
  let buffer: Update[] = [];
  // 배치 쓰기가 겹치지 않도록 직렬화한다. 워커가 동시에 flush 하면 중복 갱신이 된다.
  let flushChain: Promise<void> = Promise.resolve();
  const started = Date.now();

  const enqueue = (u: Update): void => {
    buffer.push(u);
    if (buffer.length >= FLUSH_EVERY) {
      const batch = buffer;
      buffer = [];
      flushChain = flushChain.then(() => flush(batch));
    }
  };

  async function worker(): Promise<void> {
    while (aborted === null) {
      const i = cursor++;
      if (i >= pending.length) return;
      const b = pending[i]!;

      let r: Resolution | null;
      try {
        r = await resolveOne(b);
      } catch (e) {
        // 쿼터 소진·네트워크 장애. 계속 돌리면 남은 건물이 전부 '실패'로 기록되고
        // 그 miss 가 캐시에 남아 되살릴 수 없다. 여기서 멈추는 것이 맞다.
        if (e instanceof GeocodeUnavailableError) {
          aborted = e.message;
          return;
        }
        throw e;
      }

      processed += 1;
      const t = byType.get(b.housing_type) ?? { usable: 0, total: 0 };
      t.total += 1;
      byType.set(b.housing_type, t);

      if (!r) {
        miss += 1;
        enqueue({
          id: Number(b.id), lon: null, lat: null, address: null, sido: null, sigungu: null,
          precision: null, confidence: 0, strategy: null, geo_query: null, commute_usable: false,
        });
      } else {
        byStrategy.set(r.strategy, (byStrategy.get(r.strategy) ?? 0) + 1);
        if (r.commuteUsable) {
          usable += 1;
          t.usable += 1;
        }
        enqueue({
          id: Number(b.id), lon: r.lon, lat: r.lat, address: r.address,
          sido: r.sido, sigungu: r.sigungu, precision: r.precision,
          confidence: r.confidence, strategy: r.strategy, geo_query: r.query,
          commute_usable: r.commuteUsable,
        });
      }

      if (processed % 2000 === 0) {
        const pct = ((processed / pending.length) * 100).toFixed(1);
        const rate = processed / ((Date.now() - started) / 1000);
        const etaMin = Math.round((pending.length - processed) / rate / 60);
        console.log(
          `  ${processed.toLocaleString('ko-KR')}/${pending.length.toLocaleString('ko-KR')} (${pct}%)  ` +
            `통근계산 가능 ${usable.toLocaleString('ko-KR')}  실패 ${miss}  ` +
            `${rate.toFixed(1)}건/초  남은 시간 약 ${etaMin}분`,
        );
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, worker));

  // 남은 버퍼까지 반영한다.
  const tail = buffer;
  buffer = [];
  flushChain = flushChain.then(() => flush(tail));
  await flushChain;

  if (aborted) {
    console.error('');
    console.error(`중단: ${aborted}`);
    console.error(`  ${processed.toLocaleString('ko-KR')}건 처리 후 멈췄습니다. 남은 건물은 손상되지 않았습니다.`);
    console.error('  쿼터가 회복되면 같은 명령으로 재실행하면 이어서 진행됩니다.');
  }

  console.log('');
  console.log('── 전략별 ──────────────────────────────────');
  for (const [s, n] of [...byStrategy].sort((a, b) => b[1] - a[1])) {
    console.log(`${s.padEnd(18)} ${n.toLocaleString('ko-KR')}`);
  }
  if (miss) console.log(`${'실패'.padEnd(18)} ${miss.toLocaleString('ko-KR')}`);

  console.log('');
  console.log('── 유형별 통근 계산 가능 비율 ───────────────');
  for (const [type, v] of byType) {
    const pct = v.total ? ((v.usable / v.total) * 100).toFixed(1) : '0.0';
    console.log(
      `${(HOUSING_LABEL[type as HousingType] ?? type).padEnd(6)} ` +
        `${v.usable.toLocaleString('ko-KR').padStart(7)}/${v.total.toLocaleString('ko-KR').padStart(7)} (${pct}%)`,
    );
  }

  if (processed > 0) {
    console.log('');
    console.log(
      `전체 통근시간 계산 가능: ${usable.toLocaleString('ko-KR')}/${processed.toLocaleString('ko-KR')} ` +
        `(${((usable / processed) * 100).toFixed(1)}%)`,
    );
    console.log('이 비율이 곧 지도의 신뢰도다.');
  }

  if (aborted) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error('건물 좌표 해결 실패:', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(closeDb);
