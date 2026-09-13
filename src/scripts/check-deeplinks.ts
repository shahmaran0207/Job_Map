import { closeDb, query } from '../lib/db';
import { HOUSING_LABEL, type HousingType } from '../collectors/molit-types';
import { buildListingLinks, buildSearchQuery } from '../lib/listing-links';

/**
 * 매물 딥링크 확인.
 *
 * 검색어 자동 적용 URL은 3사(네이버·직방·다방) 다 없어져서(2026-09-13 실측),
 * 지금은 "검색어 복사 + 홈 링크"로 동작한다. 이 스크립트는 실제 데이터로
 * 검색어와 홈 URL을 출력한다 — 홈 URL은 항상 유효하니 검증 대상이 아니고,
 * 검색어가 건물명/지역명을 정확히 뽑는지가 확인 포인트다.
 *
 * 유형별로 하나씩 뽑는 이유: 유형마다 이름 유무와 노출 서비스가 다르다.
 * 특히 단독다가구(이름 없음)와 연립다세대(이름이 지번 숫자인 경우)가 문제되기 쉽다.
 */
interface Row {
  housing_type: HousingType;
  name: string | null;
  sido: string | null;
  sigungu: string | null;
  legal_dong: string | null;
  deals: string;
}

async function main(): Promise<void> {
  const rows = await query<Row>(
    `SELECT DISTINCT ON (b.housing_type)
            b.housing_type, b.name, r.sido, r.sigungu, b.legal_dong,
            count(d.id) OVER (PARTITION BY b.id) AS deals
       FROM building b
       JOIN region_code r ON r.code = b.region_code
       LEFT JOIN rent_deal d ON d.building_id = b.id
      WHERE b.geom IS NOT NULL
      ORDER BY b.housing_type, count(d.id) OVER (PARTITION BY b.id) DESC`,
  );

  if (rows.length === 0) {
    console.log('건물 데이터가 없습니다. npm run collect:rent 를 먼저 실행하세요.');
    return;
  }

  console.log('실제 데이터로 만든 검색어 + 홈 링크입니다.');
  console.log('검색어가 건물명/지역명을 정확히 뽑는지만 확인하면 됩니다(홈 URL은 항상 유효).');
  console.log('');

  for (const r of rows) {
    const input = {
      name: r.name,
      sido: r.sido,
      sigungu: r.sigungu,
      legalDong: r.legal_dong,
      housingType: r.housing_type,
      mode: 'wolse' as const,
    };

    console.log(`── ${HOUSING_LABEL[r.housing_type]} ─────────────────────`);
    console.log(`   건물: ${r.name ?? '(이름 없음)'} / ${r.sigungu ?? '-'} ${r.legal_dong ?? '-'}`);
    console.log(`   검색어: "${buildSearchQuery(input)}"`);
    for (const link of buildListingLinks(input)) {
      console.log(`   ${link.label.padEnd(8)} ${link.homeUrl}`);
    }
    console.log('');
  }

  // 이름이 지번 숫자인 경우(실측 확인)가 제대로 걸러지는지 함께 보여준다.
  console.log('── 예외 처리 확인 ──────────────────────────');
  const edge = {
    name: '1213',
    sido: '서울특별시',
    sigungu: '강남구',
    legalDong: '개포동',
    housingType: 'rh' as HousingType,
    mode: 'wolse' as const,
  };
  console.log(`   이름이 지번 숫자("1213") → 검색어: "${buildSearchQuery(edge)}"`);
  console.log('   (숫자 이름은 버리고 지역명으로 떨어져야 정상)');
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(closeDb);
