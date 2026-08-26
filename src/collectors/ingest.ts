import { normalizeCompanyName } from '../lib/text.ts';
import type { NormalizedPosting } from './types.ts';
import { one, query } from '../lib/db.ts';

/** 변경 감지 대상 필드. 전량을 매일 쌓지 않고 이 필드가 바뀐 순간만 기록한다. */
const TRACKED = ['title', 'salary_min', 'salary_max', 'closes_on', 'education', 'career_type'] as const;

export interface IngestStats {
  seen: number;
  created: number;
  updated: number;
  changed: number;
  skipped: number;
}

export async function ingest(postings: NormalizedPosting[], runDate: string): Promise<IngestStats> {
  const stats: IngestStats = { seen: 0, created: 0, updated: 0, changed: 0, skipped: 0 };

  for (const p of postings) {
    try {
      const companyId = await upsertCompany(p.companyName);
      const worksiteId = await upsertWorksite(companyId, p.rawAddress, p.regionHint);
      const result = await upsertPosting(p, companyId, worksiteId, runDate);
      stats.seen += 1;
      if (result.created) stats.created += 1;
      else stats.updated += 1;
      stats.changed += result.changes;
    } catch (e) {
      stats.skipped += 1;
      console.error(`  ! 적재 실패 ${p.source}/${p.sourceId}: ${String(e)}`);
    }
  }
  return stats;
}

async function upsertCompany(name: string): Promise<number> {
  const norm = normalizeCompanyName(name);
  const row = await one<{ id: number }>(
    `INSERT INTO company (name, name_norm) VALUES ($1, $2)
       ON CONFLICT (name_norm) DO UPDATE SET updated_at = now()
     RETURNING id`,
    [name, norm || name],
  );
  return row!.id;
}

/**
 * 근무지 행을 만든다. 좌표는 여기서 찍지 않는다.
 * 지오코딩은 Kakao 일일 쿼터에 묶여 있어 수집 루프를 막으면 안 되므로
 * geocode-pending 스크립트가 별도로 배치 처리한다.
 */
async function upsertWorksite(
  companyId: number,
  rawAddress: string | null,
  regionHint: string | null,
): Promise<number | null> {
  const addr = rawAddress ?? regionHint;
  if (!addr) return null;

  const row = await one<{ id: number }>(
    `INSERT INTO worksite (company_id, raw_address)
     VALUES ($1, $2)
       ON CONFLICT (company_id, coalesce(raw_address, '')) DO UPDATE SET updated_at = now()
     RETURNING id`,
    [companyId, addr],
  );
  return row!.id;
}

async function upsertPosting(
  p: NormalizedPosting,
  companyId: number,
  worksiteId: number | null,
  runDate: string,
): Promise<{ created: boolean; changes: number }> {
  const existing = await one<Record<string, any>>(
    `SELECT id, title, salary_min, salary_max, closes_on, education, career_type
       FROM posting WHERE source = $1 AND source_id = $2`,
    [p.source, p.sourceId],
  );

  const params = [
    p.source, p.sourceId, p.url, p.title, companyId, worksiteId,
    p.jobCategory, p.jobCode, p.employmentType, p.careerType, p.careerMinYear,
    p.education, p.salaryType, p.salaryMin, p.salaryMax, p.workHours,
    p.postedOn, p.closesOn, runDate, JSON.stringify(p.raw),
  ];

  const row = await one<{ id: number }>(
    `INSERT INTO posting (
       source, source_id, url, title, company_id, worksite_id,
       job_category, job_code, employment_type, career_type, career_min_year,
       education, salary_type, salary_min, salary_max, work_hours,
       posted_on, closes_on, first_seen_on, last_seen_on, is_open, raw
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$19,true,$20)
     ON CONFLICT (source, source_id) DO UPDATE SET
       url = EXCLUDED.url, title = EXCLUDED.title,
       company_id = EXCLUDED.company_id, worksite_id = EXCLUDED.worksite_id,
       job_category = EXCLUDED.job_category, job_code = EXCLUDED.job_code,
       employment_type = EXCLUDED.employment_type, career_type = EXCLUDED.career_type,
       career_min_year = EXCLUDED.career_min_year, education = EXCLUDED.education,
       salary_type = EXCLUDED.salary_type, salary_min = EXCLUDED.salary_min,
       salary_max = EXCLUDED.salary_max, work_hours = EXCLUDED.work_hours,
       closes_on = EXCLUDED.closes_on,
       last_seen_on = EXCLUDED.last_seen_on,   -- 시계열 구간을 연장한다
       is_open = true,
       raw = EXCLUDED.raw,
       updated_at = now()
     RETURNING id`,
    params,
  );

  const postingId = row!.id;
  if (!existing) return { created: true, changes: 0 };

  const next: Record<string, unknown> = {
    title: p.title, salary_min: p.salaryMin, salary_max: p.salaryMax,
    closes_on: p.closesOn, education: p.education, career_type: p.careerType,
  };

  let changes = 0;
  for (const field of TRACKED) {
    const before = normalizeForCompare(existing[field]);
    const after = normalizeForCompare(next[field]);
    if (before !== after) {
      await query(
        `INSERT INTO posting_change (posting_id, observed_on, field, old_value, new_value)
         VALUES ($1,$2,$3,$4,$5)`,
        [postingId, runDate, field, before, after],
      );
      changes += 1;
    }
  }
  return { created: false, changes };
}

function normalizeForCompare(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v).trim();
  return s.length ? s : null;
}

/**
 * 이번 실행에서 관측되지 않은 공고를 마감 처리한다.
 *
 * complete === false 일 때는 절대 호출하면 안 된다. 수집이 중간에 끊긴 것을
 * "공고 대량 마감"으로 기록하면 시계열에 가짜 절벽이 생기고, 그게 이 프로젝트의
 * 유일한 회복 불가능한 손상이다.
 */
export async function closeUnseen(source: string, runDate: string): Promise<number> {
  const rows = await query<{ id: number }>(
    `UPDATE posting SET is_open = false, updated_at = now()
      WHERE source = $1 AND is_open = true AND last_seen_on < $2
      RETURNING id`,
    [source, runDate],
  );
  return rows.length;
}
