import { env } from './env';
import { safeFetch } from './security';

/**
 * OpenRouteService 호출 공통 헬퍼.
 *
 * `routing.ts`(등시선)와 `transit.ts`(버스 구간 도로 스냅)가 공유한다 — 별도
 * 파일로 뺀 이유는 두 모듈이 서로를 import 하는 순환 참조를 피하기 위해서다
 * (`routing.ts` → `transit.ts` 방향은 이미 있고, `transit.ts` → `routing.ts`
 * 를 추가하면 순환이 생긴다).
 */
const ORS_HOST = 'api.openrouteservice.org';
const ORS_TIMEOUT_MS = 15_000;

export async function orsFetch(path: string, body: object): Promise<any> {
  if (!env.orsApiKey) {
    throw new Error('ORS_API_KEY 가 설정되지 않았습니다. openrouteservice.org 에서 무료 키를 발급하세요.');
  }

  const res = await safeFetch(`https://${ORS_HOST}${path}`, {
    method: 'POST',
    body: JSON.stringify(body),
    allowHosts: [ORS_HOST],
    headers: { Authorization: env.orsApiKey, 'Content-Type': 'application/json' },
    maxRedirects: 0,
    maxBytes: 8 * 1024 * 1024,
    timeoutMs: ORS_TIMEOUT_MS,
  });

  if (res.status === 401 || res.status === 403) throw new Error('ORS 인증 실패 (ORS_API_KEY 확인)');
  if (res.status === 429) throw new Error('ORS 요청이 레이트리밋에 걸렸습니다');
  if (res.status !== 200) throw new Error(`ORS 오류 (HTTP ${res.status})`);

  return JSON.parse(res.text);
}

/** 두 지점 사이의 실제 도로/보행 경로 좌표열([lon,lat][])을 받는다. */
export async function orsDirections(
  fromLon: number,
  fromLat: number,
  toLon: number,
  toLat: number,
  profile: 'driving-car' | 'foot-walking',
): Promise<[number, number][]> {
  const json = await orsFetch(`/v2/directions/${profile}/geojson`, {
    coordinates: [
      [fromLon, fromLat],
      [toLon, toLat],
    ],
  });
  const coords = json?.features?.[0]?.geometry?.coordinates;
  if (!Array.isArray(coords) || coords.length === 0) {
    // 도로가 없거나(도서 지역 등) ORS가 경로를 못 찾으면 직선으로 물러선다.
    return [
      [fromLon, fromLat],
      [toLon, toLat],
    ];
  }
  return coords;
}
