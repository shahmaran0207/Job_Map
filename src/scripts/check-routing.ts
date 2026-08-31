import { closeDb } from '../lib/db';
import { env } from '../lib/env';
import { isochroneCacheStats } from '../lib/isochrone';
import { isochrone, type TravelMode } from '../lib/routing';

/**
 * 라우팅 엔진 진단.
 *
 * 다른 진단 스크립트와 같은 역할이다. "안 된다" 를 "무엇이 왜 안 된다" 로 바꾼다.
 * 엔진은 개발 PC Docker 위에 있어 상태가 자주 바뀌므로 이게 특히 유용하다.
 */
const PROBE = { lon: 127.0276, lat: 37.4979, label: '서울 강남역' };

async function main(): Promise<void> {
  console.log('── 설정 ────────────────────────────────────');
  console.log(`ROUTING_URL    ${env.routingUrl ?? '(없음)'}`);
  console.log(`ROUTING_TOKEN  ${env.routingToken ? `설정됨 (${env.routingToken.length}자)` : '(없음)'}`);

  if (!env.routingUrl || !env.routingToken) {
    console.log('');
    console.log('두 값을 .env 에 설정해야 합니다.');
    console.log('  ROUTING_URL=http://127.0.0.1:8000');
    console.log('  ROUTING_TOKEN=<openssl rand -hex 32 또는 아래 명령>');
    console.log('  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
    console.log('');
    console.log('설정 후: npm run routing:up');
    process.exitCode = 1;
    return;
  }

  console.log('');
  console.log(`── 등시선 호출 (${PROBE.label}) ──────────────`);

  // 대중교통은 GTFS 확보 전까지 실패하는 것이 정상이다. 도보/자차부터 본다.
  const modes: TravelMode[] = ['walk', 'drive', 'transit'];
  let anyOk = false;

  for (const mode of modes) {
    const started = Date.now();
    try {
      const poly = await isochrone(PROBE.lon, PROBE.lat, mode, 30);
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
      console.log(`✗ ${mode.padEnd(8)} ${msg.slice(0, 120)}`);
      if (mode === 'transit') {
        console.log('           (대중교통은 OTP2 + GTFS 가 필요합니다. 아직 미구성이면 정상입니다)');
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
    console.log('엔진에 도달하지 못했습니다. 확인 순서:');
    console.log('  1) Docker Desktop 이 실행 중인가');
    console.log('  2) npm run routing:up 을 실행했는가');
    console.log('  3) npm run routing:logs — Valhalla 가 타일을 빌드 중일 수 있다(첫 기동 15~40분)');
    console.log('  4) 401 이 보이면 .env 의 ROUTING_TOKEN 과 컨테이너 값이 다르다.');
    console.log('     npm run routing:down 후 다시 up 하면 반영된다.');
    process.exitCode = 1;
  } else {
    console.log('엔진 정상. 지도가 등시선으로 동작합니다.');
  }
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(closeDb);
