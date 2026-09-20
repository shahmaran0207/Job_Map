import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Query, RangeQuery, Router, StopsIndex, Timetable } from 'minotor';
import type { Leg, VehicleLeg } from 'minotor';
import { circle, featureCollection, union } from '@turf/turf';
import type { Feature, Polygon } from 'geojson';
import { assertKoreanCoord } from './security';
import { orsDirections } from './ors';
import type { IsochronePolygon, RouteSegment } from './routing';

/**
 * 대중교통 등시선 — minotor(RAPTOR) 를 서버리스 함수 안에서 직접 돌린다.
 *
 * 자체 호스팅 OTP2(Docker)를 대체한다. 서버가 없으므로 "PC를 켜놔야 동작한다"는
 * 문제 자체가 사라진다. 트레이드오프는 정류장까지 걷는 구간이 실제 도로가 아니라
 * 직선거리 근사라는 것 — OTP2보다 부정확하지만, 라우팅 엔진이 꺼졌을 때 쓰던
 * 기존 폴백(순수 반경)보다는 훨씬 정확하다(적어도 대중교통 구간은 시간표 기반
 * 정확한 계산이다).
 */

/** 대중교통 출발 시각. dayOfWeek 는 API 호환을 위해 남겨두지만, 지금 GTFS 는
 * 서비스가 요일 무관하게 매일 동일해서(calendar.txt) 실제로는 쓰이지 않는다. */
export interface TransitDeparture {
  dayOfWeek: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  hour: number;
  minute: number;
}

export type TransitModeFilter = 'all' | 'subway' | 'bus';

/**
 * minotor 내부 RouteType 숫자값(`node_modules/minotor/dist/timetable/timetable.d.ts`
 * 의 `RouteTypes`). 패키지가 이 상수 자체는 공개 export 하지 않아서 값만 옮겨왔다
 * — GTFS 표준 route_type을 그대로 1:1 매핑한 값이라 바뀔 일은 거의 없다.
 */
const ROUTE_TYPE = {
  TRAM: 1, SUBWAY: 2, RAIL: 3, BUS: 4, FERRY: 5,
  CABLE_TRAM: 6, AERIAL_LIFT: 7, FUNICULAR: 8, TROLLEYBUS: 9, MONORAIL: 10,
} as const;
/** "버스" 취급: SUBWAY 를 뺀 전부. 이 GTFS는 route_type 표기가 표준과 어긋나서
 * (실측: type=0,3 전부 시내버스 번호) SUBWAY 여부 하나로만 가른다 — TODO.md 참고. */
const NON_SUBWAY_TYPES = Object.values(ROUTE_TYPE).filter((t) => t !== ROUTE_TYPE.SUBWAY);

const SUBWAY_LINE_COLORS: Record<string, string> = {
  '1호선': '#EF8B1E',
  '2호선': '#7ABE23',
  '3호선': '#93502E',
  '4호선': '#00A4E4',
};
const SUBWAY_DEFAULT_COLOR = '#8B8B8B';
const BUS_PALETTE = [
  '#E63946', '#2A9D8F', '#F4A261', '#E76F51', '#457B9D', '#8AC926', '#FF6B9D', '#6A4C93',
];

function subwayColor(routeName: string): string {
  for (const [key, color] of Object.entries(SUBWAY_LINE_COLORS)) {
    if (routeName.includes(key)) return color;
  }
  return SUBWAY_DEFAULT_COLOR;
}

function busColor(routeName: string): string {
  let hash = 0;
  for (let i = 0; i < routeName.length; i++) hash = (hash * 31 + routeName.charCodeAt(i)) | 0;
  return BUS_PALETTE[Math.abs(hash) % BUS_PALETTE.length]!;
}

function isVehicleLeg(leg: Leg): leg is VehicleLeg {
  return 'route' in leg;
}

const WALK_SPEED_KMH = 4.8;
const WALK_SPEED_M_PER_MIN = (WALK_SPEED_KMH * 1000) / 60;
/** 도보 접근을 고려할 인근 정류장 탐색 반경(km). */
const ACCESS_SEARCH_RADIUS_KM = 1.5;
const MAX_TRANSFERS = 4;
const MIN_TRANSFER_TIME = 2;

const GRAPH_DIR = join(process.cwd(), 'src/data/transit-graph');

let cached: { router: Router; stopsIndex: StopsIndex } | undefined;

function loadGraph(): { router: Router; stopsIndex: StopsIndex } {
  if (cached) return cached;

  let timetableBytes: Buffer;
  let stopsBytes: Buffer;
  try {
    timetableBytes = readFileSync(join(GRAPH_DIR, 'timetable.bin'));
    stopsBytes = readFileSync(join(GRAPH_DIR, 'stops.bin'));
  } catch {
    throw new Error(
      '대중교통 그래프가 준비되지 않았습니다. npm run build:transit-graph 를 먼저 실행하세요.',
    );
  }

  const stopsIndex = StopsIndex.fromData(new Uint8Array(stopsBytes));
  const timetable = Timetable.fromData(new Uint8Array(timetableBytes));
  const router = new Router(timetable, stopsIndex);

  cached = { router, stopsIndex };
  return cached;
}

function haversineMeters(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export async function transitIsochrone(
  lon: number,
  lat: number,
  minutes: number,
  departure: TransitDeparture,
): Promise<IsochronePolygon> {
  assertKoreanCoord(lon, lat);
  const { router, stopsIndex } = loadGraph();

  const circles: Feature<Polygon>[] = [];

  // 대중교통을 아예 안 타고 순수 도보로 갈 수 있는 범위(OTP2의 modes=WALK,TRANSIT 와 동치).
  circles.push(circle([lon, lat], (minutes * WALK_SPEED_M_PER_MIN) / 1000, { steps: 12 }));

  // 가장 가까운 정류장 하나를 진입점으로 쓴다. 여러 정류장을 동시에 고려하면
  // 정확도는 오르지만 RAPTOR 실행 횟수가 늘어 서버리스 타임아웃 위험이 커진다 —
  // 지금은 단일 진입점으로 충분히 실용적인 결과를 낸다.
  const nearest = stopsIndex.findStopsByLocation(lat, lon, 1, ACCESS_SEARCH_RADIUS_KM)[0];
  if (nearest?.lat !== undefined && nearest?.lon !== undefined) {
    const walkToStopMin =
      haversineMeters(lon, lat, nearest.lon, nearest.lat) / WALK_SPEED_M_PER_MIN;

    if (walkToStopMin <= minutes) {
      const departureTime = departure.hour * 60 + departure.minute;
      const rangeQuery = new RangeQuery.Builder()
        .from(nearest.id)
        .to(new Set())
        .departureTime(departureTime)
        .lastDepartureTime(departureTime)
        .maxTransfers(MAX_TRANSFERS)
        .minTransferTime(MIN_TRANSFER_TIME)
        .build();

      const result = router.rangeRoute(rangeQuery);
      for (const [stopId, arrival] of result.allShortestDurations()) {
        const total = walkToStopMin + arrival.duration;
        if (total > minutes) continue;
        const stop = stopsIndex.findStopById(stopId);
        if (stop?.lat === undefined || stop?.lon === undefined) continue;
        const leftoverKm = ((minutes - total) * WALK_SPEED_M_PER_MIN) / 1000;
        circles.push(circle([stop.lon, stop.lat], Math.max(0.03, leftoverKm), { steps: 8 }));
      }
    }
  }

  const merged = union(featureCollection(circles));
  if (!merged) return { type: 'MultiPolygon', coordinates: [] };

  return merged.geometry.type === 'Polygon'
    ? { type: 'MultiPolygon', coordinates: [merged.geometry.coordinates] }
    : { type: 'MultiPolygon', coordinates: merged.geometry.coordinates };
}

const WALK_SEGMENT_COLOR = '#94A3B8';

/**
 * 두 지점 사이의 최적 대중교통 경로 — 건물 상세 팝업의 "경로 보기"가 쓴다.
 *
 * `transitIsochrone()`(전체 도달 가능 정류장)과 달리 지점→지점 단일 경로라서
 * minotor의 `Query`(RangeQuery 아님) + `Router.route()` 를 쓴다.
 *
 * 지하철 구간은 정류장 직선(철로 shapes.txt가 원본 GTFS에 없음), 버스 구간은
 * ORS Directions로 실제 도로 위에 스냅한다 — 버스는 도로를 달리므로 이 근사가
 * 훨씬 사실에 가깝다.
 */
export async function transitRoute(
  fromLon: number,
  fromLat: number,
  toLon: number,
  toLat: number,
  departure: TransitDeparture,
  modeFilter: TransitModeFilter,
): Promise<RouteSegment[]> {
  assertKoreanCoord(fromLon, fromLat);
  assertKoreanCoord(toLon, toLat);
  const { router, stopsIndex } = loadGraph();

  const originStop = stopsIndex.findStopsByLocation(fromLat, fromLon, 1, ACCESS_SEARCH_RADIUS_KM)[0];
  const destStop = stopsIndex.findStopsByLocation(toLat, toLon, 1, ACCESS_SEARCH_RADIUS_KM)[0];
  if (
    !originStop || !destStop ||
    originStop.lat === undefined || originStop.lon === undefined ||
    destStop.lat === undefined || destStop.lon === undefined
  ) {
    throw new Error('인근에 대중교통 정류장을 찾을 수 없습니다.');
  }

  const departureTime = departure.hour * 60 + departure.minute;
  const builder = new Query.Builder()
    .from(originStop.id)
    .to(destStop.id)
    .departureTime(departureTime)
    .maxTransfers(MAX_TRANSFERS)
    .minTransferTime(MIN_TRANSFER_TIME);

  // minotor가 이 숫자 타입을 공개 export 하지 않아 캐스팅이 필요하다(ROUTE_TYPE 주석 참고).
  if (modeFilter === 'subway') builder.transportModes(new Set([ROUTE_TYPE.SUBWAY]) as any);
  else if (modeFilter === 'bus') builder.transportModes(new Set(NON_SUBWAY_TYPES) as any);

  const result = router.route(builder.build());
  const bestRoute = result.bestRoute();
  if (!bestRoute) throw new Error('대중교통 경로를 찾을 수 없습니다.');

  const segments: RouteSegment[] = [
    { coords: [[fromLon, fromLat], [originStop.lon, originStop.lat]], color: WALK_SEGMENT_COLOR, kind: 'walk' },
  ];

  for (const leg of bestRoute.legs) {
    const from = leg.from;
    const to = leg.to;
    if (from.lat === undefined || from.lon === undefined || to.lat === undefined || to.lon === undefined) continue;

    if (isVehicleLeg(leg)) {
      if (leg.route.type === 'SUBWAY') {
        segments.push({
          coords: [[from.lon, from.lat], [to.lon, to.lat]],
          color: subwayColor(leg.route.name),
          kind: 'subway',
          label: leg.route.name,
        });
      } else {
        const coords = await orsDirections(from.lon, from.lat, to.lon, to.lat, 'driving-car');
        segments.push({ coords, color: busColor(leg.route.name), kind: 'bus', label: leg.route.name });
      }
    } else {
      segments.push({ coords: [[from.lon, from.lat], [to.lon, to.lat]], color: WALK_SEGMENT_COLOR, kind: 'transfer' });
    }
  }

  segments.push({
    coords: [[destStop.lon, destStop.lat], [toLon, toLat]],
    color: WALK_SEGMENT_COLOR,
    kind: 'walk',
  });

  return segments;
}
