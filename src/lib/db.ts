import { readFileSync } from 'node:fs';
import pg from 'pg';
import { env } from './env';

/**
 * DB TLS 설정.
 *
 * 불변 규칙: `rejectUnauthorized: false` 는 어떤 경우에도 쓰지 않는다. 인증서 검증을
 * 끄면 DB 연결이 중간자 공격에 그대로 노출되고, 이 DB 에는 수집 데이터 전량과
 * (향후) 사용자 데이터가 들어간다. 흔한 편법이지만 이 프로젝트에서는 금지다.
 *
 * 검증 방식은 두 가지 중 하나이며, 둘 다 정당한 검증이다.
 *
 *  1) 시스템 신뢰 저장소 (기본)
 *     공개 CA 가 발급한 인증서라면 Node 내장 루트 저장소로 검증된다.
 *     Supabase 의 Session pooler 는 보통 이 경우에 해당한다.
 *
 *  2) CA 인증서 고정 (선택적 강화)
 *     DATABASE_CA_CERT_PATH 또는 DATABASE_CA_CERT 를 주면 그 CA 만 신뢰한다.
 *     공개 CA 중 하나가 오발급되는 상황까지 막는 추가 방어이며,
 *     Supabase 자체 CA 로 서명된 direct 연결에서는 필수가 된다.
 *
 * 어느 쪽인지는 `npm run db:check` 로 확인한다.
 * 로컬 평문 Postgres 는 DATABASE_SSL=disable 로만 끌 수 있고, localhost 에 한정된다.
 */
type SslConfig = pg.PoolConfig['ssl'];

export function buildSslConfig(): SslConfig {
  if (env.databaseSslMode === 'disable') {
    if (!env.databaseIsLocal) {
      throw new Error(
        'DATABASE_SSL=disable 은 localhost 연결에서만 허용됩니다. 원격 DB 는 TLS 가 필수입니다.',
      );
    }
    return undefined;
  }

  const ca = loadCaCert();

  return {
    // ca 가 있으면 그 CA 만 신뢰(고정), 없으면 시스템 루트 저장소로 검증.
    ...(ca ? { ca } : {}),
    rejectUnauthorized: true, // 어떤 경로에서도 false 로 내려가지 않는다
    minVersion: 'TLSv1.2',
    servername: env.databaseHost, // SNI + 인증서 호스트명 검증 대상을 명시
  };
}

/** CA 고정이 켜져 있는지. 진단 스크립트가 상태를 표시하는 데 쓴다. */
export function isCaPinned(): boolean {
  return loadCaCert() !== undefined;
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

/**
 * DATE 컬럼을 문자열('YYYY-MM-DD')로 그대로 받는다.
 *
 * node-postgres 는 기본적으로 DATE 를 "로컬 시간대 자정의 Date 객체"로 파싱한다.
 * 그 값을 toISOString() 으로 다시 문자열화하면 KST(UTC+9)에서는 9시간이 빠져
 * **하루 전날**이 된다. 그러면 DB 에 저장된 날짜와 코드가 읽은 날짜가 달라지고,
 * 변경 감지가 매 실행마다 가짜 변경을 기록한다(closes_on 이 매일 바뀐 것처럼 보임).
 *
 * 이 프로젝트는 날짜를 계산이 아니라 식별자로 쓴다(수집 기준일, 마감일, 구간 경계).
 * 그러므로 Date 객체로 왕복시키지 않고 문자열로 다루는 것이 옳다.
 *
 * OID 1082 = date. date[] (1182) 는 이 프로젝트에서 쓰지 않으므로 등록하지 않는다.
 */
pg.types.setTypeParser(1082, (v: string) => v);

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
