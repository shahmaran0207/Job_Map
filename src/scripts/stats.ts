import { closeDb, query } from '../lib/db.ts';

/** 데이터 자산 상태 점검. 특히 결측일 탐지는 시계열 상품의 신뢰도와 직결된다. */
async function main(): Promise<void> {
  const [totals] = await query<{
    postings: string; open: string; companies: string; worksites: string; geocoded: string;
  }>(
    `SELECT (SELECT count(*) FROM posting)                              AS postings,
            (SELECT count(*) FROM posting WHERE is_open)                AS open,
            (SELECT count(*) FROM company)                              AS companies,
            (SELECT count(*) FROM worksite)                             AS worksites,
            (SELECT count(*) FROM worksite WHERE geom IS NOT NULL)      AS geocoded`,
  );

  const ws = Number(totals?.worksites ?? 0);
  const gc = Number(totals?.geocoded ?? 0);
  console.log('── 데이터 규모 ──────────────────────────────');
  console.log(`공고        ${totals?.postings} (열림 ${totals?.open})`);
  console.log(`회사        ${totals?.companies}`);
  console.log(`근무지      ${ws} (좌표 확보 ${gc}, ${ws ? ((gc / ws) * 100).toFixed(1) : '0.0'}%)`);

  const precision = await query<{ geo_precision: string | null; n: string }>(
    `SELECT geo_precision, count(*) AS n FROM worksite
      WHERE geom IS NOT NULL GROUP BY geo_precision ORDER BY count(*) DESC`,
  );
  if (precision.length) {
    console.log('\n── 좌표 정밀도 ─────────────────────────────');
    for (const r of precision) console.log(`${(r.geo_precision ?? 'unknown').padEnd(10)} ${r.n}`);
  }

  console.log('\n── 최근 수집 실행 ───────────────────────────');
  const runs = await query<{
    run_date: string; source: string; status: string; seen_count: number;
    new_count: number; closed_count: number; error: string | null;
  }>(
    `SELECT run_date::text, source, status, seen_count, new_count, closed_count, error
       FROM collect_run ORDER BY started_at DESC LIMIT 10`,
  );
  for (const r of runs) {
    const flag = r.status === 'ok' ? '  ' : '!!';
    console.log(
      `${flag} ${r.run_date} ${r.source.padEnd(8)} ${r.status.padEnd(7)} ` +
        `관측 ${String(r.seen_count).padStart(6)} 신규 ${String(r.new_count).padStart(5)} ` +
        `마감 ${String(r.closed_count).padStart(5)}${r.error ? ` :: ${r.error.slice(0, 60)}` : ''}`,
    );
  }

  // 성공한 수집이 없는 날 = 시계열 구멍. 데이터 상품을 팔 때 반드시 고지해야 하는 항목.
  const gaps = await query<{ missing_day: string }>(
    `SELECT d.day::date::text AS missing_day
       FROM generate_series(
              (SELECT min(run_date) FROM collect_run), current_date, interval '1 day'
            ) AS d(day)
      WHERE NOT EXISTS (
              SELECT 1 FROM collect_run r
               WHERE r.run_date = d.day::date AND r.status IN ('ok','partial'))
      ORDER BY d.day DESC LIMIT 20`,
  );
  console.log('\n── 시계열 결측일 ────────────────────────────');
  console.log(gaps.length === 0 ? '없음' : gaps.map((g) => g.missing_day).join(', '));
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(closeDb);
