import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RangeQuery, Router, StopsIndex, Timetable } from 'minotor';
import { circle, featureCollection, union } from '@turf/turf';
import type { Feature, Polygon } from 'geojson';
import { assertKoreanCoord } from './security';
import type { IsochronePolygon } from './routing';

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
