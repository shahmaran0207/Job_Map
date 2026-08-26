import { closeDb, one, query } from '../lib/db.ts';
import { closeUnseen, ingest } from './ingest.ts';
import { worknetCollector } from './worknet.ts';
import type { Collector } from './types.ts';
import { env, today } from '../lib/env.ts';

const COLLECTORS: Collector[] = [worknetCollector];

async function main(): Promise<void> {
  const wanted = process.argv.find((a) => a.startsWith('--source='))?.split('=')[1];
  const targets = wanted ? COLLECTORS.filter((c) => c.source === wanted) : COLLECTORS;
  if (targets.length === 0) throw new Error(`수집기를 찾을 수 없습니다: ${wanted}`);

  const runDate = today();
  let failed = false;

  for (const collector of targets) {
    const runId = await startRun(collector.source, runDate);
    console.log(`\n[${collector.source}] 수집 시작 (기준일 ${runDate}, run #${runId})`);

    try {
      const { postings, pagesRead, complete } = await collector.collect({
        maxPages: env.collectMaxPages,
      });
      console.log(`[${collector.source}] ${pagesRead}페이지에서 ${postings.length}건 관측 (완주: ${complete})`);

      const stats = await ingest(postings, runDate);
      console.log(
        `[${collector.source}] 신규 ${stats.created} / 갱신 ${stats.updated} / ` +
          `변경 ${stats.changed} / 실패 ${stats.skipped}`,
      );

      // 완주하지 못한 실행으로 마감 처리를 하면 시계열에 가짜 절벽이 생긴다.
      let closed = 0;
      if (complete) {
        closed = await closeUnseen(collector.source, runDate);
        console.log(`[${collector.source}] 마감 처리 ${closed}건`);
      } else {
        console.warn(`[${collector.source}] 미완주 - 마감 처리를 건너뜁니다 (시계열 보호)`);
      }

      await finishRun(runId, complete ? 'ok' : 'partial', {
        pagesRead,
        seen: stats.seen,
        created: stats.created,
        closed,
      });
    } catch (e) {
      failed = true;
      console.error(`[${collector.source}] 실패:`, e);
      await finishRun(runId, 'failed', {}, String(e));
    }
  }

  if (failed) process.exitCode = 1;
}

async function startRun(source: string, runDate: string): Promise<number> {
  const row = await one<{ id: number }>(
    `INSERT INTO collect_run (source, run_date) VALUES ($1, $2) RETURNING id`,
    [source, runDate],
  );
  return row!.id;
}

async function finishRun(
  id: number,
  status: 'ok' | 'partial' | 'failed',
  counts: { pagesRead?: number; seen?: number; created?: number; closed?: number },
  error?: string,
): Promise<void> {
  await query(
    `UPDATE collect_run
        SET finished_at = now(), status = $2, pages_read = $3,
            seen_count = $4, new_count = $5, closed_count = $6, error = $7
      WHERE id = $1`,
    [id, status, counts.pagesRead ?? 0, counts.seen ?? 0, counts.created ?? 0, counts.closed ?? 0, error ?? null],
  );
}

main()
  .catch((e) => {
    console.error('수집 실행 실패:', e);
    process.exitCode = 1;
  })
  .finally(closeDb);
