import { closeDb } from '../lib/db';
import { env } from '../lib/env';
import { isochroneCacheStats } from '../lib/isochrone';
import { isochrone, type TravelMode } from '../lib/routing';

/**
 * 라우팅 진단.
 *
 * "안 된다" 를 "무엇이 왜 안 된다" 로 바꾼다. 서버가 없어졌으니(ORS + minotor,
 * TODO.md 4번 참고) 예전처럼 "Docker Desktop이 떠 있는가"를 확인할 필요는
 * 없다 — 확인할 건 ORS_API_KEY 설정과 대중교통 그래프(transit_graph 테이블)
 * 준비 여부뿐이다.
 *
 * 대중교통 그래프는 지금 부산+인근 통근권만 커버한다(전국은 GTFS 원본 자체가
 * 수동 다운로드라 자동화가 안 되고, 필요할 때 bbox를 바꿔 다시 빌드해야 한다).
 * 그래서 프로브 좌표도 그 범위 안(부산역)으로 잡는다.
 */
const PROBE = { lon: 129.0403, lat: 35.1156, label: '부산역' };
const TRANSIT_DEPARTURE = { dayOfWeek: 1 as const, hour: 8, minute: 0 };

async function main(): Promise<void> {
  console.log('── 설정 ────────────────────────────────────');
  console.log(`ORS_API_KEY  ${env.orsApiKey ? `설정됨 (${env.orsApiKey.length}자)` : '(없음)'}`);

  if (!env.orsApiKey) {
    console.log('');
    console.log('openrouteservice.org 에서 무료 키를 발급해 .env 에 설정하세요.');
    console.log('  ORS_API_KEY=<발급받은 키>');
    console.log('(대중교통은 이 키가 없어도 확인 가능합니다 — 아래에서 계속 시도합니다)');
  }

  console.log('');
  console.log(`── 등시선 호출 (${PROBE.label}) ──────────────`);

  const modes: TravelMode[] = ['walk', 'drive', 'transit'];
  let anyOk = false;

  for (const mode of modes) {
    const started = Date.now();
    try {
      const poly = await isochrone(
        PROBE.lon,
        PROBE.lat,
        mode,
        30,
        mode === 'transit' ? TRANSIT_DEPARTURE : undefined,
      );
      const points = poly.coordinates.reduce(
        (n, p) => n + p.reduce((m, ring) => m + ring.length, 0),
        0,
      );
      console.log(
        `✓ ${mode.padEnd(8)} 폴리곤 ${poly.coordinates.length}개 / ${points}점  ` +
          `(${((Date.now() - started) / 1000).toFixed(1)}초)`,
      );
      anyOk = true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`✗ ${mode.padEnd(8)} ${msg.slice(0, 160)}`);
      if (mode === 'transit') {
        console.log('           (npm run build:transit-graph 로 그래프를 먼저 채웠는지 확인)');
      }
    }
  }

  const cache = await isochroneCacheStats();
  console.log('');
  console.log('── 등시선 캐시 ─────────────────────────────');
  if (cache.length === 0) {
    console.log('비어 있음');
  } else {
    for (const c of cache) console.log(`  ${c.mode.padEnd(8)} ${c.minutes}분  격자 ${c.cells}개`);
  }

  console.log('');
  if (!anyOk) {
    console.log('전부 실패했습니다. 확인 순서:');
    console.log('  1) .env 의 ORS_API_KEY 가 올바른가 (도보/자차)');
    console.log('  2) npm run build:transit-graph 를 실행했는가 (대중교통)');
    process.exitCode = 1;
  } else {
    console.log('정상. 지도가 등시선으로 동작합니다.');
  }
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(closeDb);
