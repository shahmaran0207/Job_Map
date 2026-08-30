import { closeDb, query } from '../lib/db';
import { geocode } from '../lib/geocode';
import { parseRegion } from '../lib/place-resolver';
import { HOUSING_LABEL, type HousingType } from '../collectors/molit-types';

/**
 * 좌표 해결 실패 진단.
 *
 * 통근 계산이 안 되는 건물이 왜 그런지 표본으로 확인한다. 단독/다가구는
 * 구조적 한계(정부가 지번을 안 준다)라 예상된 것이지만, 도로명·지번이 있는데도
 * 중심점으로 떨어진 건물은 개선 여지가 있다. 그 차이를 눈으로 봐야 다음 수를
 * 정할 수 있다.
 */
async function main(): Promise<void> {
  const [summary] = await query<{
    total: string; with_dong: string; with_jibun: string; with_road: string;
  }>(
    `SELECT count(*) AS total,
            count(*) FILTER (WHERE legal_dong IS NOT NULL)   AS with_dong,
            count(*) FILTER (WHERE jibun IS NOT NULL)        AS with_jibun,
            count(*) FILTER (WHERE road_address IS NOT NULL) AS with_road
       FROM building
      WHERE geo_strategy = 'region_centroid' AND housing_type <> 'sh'`,
  );

  console.log('── 시군구 중심점으로 떨어진 건물 (단독다가구 제외) ──');
  console.log(`총 ${Number(summary?.total ?? 0).toLocaleString('ko-KR')}건`);
  console.log(`  법정동 보유 ${summary?.with_dong}  지번 보유 ${summary?.with_jibun}  도로명 보유 ${summary?.with_road}`);
  console.log('');
  console.log('법정동이 있는데 시군구 중심점으로 떨어진 건물은 법정동 중심점으로');
  console.log('끌어올릴 수 있다. 시군구는 반경 약 3km, 법정동은 약 1km 다.');

  const rows = await query<{
    housing_type: HousingType; sido: string; sigungu: string;
    legal_dong: string | null; jibun: string | null; name: string | null;
    road_address: string | null; geo_query: string | null; deals: string;
  }>(
    `SELECT b.housing_type, r.sido, r.sigungu, b.legal_dong, b.jibun, b.name,
            b.road_address, b.geo_query, count(d.id) AS deals
       FROM building b
       JOIN region_code r ON r.code = b.region_code
       LEFT JOIN rent_deal d ON d.building_id = b.id
      WHERE b.geo_strategy = 'region_centroid' AND b.housing_type <> 'sh'
      GROUP BY b.id, b.housing_type, r.sido, r.sigungu, b.legal_dong, b.jibun,
               b.name, b.road_address, b.geo_query
      ORDER BY count(d.id) DESC
      LIMIT 15`,
  );

  console.log('');
  console.log('── 거래 많은 순 표본 ──────────────────────');
  for (const r of rows) {
    console.log(
      `[${HOUSING_LABEL[r.housing_type]}] ${r.sido} ${r.sigungu} ${r.legal_dong ?? '-'} ${r.jibun ?? '-'}`,
    );
    console.log(
      `    이름=${r.name ?? '-'}  도로명=${r.road_address ?? '-'}  거래 ${r.deals}건`,
    );
    console.log(`    실제 질의="${r.geo_query ?? '-'}"`);
  }

  // 시도별 분포. 특정 지역에 몰려 있으면 그 지역 주소 체계 문제일 수 있다.
  const bySido = await query<{ sido: string; n: string }>(
    `SELECT r.sido, count(*) AS n
       FROM building b JOIN region_code r ON r.code = b.region_code
      WHERE b.geo_strategy = 'region_centroid' AND b.housing_type <> 'sh'
      GROUP BY r.sido ORDER BY count(*) DESC LIMIT 10`,
  );
  console.log('');
  console.log('── 시도별 분포 ────────────────────────────');
  for (const r of bySido) console.log(`  ${r.sido.padEnd(12)} ${r.n}`);

  // --live: 실제로 Kakao 에 물어봐 어느 질의가 왜 실패하는지 확인한다.
  // 캐시된 결과를 보므로 쿼터를 거의 쓰지 않는다.
  if (!process.argv.includes('--live')) {
    console.log('');
    console.log('실제 질의 결과를 확인하려면: npm run inspect:geocode -- --live');
    return;
  }

  console.log('');
  console.log('── 라이브 재질의 (상위 5건) ────────────────');
  for (const r of rows.slice(0, 5)) {
    const region = `${r.sido} ${r.sigungu}`;
    const parsed = parseRegion(`${region} ${r.road_address ?? ''}`.trim());
    const candidates = [
      r.road_address ? `${region} ${r.road_address}` : null,
      r.legal_dong && r.jibun ? `${region} ${r.legal_dong} ${r.jibun}` : null,
      r.name ? `${r.name} ${region}` : null,
      r.legal_dong ? `${region} ${r.legal_dong}` : null,
    ].filter((s): s is string => !!s);

    console.log('');
    console.log(`${r.name ?? '(무명)'} — ${region} ${r.legal_dong ?? ''}`);
    console.log(`  parseRegion → sido=${parsed.sido} sigungu=${parsed.sigungu}`);
    for (const q of candidates) {
      const hit = await geocode(q);
      if (!hit) {
        console.log(`  ✗ "${q}" → 결과 없음`);
      } else {
        console.log(
          `  ✓ "${q}" → ${hit.address ?? '-'} [${hit.precision}] ` +
            `(반환지역: ${hit.sido} ${hit.sigungu})`,
        );
      }
    }
  }
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(closeDb);
