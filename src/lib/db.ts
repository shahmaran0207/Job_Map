import { readFileSync } from 'node:fs';
import pg from 'pg';
import { env } from './env.ts';

/**
 * DB TLS 설정.
 *
 * rejectUnauthorized: false 는 절대 쓰지 않는다. 인증서 검증을 끄면 DB 연결이
 * 중간자 공격에 그대로 노출되고, 이 DB 에는 수집 데이터 전량과 (향후) 사용자
 * 데이터가 들어간다. 흔한 편법이지만 이 프로젝트에서는 금지 사항이다.
 *
 * Supabase 직접 연결은 자체 CA 로 서명되어 시스템 CA 로는 검증되지 않는다.
 * 따라서 CA 인증서를 명시적으로 주입해 검증한다.
 *   Supabase > Project Settings > Database > SSL Configuration > Download certificate
 *   저장 후  DATABASE_CA_CERT_PATH=./secrets/prod-ca.crt  (또는 DATABASE_CA_CERT 에 PEM 본문)
 *
 * CA 가 없으면 연결을 거부한다. 로컬 개발용 평문 Postgres 는
 * DATABASE_SSL=disable 로 명시적으로 끌 수 있다 (localhost 한정 검사).
 */
type SslConfig = pg.PoolConfig['ssl'];

function buildSslConfig(): SslConfig {
  if (env.databaseSslMode === 'disable') {
    if (!env.databaseIsLocal) {
      throw new Error(
        'DATABASE_SSL=disable 은 localhost 연결에서만 허용됩니다. 원격 DB 는 TLS 가 필수입니다.',
      );
    }
    return undefined;
  }

  const ca = loadCaCert();
  if (!ca) {
    throw new Error(
      'DB TLS 검증용 CA 인증서가 없습니다. DATABASE_CA_CERT_PATH 또는 DATABASE_CA_CERT 를 설정하세요.\n' +
        '  Supabase > Project Settings > Database > SSL Configuration 에서 인증서를 내려받을 수 있습니다.\n' +
        '  (인증서 검증을 끄는 우회는 이 프로젝트에서 허용하지 않습니다.)',
    );
  }

  return {
    ca,
    rejectUnauthorized: true,
    minVersion: 'TLSv1.2',
    servername: env.databaseHost, // SNI + 인증서 호스트명 검증 대상을 명시
  };
}

function loadCaCert(): string | undefined {
  const inline = process.env.DATABASE_CA_CERT;
  if (inline && inline.includes('BEGIN CERTIFICATE')) return inline;

  const path = process.env.DATABASE_CA_CERT_PATH;
  if (!path) return undefined;
  try {
    const pem = readFileSync(path, 'utf8');
    return pem.includes('BEGIN CERTIFICATE') ? pem : undefined;
  } catch {
    throw new Error(`DATABASE_CA_CERT_PATH 를 읽을 수 없습니다: ${path}`);
  }
}

// Supabase 무료 티어는 동시 연결 수가 빡빡하다. 풀을 작게 유지한다.
const pool = new pg.Pool({
  connectionString: env.databaseUrl,
  max: 4,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 15_000,
  // 장기 실행 수집 중 쿼리가 매달려 커넥션을 고갈시키는 것을 막는다.
  statement_timeout: 60_000,
  query_timeout: 60_000,
  ssl: buildSslConfig(),
});

// 풀에서 발생한 비동기 에러가 프로세스를 죽이지 않도록 하되, 조용히 삼키지도 않는다.
pool.on('error', (err) => {
  console.error('DB 풀 오류:', err.message);
});

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  // 이 프로젝트의 모든 SQL 은 파라미터 바인딩만 사용한다.
  // 문자열 보간으로 값을 넣는 코드는 리뷰에서 무조건 반려한다 (SQL 인젝션).
  const res = await pool.query<T>(sql, params);
  return res.rows;
}

export async function one<T extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string,
  params: unknown[] = [],
): Promise<T | undefined> {
  const rows = await query<T>(sql, params);
  return rows[0];
}

export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function closeDb(): Promise<void> {
  await pool.end();
}
