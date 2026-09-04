import { env } from './env';
import { assertKoreanCoord, isBlockedIp, safeFetch } from './security';

// 로컬 개발용 엔진(127.0.0.1)이 꺼져 있으면 빨리 실패해서 직선 반경으로
// 물러서야 한다 — 안 그러면 검색/필터 한 번에 최대 40초씩 멈춘 것처럼 보인다.
// 실제 배포(Cloudflare Tunnel 뒤 원격 엔진)는 등시선 계산 자체가 오래 걸릴 수
// 있어 타임아웃을 넉넉하게 둔다.
const LOCAL_ROUTING_TIMEOUT_MS = 2_000;
const REMOTE_ROUTING_TIMEOUT_MS = 40_000;

function isLocalRoutingHost(hostname: string): boolean {
  return hostname === 'localhost' || isBlockedIp(hostname);
}

/**
 * 라우팅 엔진 클라이언트.
 *
 * 엔진(Valhalla/OTP2)에는 인증 기능이 없으므로 반드시 인증 프록시(docker/)를 경유한다.
 * 이 파일은 프록시 주소로만 요청하고, 프록시가 요구하는 Bearer 토큰을 붙인다.
 * 엔진 포트로 직접 요청하는 코드는 리뷰에서 반려한다.
 */

export type TravelMode = 'walk' | 'transit' | 'drive';

/** 사용자가 지정할 수 있는 통근 시간 상한. 임의 값을 허용하면 엔진을 태울 수 있다. */
const ALLOWED_MINUTES = [10, 15, 20, 30, 45, 60, 90] as const;
export type AllowedMinutes = (typeof ALLOWED_MINUTES)[number];

export function assertAllowedMinutes(m: number): AllowedMinutes {
  const hit = ALLOWED_MINUTES.find((v) => v === m);
  if (!hit) {
    throw new Error(`허용되지 않은 시간 값입니다. 가능한 값: ${ALLOWED_MINUTES.join(', ')}`);
  }
  return hit;
}

/** GeoJSON MultiPolygon (등시선 결과) */
export interface IsochronePolygon {
  type: 'MultiPolygon';
  coordinates: number[][][][];
}

function requireRouting(): { url: string; token: string } {
  if (!env.routingUrl || !env.routingToken) {
    throw new Error(
      'ROUTING_URL / ROUTING_TOKEN 이 설정되지 않았습니다. docker/ 의 인증 프록시를 먼저 띄우세요.',
    );
  }
  return { url: env.routingUrl.replace(/\/+$/, ''), token: env.routingToken };
}

/**
 * 등시선(출발지에서 N분 내에 닿는 영역)을 계산한다.
 *
 * 이 프로젝트의 비용 구조가 여기 달려 있다. 공고마다 경로를 계산하면
 * 사용자 1명당 수만 콜이지만, 등시선 1개를 뽑아 PostGIS 공간 쿼리로 필터하면 1콜이다.
 */
export async function isochrone(
  lon: number,
  lat: number,
  mode: TravelMode,
  minutes: number,
): Promise<IsochronePolygon> {
  // 사용자 입력 좌표를 그대로 엔진에 넘기지 않는다.
  assertKoreanCoord(lon, lat);
  const mins = assertAllowedMinutes(minutes);

  const { url, token } = requireRouting();
  const isTransit = mode === 'transit';
  const endpoint = isTransit ? `${url}/otp/isochrone` : `${url}/valhalla/isochrone`;

  const body = isTransit
    ? JSON.stringify({ lon, lat, cutoff: `${mins}m` })
    : JSON.stringify({
        locations: [{ lon, lat }],
        costing: mode === 'walk' ? 'pedestrian' : 'auto',
        contours: [{ time: mins }],
        polygons: true,
        denoise: 0.4,
        generalize: 50,
      });

  const timeoutMs = isLocalRoutingHost(new URL(url).hostname)
    ? LOCAL_ROUTING_TIMEOUT_MS
    : REMOTE_ROUTING_TIMEOUT_MS;

  const res = await safeFetch(endpoint, {
    method: 'POST',
    body,
    allowHosts: [new URL(url).hostname],
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    maxRedirects: 0,
    maxBytes: 8 * 1024 * 1024,
    timeoutMs,
  });

  if (res.status === 401) throw new Error('라우팅 프록시 인증 실패 (ROUTING_TOKEN 불일치)');
  if (res.status === 429) throw new Error('라우팅 요청이 레이트리밋에 걸렸습니다');
  if (res.status !== 200) throw new Error(`라우팅 엔진 오류 (HTTP ${res.status})`);

  return toMultiPolygon(JSON.parse(res.text));
}

/** 엔진별로 다른 응답 형태를 MultiPolygon 하나로 정규화한다. */
function toMultiPolygon(json: any): IsochronePolygon {
  const features: any[] = json?.features ?? [];
  const coordinates: number[][][][] = [];

  for (const f of features) {
    const g = f?.geometry;
    if (!g) continue;
    if (g.type === 'Polygon') coordinates.push(g.coordinates);
    else if (g.type === 'MultiPolygon') coordinates.push(...g.coordinates);
  }

  if (coordinates.length === 0) throw new Error('등시선 계산 결과가 비어 있습니다');
  return { type: 'MultiPolygon', coordinates };
}
