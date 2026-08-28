import { closeDb, query } from '../lib/db.ts';
import { HOUSING_LABEL, type HousingType } from '../collectors/molit-types.ts';

/**
 * 주거 데이터 현황 점검.
 *
 * 세 가지를 본다.
 *   1) 규모 — 건물·거래 수, 유형별 시세 (값이 현실적인지로 단위 오류를 잡는다)
 *   2) 주소 정보 보유율 — 좌표 확보 가능성의 상한
 *   3) 통근시간 계산 가능 비율 — 지도의 신뢰도
 */
function manwon(v: unknown): string {
  if (v === null || v === undefined) return '-';
  const n = Number(v);
  if (!Number.isFinite(n)) return '-';
  if (n >= 10_000) return `${(n / 10_000).toFixed(2)}억`;
  return `${Math.round(n).toLocaleString('ko-KR')}만`;
}

async function main(): Promise<void> {
  const [scale] = await query<{
    buildings: string; deals: string; regions: string; geocoded: string; usable: string;
    min_ym: string | null; max_ym: string | null;
  }>(
    `SELECT (SELECT count(*) FROM building)                             AS buildings,
            (SELECT count(*) FROM rent_deal)                            AS deals,
            (SELECT count(DISTINCT region_code) FROM building)          AS regions,
            (SELECT count(*) FROM building WHERE geom IS NOT NULL)      AS geocoded,
            (SELECT count(*) FROM building WHERE commute_usable)        AS usable,
            (SELECT min(deal_ym) FROM rent_deal)                        AS min_ym,
            (SELECT max(deal_ym) FROM rent_deal)                        AS max_ym`,
  );

  const buildings = Number(scale?.buildings ?? 0);
  console.log('── 규모 ─────────────────────────────────────');
  console.log(`건물        ${buildings.toLocaleString('ko-KR')}`);
  console.log(`거래        ${Number(scale?.deals ?? 0).toLocaleString('ko-KR')}`);
  console.log(`시군구      ${scale?.regions} / 269`);
  console.log(`기간        ${scale?.min_ym ?? '-'} ~ ${scale?.max_ym ?? '-'}`);
  console.log(
    `좌표 확보   ${Number(scale?.geocoded ?? 0).toLocaleString('ko-KR')}` +
      (buildings ? ` (${((Number(scale?.geocoded) / buildings) * 100).toFixed(1)}%)` : ''),
  );
  console.log(
    `통근 계산   ${Number(scale?.usable ?? 0).toLocaleString('ko-KR')}` +
      (buildings ? ` (건물 ${((Number(scale?.usable) / buildings) * 100).toFixed(1)}%)` : ''),
  );

  // 거래 가중 비율이 더 정직한 지표다. 단독/다가구는 건물 1개가 수십 건의 거래를
  // 대표하므로 건물 기준 비율은 실제 지도에 뜨는 데이터 품질을 과대평가한다.
  const [dw] = await query<{ total: string; usable: string }>(
    `SELECT count(*) AS total,
            count(*) FILTER (WHERE b.commute_usable) AS usable
       FROM rent_deal d JOIN building b ON b.id = d.building_id`,
  );
  const dwTotal = Number(dw?.total ?? 0);
  if (dwTotal > 0) {
    const pct = ((Number(dw?.usable) / dwTotal) * 100).toFixed(1);
    console.log(
      `            ${Number(dw?.usable).toLocaleString('ko-KR')} (거래 ${pct}%)  ← 지도의 신뢰도`,
    );
  }

  // 시세가 현실적인지로 단위 오류(만원 vs 원)를 잡는다.
  const byType = await query<{
    housing_type: HousingType; buildings: string; deals: string; jeonse: string;
    med_dep: string | null; med_rent: string | null; med_area: string | null;
  }>(
    `SELECT b.housing_type,
            count(DISTINCT b.id)                          AS buildings,
            count(d.id)                                   AS deals,
            count(*) FILTER (WHERE d.monthly_rent = 0)    AS jeonse,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY d.deposit / 10000)
              FILTER (WHERE d.monthly_rent > 0)           AS med_dep,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY d.monthly_rent / 10000)
              FILTER (WHERE d.monthly_rent > 0)           AS med_rent,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY d.area)  AS med_area
       FROM building b JOIN rent_deal d ON d.building_id = b.id
      GROUP BY b.housing_type ORDER BY count(d.id) DESC`,
  );

  if (byType.length) {
    console.log('');
    console.log('── 유형별 (월세 물건 중위값) ────────────────');
    for (const r of byType) {
      console.log(
        `${(HOUSING_LABEL[r.housing_type] ?? r.housing_type).padEnd(6)} ` +
          `건물 ${String(r.buildings).padStart(6)}  거래 ${String(r.deals).padStart(7)}  ` +
          `전세 ${String(r.jeonse).padStart(6)}  ` +
          `보증금 ${manwon(r.med_dep).padStart(8)}  월세 ${manwon(r.med_rent).padStart(7)}  ` +
          `${r.med_area ? Number(r.med_area).toFixed(1) : '-'}㎡`,
      );
    }
  }

  // 주소 정보가 없으면 좌표를 얻을 방법이 없다. 이 비율이 좌표 확보의 상한이다.
  const addr = await query<{
    housing_type: HousingType; n: string; has_road: string; has_jibun: string; has_name: string;
  }>(
    `SELECT housing_type, count(*) AS n,
            count(*) FILTER (WHERE road_address IS NOT NULL) AS has_road,
            count(*) FILTER (WHERE jibun IS NOT NULL)        AS has_jibun,
            count(*) FILTER (WHERE name IS NOT NULL)         AS has_name
       FROM building GROUP BY housing_type ORDER BY count(*) DESC`,
  );

  if (addr.length) {
    console.log('');
    console.log('── 주소 정보 보유율 (좌표 확보의 상한) ──────');
    for (const r of addr) {
      const n = Number(r.n);
      const pct = (v: string) => (n ? `${((Number(v) / n) * 100).toFixed(0)}%` : '-');
      console.log(
        `${(HOUSING_LABEL[r.housing_type] ?? r.housing_type).padEnd(6)} ` +
          `총 ${String(n).padStart(6)}  ` +
          `도로명 ${pct(r.has_road).padStart(4)}  지번 ${pct(r.has_jibun).padStart(4)}  건물명 ${pct(r.has_name).padStart(4)}`,
      );
    }
  }

  const quality = await query<{
    strategy: string; housing_type: string; precision: string;
    commute_usable: boolean; buildings: string; deals: string;
  }>(`SELECT * FROM building_quality`);

  if (quality.some((q) => q.strategy !== '(미해결)')) {
    console.log('');
    console.log('── 좌표 품질 (전략별) ───────────────────────');
    for (const r of quality) {
      console.log(
        `${r.commute_usable ? '통근O' : '통근X'} ${r.strategy.padEnd(16)} ` +
          `${(HOUSING_LABEL[r.housing_type as HousingType] ?? r.housing_type).padEnd(6)} ` +
          `${r.precision.padEnd(10)} 건물 ${String(r.buildings).padStart(6)} 거래 ${String(r.deals).padStart(7)}`,
      );
    }
  }

  // 수집 슬롯 진행 상황. 실패와 '진짜 0건'을 구별해서 본다.
  const runs = await query<{ status: string; n: string }>(
    `SELECT status, count(*) AS n FROM molit_run GROUP BY status ORDER BY count(*) DESC`,
  );
  if (runs.length) {
    console.log('');
    console.log('── 수집 슬롯 ────────────────────────────────');
    for (const r of runs) console.log(`${r.status.padEnd(10)} ${r.n}`);
  }
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(closeDb);
