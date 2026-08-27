import { closeDb } from '../lib/db.ts';
import { looksDetailed, parseRegion, resolveWorksite } from '../lib/worksite-resolver.ts';

/**
 * 근무지 좌표 해결기 검증.
 *
 * 순수 함수(지역 파싱, 상세주소 판별)는 픽스처로,
 * 해결 전략은 **실제 Kakao API** 로 검증한다. 이 부분은 실 호출 없이는 검증이
 * 의미가 없다. "시군구만 주어진 공고를 건물 단위로 끌어올릴 수 있는가" 가
 * 제품 성립 조건이므로, 실제로 되는지 눈으로 확인해야 한다.
 *
 * Kakao 쿼터를 조금 쓰고, 지오코딩 캐시에 행이 남는다(정상 동작이며 재사용된다).
 */
let failures = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : `  기대=${JSON.stringify(expected)} 실제=${JSON.stringify(actual)}`}`);
  if (!ok) failures += 1;
}

function testPureFunctions(): void {
  console.log('── 지역 표기 파싱 ───────────────────────────');
  // 사람인 표기
  check("'서울 > 관악구'", parseRegion('서울 > 관악구').full, '서울 관악구');
  // 워크넷 표기
  check("'서울 강남구'", parseRegion('서울 강남구').full, '서울 강남구');
  // 상세주소에서 시군구 추출
  check(
    "'서울특별시 강남구 테헤란로 152'",
    parseRegion('서울특별시 강남구 테헤란로 152').full,
    '서울특별시 강남구',
  );
  // 2단계 시군구 (도 소속 시의 구)
  check("'경기 성남시 분당구'", parseRegion('경기 성남시 분당구').full, '경기 성남시 분당구');
  check('시도만', parseRegion('세종특별자치시').full, '세종특별자치시');
  check('빈 값', parseRegion(null).full, null);

  console.log('');
  console.log('── 상세주소 판별 ────────────────────────────');
  check('도로명+번호', looksDetailed('서울특별시 강남구 테헤란로 152'), true);
  check('번지', looksDetailed('경기 성남시 분당구 삼평동 681-3'), true);
  check('시군구까지만', looksDetailed('서울 관악구'), false);
  check('사람인 표기', looksDetailed('서울 > 관악구'), false);
  check('빈 값', looksDetailed(null), false);
}

/** 실제 공고에서 흔한 입력 패턴들. 시군구만 주어진 경우가 핵심 검증 대상이다. */
const CASES: {
  label: string;
  companyName: string;
  rawAddress: string | null;
  expectStrategy?: string;
  expectCommuteUsable: boolean;
}[] = [
  {
    label: '상세주소가 있는 경우',
    companyName: '카카오',
    rawAddress: '경기도 성남시 분당구 판교역로 166',
    expectStrategy: 'address',
    expectCommuteUsable: true,
  },
  {
    label: '시군구만 (사람인 표기) — 대기업',
    companyName: '카카오',
    rawAddress: '경기 > 성남시 분당구',
    expectCommuteUsable: true,
  },
  {
    label: '시군구만 — 지사/공장',
    companyName: '삼성전자',
    rawAddress: '경기 > 수원시 영통구',
    expectCommuteUsable: true,
  },
  {
    label: '시군구만 — 서울 소재',
    companyName: '네이버',
    rawAddress: '경기 > 성남시 분당구',
    expectCommuteUsable: true,
  },
  {
    label: '존재하지 않는 회사 + 시군구 (중심점 폴백)',
    companyName: '없는회사이름테스트12345',
    rawAddress: '서울 > 관악구',
    expectStrategy: 'region_centroid',
    expectCommuteUsable: false,
  },
];

async function testResolution(): Promise<void> {
  console.log('');
  console.log('── 좌표 해결 (실제 Kakao API) ───────────────');

  for (const c of CASES) {
    const r = await resolveWorksite({
      companyName: c.companyName,
      rawAddress: c.rawAddress,
      regionHint: c.rawAddress,
    });

    if (!r) {
      console.log(`✗ ${c.label}: 해결 실패`);
      failures += 1;
      continue;
    }

    const ok = r.commuteUsable === c.expectCommuteUsable &&
      (!c.expectStrategy || r.strategy === c.expectStrategy);

    console.log(
      `${ok ? '✓' : '✗'} ${c.label}\n` +
        `    전략=${r.strategy} 정밀도=${r.precision} 신뢰도=${r.confidence} ` +
        `통근가능=${r.commuteUsable}\n` +
        `    질의="${r.query}"\n` +
        `    결과=${r.address ?? '(주소없음)'} (${r.lon.toFixed(5)}, ${r.lat.toFixed(5)})`,
    );
    if (!ok) {
      console.log(
        `    기대: 통근가능=${c.expectCommuteUsable}` +
          (c.expectStrategy ? ` 전략=${c.expectStrategy}` : ''),
      );
      failures += 1;
    }
  }
}

async function main(): Promise<void> {
  testPureFunctions();
  await testResolution();

  console.log('');
  if (failures > 0) {
    console.error(`${failures}개 항목 실패`);
    process.exitCode = 1;
  } else {
    console.log('모든 항목 통과');
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(closeDb);
