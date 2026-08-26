import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { closeDb, query } from '../lib/db.ts';

const DIR = join(process.cwd(), 'db');

async function main(): Promise<void> {
  await query(`CREATE TABLE IF NOT EXISTS schema_migration (
                 filename   text PRIMARY KEY,
                 applied_at timestamptz NOT NULL DEFAULT now())`);

  const applied = new Set(
    (await query<{ filename: string }>('SELECT filename FROM schema_migration')).map((r) => r.filename),
  );

  const files = (await readdir(DIR)).filter((f) => f.endsWith('.sql')).sort();

  for (const file of files) {
    if (applied.has(file)) {
      console.log(`  = ${file} (이미 적용)`);
      continue;
    }
    const sql = await readFile(join(DIR, file), 'utf8');
    console.log(`  + ${file} 적용 중...`);
    await query(sql);
    await query('INSERT INTO schema_migration (filename) VALUES ($1)', [file]);
    console.log(`  + ${file} 완료`);
  }
  console.log('마이그레이션 끝');
}

main()
  .catch((e) => {
    console.error('마이그레이션 실패:', e);
    process.exitCode = 1;
  })
  .finally(closeDb);
