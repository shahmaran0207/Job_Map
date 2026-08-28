import { closeDb, query } from '../lib/db';
import { env } from '../lib/env';
import { confidenceOf, geocode } from '../lib/geocode';
import { resolvePlace, type Resolution } from '../lib/place-resolver';
import { HOUSING_LABEL, type HousingType } from '../collectors/molit-types';

/**
 * 건물 좌표 확정 배치.
 *
 * 실거래가 API 는 좌표를 주지 않으므로 이 단계가 지도의 전제다. 유형별로 가진
 * 주소 정보가 다르고(실측 확인), 그에 따라 최선의 질의가 달라진다.
 *
 *   apt     도로명 100%  -> "{시도} {시군구} {도로명}"      건물 정밀도
 *   offi/rh 지번 100%    -> "{시도} {시군구} {법정동} {지번}" 건물 정밀도
 *   sh      법정동만     -> "{시도} {시군구} {법정동}"        법정동 중심점
 *
 * 수집과 분리한 이유는 Kakao 일일 쿼터에 수집이 발목 잡히면 시계열에 결측이
 * 생기기 때문이다. 수집은 절대 멈추지 않아야 한다.
 *
 * 거래가 많은 건물을 먼저 처리한다. 사용자가 실제로 볼 확률이 높은 순서다.
 *
 * 사용법
 *   npm run geocode:buildings
 *   npm run geocode:buildings -- --improve   통근 계산 불가 건물만 재시도
 *   npm run geocode:buildings -- --limit=500
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
  const q = r.legal_dong
    ? `${r.sido} ${r.sigungu} ${r.legal_dong}`
    : `${r.sido} ${r.sigungu}`;
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

async function main(): Promise<void> {
  const limit = Number(arg('limit') ?? env.geocodeDailyLimit);
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

  console.log(`대상 ${pending.length}건 (${improve ? '정밀도 개선' : '신규 해결'})`);
  console.log('');

  const byStrategy = new Map<string, number>();
  const byType = new Map<string, { usable: number; total: number }>();
  let usable = 0;
  let miss = 0;

  for (const [i, b] of pending.entries()) {
    const address = bestAddress(b);

    // 단독/다가구는 건물 특정이 불가능하므로 별도 경로로 보낸다.
    const r =
      b.housing_type === 'sh' || (!b.road_address && !b.jibun)
        ? await resolveDongCentroid(b)
        : await resolvePlace({
            name: b.name ?? b.legal_dong ?? b.sigungu,
            rawAddress: address,
            regionHint: `${b.sido} ${b.sigungu}`,
          });

    const t = byType.get(b.housing_type) ?? { usable: 0, total: 0 };
    t.total += 1;

    if (!r) {
      miss += 1;
      byType.set(b.housing_type, t);
      // 실패를 기록해 다음 실행에서 무한 재시도하지 않도록 한다.
      await query(
        `UPDATE building
            SET geo_confidence = 0, commute_usable = false,
                geo_resolved_at = now(), updated_at = now()
          WHERE id = $1`,
        [b.id],
      );
      continue;
    }

    await query(
      `UPDATE building
          SET geom = ST_SetSRID(ST_MakePoint($2,$3),4326)::geography,
              address = coalesce($4, address),
              sido = coalesce($5, sido),
              sigungu = coalesce($6, sigungu),
              geo_precision = $7,
              geo_confidence = $8,
              geo_strategy = $9,
              geo_query = $10,
              commute_usable = $11,
              geo_resolved_at = now(),
              updated_at = now()
        WHERE id = $1`,
      [
        b.id, r.lon, r.lat, r.address, r.sido, r.sigungu,
        r.precision, r.confidence, r.strategy, r.query, r.commuteUsable,
      ],
    );

    byStrategy.set(r.strategy, (byStrategy.get(r.strategy) ?? 0) + 1);
    if (r.commuteUsable) {
      usable += 1;
      t.usable += 1;
    }
    byType.set(b.housing_type, t);

    if ((i + 1) % 200 === 0) {
      console.log(`  ${i + 1}/${pending.length} (통근계산 가능 ${usable}, 실패 ${miss})`);
    }
  }

  console.log('');
  console.log('── 전략별 ──────────────────────────────────');
  for (const [s, n] of [...byStrategy].sort((a, b) => b[1] - a[1])) {
    console.log(`${s.padEnd(18)} ${n}`);
  }
  if (miss) console.log(`${'실패'.padEnd(18)} ${miss}`);

  console.log('');
  console.log('── 유형별 통근 계산 가능 비율 ───────────────');
  for (const [type, v] of byType) {
    const pct = v.total ? ((v.usable / v.total) * 100).toFixed(1) : '0.0';
    console.log(
      `${(HOUSING_LABEL[type as HousingType] ?? type).padEnd(6)} ` +
        `${String(v.usable).padStart(5)}/${String(v.total).padStart(5)} (${pct}%)`,
    );
  }

  const total = pending.length;
  if (total > 0) {
    console.log('');
    console.log(`전체 통근시간 계산 가능: ${usable}/${total} (${((usable / total) * 100).toFixed(1)}%)`);
    console.log('이 비율이 곧 지도의 신뢰도다.');
  }
}

main()
  .catch((e) => {
    console.error('건물 좌표 해결 실패:', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(closeDb);
