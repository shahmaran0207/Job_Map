import { assertKoreanCoord } from './security';
import { orsDirections, orsFetch } from './ors';
import { transitIsochrone, transitRoute, type TransitDeparture, type TransitModeFilter } from './transit';

export type { TransitDeparture, TransitModeFilter };

/**
 * 등시선 클라이언트.
 *
 * 도보/자차는 OpenRouteService(무료 공개 API, 이메일 가입만 필요)를 그대로
 * 호출한다. 대중교통은 자체 호스팅 서버 없이 이 프로세스 안에서 minotor
 * (RAPTOR)를 직접 돌린다(`./transit.ts`).
 *
 * 예전엔 Valhalla/OTP2 를 개발 PC Docker 위에서 돌리고 인증 프록시를 거쳐
 * 호출했다 — "PC를 꺼놓으면 라우팅 엔진도 죽는다"는 문제로 폐기했다
 * (TODO.md 4번 참고). 지금은 서버가 아예 없다.
 */

export type TravelMode = 'walk' | 'transit' | 'drive';

const ORS_PROFILE: Record<'walk' | 'drive', 'foot-walking' | 'driving-car'> = {
  walk: 'foot-walking',
  drive: 'driving-car',
};

/** 지도에 그릴 경로 한 구간. 세그먼트마다 색·종류가 다를 수 있다(대중교통 환승 등). */
export interface RouteSegment {
  coords: [number, number][];
  color: string;
  kind: 'subway' | 'bus' | 'walk' | 'drive' | 'transfer';
  label?: string;
}

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
  departure?: TransitDeparture,
): Promise<IsochronePolygon> {
  // 사용자 입력 좌표를 그대로 엔진에 넘기지 않는다.
  assertKoreanCoord(lon, lat);
  const mins = assertAllowedMinutes(minutes);

  if (mode === 'transit') {
    if (!departure) throw new Error('대중교통 모드는 출발 시각(departure)이 필요합니다');
    return transitIsochrone(lon, lat, mins, departure);
  }

  const json = await orsFetch(`/v2/isochrones/${ORS_PROFILE[mode]}`, {
    locations: [[lon, lat]],
    range: [mins * 60], // 초 단위
    range_type: 'time',
  });

  return toMultiPolygon(json);
}

/**
 * 두 지점 사이의 실제 경로. 건물 상세 팝업의 "경로 보기"가 쓴다.
 *
 * `isochrone()`과 달리 지점→지점 단일 경로라서 결과를 캐시하지 않는다(요청
 * 조합이 사실상 무한해서 캐시 적중률이 낮고, 직장 좌표가 목적지로 들어가는
 * 요청이라 캐시에 남기는 것도 바람직하지 않다).
 */
export async function route(
  fromLon: number,
  fromLat: number,
  toLon: number,
  toLat: number,
  mode: TravelMode,
  departure?: TransitDeparture,
  transitModes?: TransitModeFilter,
): Promise<RouteSegment[]> {
  assertKoreanCoord(fromLon, fromLat);
  assertKoreanCoord(toLon, toLat);

  if (mode === 'transit') {
    if (!departure) throw new Error('대중교통 모드는 출발 시각(departure)이 필요합니다');
    return transitRoute(fromLon, fromLat, toLon, toLat, departure, transitModes ?? 'all');
  }

  const coords = await orsDirections(fromLon, fromLat, toLon, toLat, ORS_PROFILE[mode]);
  return [{ coords, color: mode === 'walk' ? '#22D3EE' : '#F59E0B', kind: mode }];
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
