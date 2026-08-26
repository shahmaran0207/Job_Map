import pg from 'pg';
import { buildSslConfig, isCaPinned } from '../lib/db.ts';
import { env } from '../lib/env.ts';

/**
 * DB 연결 진단.
 *
 * 마이그레이션 전에 무엇이 잘못됐는지 특정한다. 확인 항목:
 *   - TLS 검증이 시스템 CA 로 되는가, CA 고정이 필요한가
 *   - 연결·인증이 되는가 (IPv6 문제, 비밀번호 인코딩 문제 구별)
 *   - PostGIS / pg_trgm 확장이 켜져 있는가
 *
 * 어떤 경우에도 인증서 검증을 끄고 재시도하지 않는다.
 */
async function main(): Promise<void> {
  console.log('── 접속 대상 ────────────────────────────────');
  console.log(`host      ${env.databaseHost}`);
  console.log(`TLS       ${env.databaseSslMode === 'disable' ? '비활성(localhost)' : '활성'}`);
  console.log(`CA 고정   ${isCaPinned() ? '켜짐 (인증서 파일 사용)' : '꺼짐 (시스템 신뢰 저장소)'}`);
  console.log('');

  const client = new pg.Client({
    connectionString: env.databaseUrl,
    ssl: buildSslConfig(),
    connectionTimeoutMillis: 15_000,
  });

  try {
    await client.connect();
  } catch (e) {
    reportConnectFailure(e);
    process.exitCode = 1;
    return;
  }

  console.log('✓ 연결 성공');

  const { rows } = await client.query<{ version: string; user: string; db: string }>(
    `SELECT version() AS version, current_user AS user, current_database() AS db`,
  );
  console.log(`  서버      ${rows[0]?.version.split(' ').slice(0, 2).join(' ')}`);
  console.log(`  사용자    ${rows[0]?.user}`);
  console.log(`  데이터베이스 ${rows[0]?.db}`);

  // TLS 실제 적용 여부를 서버 쪽에서 확인한다. 클라이언트 설정만 믿지 않는다.
  try {
    const ssl = await client.query<{ ssl: boolean; version: string | null }>(
      `SELECT ssl, version FROM pg_stat_ssl WHERE pid = pg_backend_pid()`,
    );
    const row = ssl.rows[0];
    if (row) {
      console.log(`  TLS       ${row.ssl ? `적용됨 (${row.version ?? 'unknown'})` : '적용되지 않음'}`);
      if (!row.ssl && env.databaseSslMode !== 'disable') {
        console.error('  ! TLS 를 요구했는데 평문으로 연결되었습니다. 연결 문자열을 확인하세요.');
        process.exitCode = 1;
      }
    }
  } catch {
    // pooler 환경에서 pg_stat_ssl 접근이 제한될 수 있다. 치명적이지 않다.
    console.log('  TLS       서버측 확인 불가 (pooler 제약) — 클라이언트에서는 검증 활성');
  }

  console.log('');
  console.log('── 확장(extension) ──────────────────────────');
  for (const ext of ['postgis', 'pg_trgm']) {
    const r = await client.query<{ v: string }>(
      `SELECT extversion AS v FROM pg_extension WHERE extname = $1`,
      [ext],
    );
    if (r.rows[0]) {
      console.log(`✓ ${ext.padEnd(10)} ${r.rows[0].v}`);
    } else {
      console.log(`✗ ${ext.padEnd(10)} 없음  ->  SQL Editor 에서: create extension if not exists ${ext};`);
      process.exitCode = 1;
    }
  }

  await client.end();
  console.log('');
  console.log(process.exitCode ? '문제가 남아 있습니다. 위 항목을 처리하세요.' : '모두 정상입니다. npm run migrate 를 실행하세요.');
}

/** 에러를 원인별로 번역한다. 비밀값은 출력하지 않는다. */
function reportConnectFailure(e: unknown): void {
  const msg = e instanceof Error ? e.message : String(e);
  const code = (e as { code?: string })?.code;

  console.error('✗ 연결 실패');
  console.error(`  원인: ${msg}`);
  console.error('');

  if (code === 'ENOTFOUND') {
    if (/x{4,}|<|여기|PROJECT|YOUR/i.test(env.databaseHost)) {
      console.error('  DATABASE_URL 이 .env.example 의 예시 값 그대로입니다.');
      console.error('  Supabase > Connect > Session pooler 의 문자열로 교체하세요:');
      console.error('    postgresql://postgres.<ref>:<비밀번호>@aws-0-<리전>.pooler.supabase.com:5432/postgres');
    } else {
      console.error('  호스트 이름을 DNS 로 찾을 수 없습니다. 오타이거나 프로젝트가 삭제된 상태입니다.');
    }
    return;
  }
  if (code === 'ENETUNREACH' || code === 'EHOSTUNREACH') {
    console.error('  IPv6 로만 해석되는 호스트에 IPv4 환경에서 접속을 시도했을 가능성이 큽니다.');
    console.error('  Supabase Connect 에서 Session pooler(aws-0-<리전>.pooler.supabase.com:5432)');
    console.error('  문자열로 교체하세요.');
    return;
  }
  if (code === 'ETIMEDOUT') {
    console.error('  방화벽 또는 네트워크 제한일 수 있습니다. 포트 5432 아웃바운드를 확인하세요.');
    return;
  }
  if (/password authentication failed/i.test(msg)) {
    console.error('  비밀번호가 틀렸거나, 특수문자가 percent-encoding 되지 않았습니다.');
    console.error('  @ -> %40, # -> %23, ! -> %21, $ -> %24');
    console.error('  가장 간단한 해결은 Supabase 에서 영숫자 비밀번호로 재설정하는 것입니다.');
    return;
  }
  if (/self.signed|unable to verify|unable to get local issuer|certificate/i.test(msg)) {
    console.error('  시스템 신뢰 저장소로 인증서를 검증하지 못했습니다.');
    console.error('  이 DB 는 자체 CA 를 쓰므로 CA 인증서 고정이 필요합니다:');
    console.error('    Supabase > Project Settings > Database > SSL Configuration > Download certificate');
    console.error('    저장 후  DATABASE_CA_CERT_PATH=./secrets/prod-ca.crt');
    console.error('  (검증을 끄는 우회는 제공하지 않습니다.)');
    return;
  }
  if (/Tenant or user not found/i.test(msg)) {
    console.error('  pooler 사용자명 형식이 틀렸습니다. postgres 가 아니라');
    console.error('  postgres.<프로젝트ref> 형태여야 합니다.');
    return;
  }
  console.error('  DATABASE_URL 의 호스트/포트/사용자명/데이터베이스명을 확인하세요.');
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
