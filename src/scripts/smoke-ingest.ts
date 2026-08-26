import { closeDb, one, query } from '../lib/db.ts';
import { closeUnseen, ingest } from '../collectors/ingest.ts';
import type { NormalizedPosting } from '../collectors/types.ts';

/**
 * 적재 경로 스모크 테스트.
 *
 * 배치 적재는 SQL 이 실제로 돌아야 검증된다. 타입 검사로는
 * jsonb_to_recordset 컬럼 정의, 표현식 유니크 인덱스에 대한 ON CONFLICT,
 * 배치 내 중복 처리, 시계열 구간 연장이 맞는지 알 수 없다.
 *
 * source='__smoke__' 로만 쓰고 끝나면 전부 지운다. 실제 시계열을 오염시키지 않는다.
 */
const SOURCE = '__smoke__';
const CO_A = '__스모크테스트 주식회사__';
const CO_B = '__스모크테스트 (주)둘__';

let failures = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? '✓' : '✗'} ${label}${ok ? '' : `  기대=${expected} 실제=${actual}`}`);
  if (!ok) failures += 1;
}

function posting(id: string, over: Partial<NormalizedPosting> = {}): NormalizedPosting {
  return {
    source: SOURCE,
    sourceId: id,
    url: 'https://example.com/job/' + id,
    title: `테스트 공고 ${id}`,
    companyName: CO_A,
    rawAddress: '서울특별시 강남구 테헤란로 152',
    regionHint: '서울 강남구',
    jobCategory: '소프트웨어 개발',
    jobCode: '024',
    employmentType: '정규직',
    careerType: '신입',
    careerMinYear: 0,
    education: '대졸(4년)이상',
    salaryType: '연봉',
    salaryMin: 40_000_000,
    salaryMax: null,
    workHours: '주5일근무',
    postedOn: '2026-08-01',
    closesOn: '2026-09-30',
    raw: { probe: id, nested: { 'quote"and,comma': "back\\slash 'single'" } },
    ...over,
  };
}

async function cleanup(): Promise<void> {
  await query(`DELETE FROM posting WHERE source = $1`, [SOURCE]);
  await query(
    `DELETE FROM worksite WHERE company_id IN (SELECT id FROM company WHERE name = ANY($1::text[]))`,
    [[CO_A, CO_B]],
  );
  await query(`DELETE FROM company WHERE name = ANY($1::text[])`, [[CO_A, CO_B]]);
}

async function main(): Promise<void> {
  console.log('스모크 테스트 시작 (source=%s)\n', SOURCE);
  await cleanup(); // 이전 실패 잔여물 제거

  // ── 1일차: 신규 3건. 같은 회사/주소가 중복으로 들어오는 상황을 포함한다.
  //    배치 내 중복 제거가 안 되면 ON CONFLICT DO UPDATE 가 여기서 터진다.
  const day1 = [
    posting('A1'),
    posting('A2'),
    posting('B1', { companyName: CO_B, rawAddress: '부산광역시 해운대구 센텀중앙로 97' }),
  ];

  const r1 = await ingest(day1, '2026-08-20');
  check('1일차 관측 건수', r1.seen, 3);
  check('1일차 신규', r1.created, 3);
  check('1일차 갱신', r1.updated, 0);
  check('1일차 변경이력', r1.changed, 0);
  check('1일차 실패', r1.skipped, 0);

  const co = await one<{ n: string }>(
    `SELECT count(*) AS n FROM company WHERE name = ANY($1::text[])`,
    [[CO_A, CO_B]],
  );
  check('회사 2건으로 수렴 (중복 제거)', Number(co?.n), 2);

  const ws = await one<{ n: string }>(
    `SELECT count(*) AS n FROM worksite
      WHERE company_id IN (SELECT id FROM company WHERE name = ANY($1::text[]))`,
    [[CO_A, CO_B]],
  );
  check('근무지 2건으로 수렴 (같은 회사+주소는 1건)', Number(ws?.n), 2);

  // raw jsonb 가 특수문자를 포함해도 온전히 저장되는지 (JSON 경유 적재의 핵심 검증)
  const raw = await one<{ probe: string; nested: string }>(
    `SELECT raw->>'probe' AS probe, raw->'nested'->>'quote"and,comma' AS nested
       FROM posting WHERE source = $1 AND source_id = 'A1'`,
    [SOURCE],
  );
  check('raw jsonb 보존 (probe)', raw?.probe, 'A1');
  check('raw jsonb 보존 (특수문자 키/값)', raw?.nested, "back\\slash 'single'");

  const seen1 = await one<{ first: string; last: string }>(
    `SELECT first_seen_on::text AS first, last_seen_on::text AS last
       FROM posting WHERE source = $1 AND source_id = 'A1'`,
    [SOURCE],
  );
  check('1일차 구간 시작', seen1?.first, '2026-08-20');
  check('1일차 구간 종료', seen1?.last, '2026-08-20');

  // ── 2일차: A1 은 연봉 인상 + 마감 연장, A2 는 그대로, B1 은 사라짐.
  const day2 = [
    posting('A1', { salaryMin: 45_000_000, closesOn: '2026-10-31' }),
    posting('A2'),
  ];

  const r2 = await ingest(day2, '2026-08-21');
  check('2일차 신규', r2.created, 0);
  check('2일차 갱신', r2.updated, 2);
  check('2일차 변경이력 (연봉+마감 2건)', r2.changed, 2);

  const seen2 = await one<{ first: string; last: string; sal: number }>(
    `SELECT first_seen_on::text AS first, last_seen_on::text AS last, salary_min AS sal
       FROM posting WHERE source = $1 AND source_id = 'A1'`,
    [SOURCE],
  );
  check('구간 시작은 유지', seen2?.first, '2026-08-20');
  check('구간 종료는 연장', seen2?.last, '2026-08-21');
  check('연봉 갱신', Number(seen2?.sal), 45_000_000);

  const fields = await query<{ field: string; old_value: string; new_value: string }>(
    `SELECT field, old_value, new_value FROM posting_change pc
       JOIN posting p ON p.id = pc.posting_id
      WHERE p.source = $1 ORDER BY field`,
    [SOURCE],
  );
  check('변경 필드 목록', fields.map((f) => f.field), ['closes_on', 'salary_min']);
  check('변경 전후 값', `${fields[1]?.old_value}->${fields[1]?.new_value}`, '40000000->45000000');

  // ── 마감 처리: 이번 실행에서 관측되지 않은 B1 만 닫혀야 한다.
  const closed = await closeUnseen(SOURCE, '2026-08-21');
  check('마감 처리 건수', closed, 1);

  const stillOpen = await query<{ source_id: string }>(
    `SELECT source_id FROM posting WHERE source = $1 AND is_open ORDER BY source_id`,
    [SOURCE],
  );
  check('열려 있는 공고', stillOpen.map((r) => r.source_id), ['A1', 'A2']);

  // ── 일별 활성 공고 수가 구간에서 복원되는지 (알터너티브 데이터의 근간)
  const daily = await query<{ day: string; n: string }>(
    `SELECT d.day::date::text AS day, count(*) AS n
       FROM generate_series('2026-08-20'::date, '2026-08-21'::date, interval '1 day') AS d(day)
       JOIN posting p ON p.first_seen_on <= d.day::date AND p.last_seen_on >= d.day::date
      WHERE p.source = $1
      GROUP BY d.day ORDER BY d.day`,
    [SOURCE],
  );
  check('일별 활성 공고 수 복원', daily.map((r) => `${r.day}:${r.n}`), ['2026-08-20:3', '2026-08-21:2']);

  // ── 이상값 격리: 배치 하나가 실패해도 정상 행은 살아야 한다.
  const bad = posting('BAD', { title: 'x'.repeat(10) });
  (bad as { sourceId: string }).sourceId = 'BAD';
  const r3 = await ingest([bad, posting('A3')], '2026-08-21');
  check('이상값 포함 배치도 적재됨', r3.seen, 2);

  await cleanup();

  const left = await one<{ n: string }>(`SELECT count(*) AS n FROM posting WHERE source = $1`, [SOURCE]);
  check('정리 완료', Number(left?.n), 0);

  console.log('');
  if (failures > 0) {
    console.error(`${failures}개 항목 실패`);
    process.exitCode = 1;
  } else {
    console.log('모든 항목 통과');
  }
}

main()
  .catch(async (e) => {
    console.error('스모크 테스트 실패:', e);
    await cleanup().catch(() => {});
    process.exitCode = 1;
  })
  .finally(closeDb);
