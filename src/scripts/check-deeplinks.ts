import { closeDb, query } from '../lib/db';
import { HOUSING_LABEL, type HousingType } from '../collectors/molit-types';
import { buildListingLinks, buildSearchQuery } from '../lib/listing-links';

/**
 * 매물 딥링크 확인.
 *
 * 부동산 사이트 URL 형식은 프로그램으로 검증할 수 없다(해당 도메인 fetch 차단).
 * 그래서 실제 데이터로 URL 을 만들어 출력하고, **사람이 클릭해서** 확인한다.
 * 30초면 끝나고, 틀린 게 있으면 `src/lib/listing-links.ts` 의 빌더 한 줄만 고치면 된다.
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

  console.log('실제 데이터로 만든 매물 검색 링크입니다.');
  console.log('각 URL 을 브라우저에서 열어 정상 동작하는지 확인하세요.');
  console.log('틀리면 src/lib/listing-links.ts 의 BUILDERS 만 고치면 됩니다.');
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
      console.log(`   ${link.label.padEnd(8)} ${link.url}`);
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
