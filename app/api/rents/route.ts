import { NextResponse } from 'next/server';
import { query } from '../../../src/lib/db';
import { snapToCell } from '../../../src/lib/grid';
import { RoutingUnavailableError, getIsochrone } from '../../../src/lib/isochrone';
import { clientKey, rateLimit } from '../../../src/lib/rate-limit';
import { assertAllowedMinutes, type TravelMode } from '../../../src/lib/routing';
import { assertKoreanCoord } from '../../../src/lib/security';
import { HOUSING_TYPES, type HousingType } from '../../../src/collectors/molit-types';

/**
 * 직장 좌표 기준 통근권 내 거주지 시세.
 *
 * 통근권은 **등시선**(N분 안에 실제로 닿는 영역)이다. 라우팅 엔진이 꺼져 있으면
 * 직선 반경으로 물러서되, 그 사실을 응답에 명시한다. 엔진은 개발 PC Docker 위에
 * 있어 꺼져 있는 것이 정상적인 상태 중 하나이고, 사용자에게 "직선거리다" 라고
 * 말하지 않으면 지도가 조용히 거짓말을 하게 된다.
 *
 * 사용자 좌표는 격자로 스냅한 뒤에만 쓴다. 직장 주소는 개인을 특정할 수 있는
 * 정보이고, 정확한 좌표를 로그·캐시에 남기지 않는 것이 이 프로젝트의 원칙이다.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 엔진이 없을 때 쓰는 직선 반경(m). 임의 값을 받으면 전국 스캔으로 DB를 태울 수 있다. */
const ALLOWED_RADIUS = [500, 1000, 2000, 3000, 5000, 10_000] as const;

/** 등시선을 못 쓸 때 통근 시간을 대략의 반경으로 환산한다. 이동수단별 평균 속도 기준. */
const FALLBACK_SPEED_M_PER_MIN: Record<TravelMode, number> = {
  walk: 67, // 4km/h
  transit: 250, // 15km/h (대기·환승 포함 실효 속도)
  drive: 400, // 24km/h (도심 평균)
};

const MONTHS_WINDOW = 12;
const MAX_RESULTS = 3000;
const CELL_SIZE = 500;

type Mode = 'wolse' | 'jeonse';

interface Row {
  id: string;
  name: string | null;
  housing_type: HousingType;
  sido: string | null;
  sigungu: string | null;
  legal_dong: string | null;
  lon: number;
  lat: number;
  dist_m: number;
  commute_usable: boolean;
  geo_precision: string | null;
  deals: string;
  med_deposit: string | null;
  med_rent: string | null;
  med_area: string | null;
  built_year: number | null;
  latest_ym: string | null;
}

function intParam(v: string | null, fallback: number, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function isTravelMode(v: string): v is TravelMode {
  return v === 'walk' || v === 'transit' || v === 'drive';
}

/** 반경 원을 폴리곤 GeoJSON 으로. 위도에 따른 경도 축소를 반영한다. */
function circleGeoJson(lon: number, lat: number, radiusM: number): object {
  const steps = 64;
  const dLat = radiusM / 111_320;
  const dLon = radiusM / (111_320 * Math.cos((lat * Math.PI) / 180));
  const ring: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * 2 * Math.PI;
    ring.push([lon + dLon * Math.cos(a), lat + dLat * Math.sin(a)]);
  }
  return { type: 'Polygon', coordinates: [ring] };
}

/** 등시선 시도 → 실패 시 직선 반경 폴백. 1인/2인 모드 둘 다 이 함수 하나로 처리한다. */
async function resolveArea(
  lon: number,
  lat: number,
  travel: TravelMode,
  minutes: number,
  explicitRadius: number | null,
): Promise<{ areaGeoJson: object; area: Record<string, unknown> }> {
  const cell = snapToCell(lon, lat, CELL_SIZE);

  try {
    const iso = await getIsochrone(lon, lat, travel, minutes);
    return {
      areaGeoJson: iso.polygon,
      area: {
        kind: 'isochrone',
        travel,
        minutes,
        source: iso.source, // 'cache' 면 엔진을 건드리지 않았다
      },
    };
  } catch (e) {
    if (!(e instanceof RoutingUnavailableError)) throw e;

    // 엔진이 꺼져 있다. 직선 반경으로 물러서되 사실대로 알린다.
    const explicit = ALLOWED_RADIUS.find((r) => r === explicitRadius);
    const radius = explicit ?? Math.round(minutes * FALLBACK_SPEED_M_PER_MIN[travel]);
    const clamped = Math.min(20_000, Math.max(300, radius));
    return {
      areaGeoJson: circleGeoJson(cell.lon, cell.lat, clamped),
      area: {
        kind: 'radius',
        travel,
        minutes,
        radius: clamped,
        // 클라이언트가 "직선거리 근사" 라고 표시하는 근거.
        degraded: 'routing_engine_unavailable',
      },
    };
  }
}

export async function GET(req: Request): Promise<NextResponse> {
  const limit = rateLimit(clientKey(req, 'rents'), 20, 2);
  if (!limit.ok) {
    return NextResponse.json(
      { error: 'too_many_requests' },
      { status: 429, headers: { 'Retry-After': String(limit.retryAfter) } },
    );
  }

  const p = new URL(req.url).searchParams;

  const lon = Number(p.get('lon'));
  const lat = Number(p.get('lat'));
  try {
    assertKoreanCoord(lon, lat);
  } catch {
    return NextResponse.json({ error: 'invalid_coord' }, { status: 400 });
  }

  const travelRaw = p.get('travel') ?? 'transit';
  const travel: TravelMode = isTravelMode(travelRaw) ? travelRaw : 'transit';

  let minutes: number;
  try {
    minutes = assertAllowedMinutes(Number(p.get('minutes') ?? 30));
  } catch {
    return NextResponse.json({ error: 'invalid_minutes' }, { status: 400 });
  }

  // ── 2인 모드: 같이 살 사람의 직장 좌표(선택) ────────────────────────────────
  // lon2/lat2 가 둘 다 유효할 때만 2인 모드. 개인정보 취급 원칙은 origin과 동일
  // (격자 스냅 후에만 사용, 원좌표는 응답에도 로그에도 남기지 않는다).
  const lon2Raw = p.get('lon2');
  const lat2Raw = p.get('lat2');
  let origin2: { lon: number; lat: number; travel: TravelMode; minutes: number } | null = null;
  if (lon2Raw !== null && lat2Raw !== null) {
    const lon2 = Number(lon2Raw);
    const lat2 = Number(lat2Raw);
    try {
      assertKoreanCoord(lon2, lat2);
    } catch {
      return NextResponse.json({ error: 'invalid_coord2' }, { status: 400 });
    }
    const travel2Raw = p.get('travel2') ?? 'transit';
    const travel2: TravelMode = isTravelMode(travel2Raw) ? travel2Raw : 'transit';
    let minutes2: number;
    try {
      minutes2 = assertAllowedMinutes(Number(p.get('minutes2') ?? 30));
    } catch {
      return NextResponse.json({ error: 'invalid_minutes2' }, { status: 400 });
    }
    origin2 = { lon: lon2, lat: lat2, travel: travel2, minutes: minutes2 };
  }

  const mode: Mode = p.get('mode') === 'jeonse' ? 'jeonse' : 'wolse';
  const maxDepositManwon = intParam(p.get('maxDeposit'), 0, 0, 2_000_000);
  const maxRentManwon = intParam(p.get('maxRent'), 0, 0, 100_000);
  const minArea = intParam(p.get('minArea'), 0, 0, 1000);
  const minBuiltYear = intParam(p.get('minBuiltYear'), 0, 0, 2100);

  const typesRaw = (p.get('types') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const types = typesRaw.filter((t): t is HousingType => (HOUSING_TYPES as string[]).includes(t));
  const typeFilter = types.length > 0 ? types : HOUSING_TYPES;
  const includeUnreliable = p.get('unreliable') !== '0';

  // ── 통근권 영역 결정 ──────────────────────────────────────────────────────
  const cell = snapToCell(lon, lat, CELL_SIZE);
  const explicitRadius = Number(p.get('radius'));
  const { areaGeoJson, area } = await resolveArea(lon, lat, travel, minutes, explicitRadius);

  let cell2: ReturnType<typeof snapToCell> | null = null;
  let areaGeoJson2: object | null = null;
  let area2: Record<string, unknown> | null = null;
  if (origin2) {
    cell2 = snapToCell(origin2.lon, origin2.lat, CELL_SIZE);
    const explicitRadius2 = Number(p.get('radius2'));
    const resolved2 = await resolveArea(
      origin2.lon,
      origin2.lat,
      origin2.travel,
      origin2.minutes,
      explicitRadius2,
    );
    areaGeoJson2 = resolved2.areaGeoJson;
    area2 = resolved2.area;
  }

  // 2인 모드일 때만 실제 교집합을 계산한다. 1인 모드는 지금과 완전히 동일하게
  // 동작해야 하므로(회귀 위험 최소화) 이 라운드트립 자체를 건너뛴다.
  let filterGeoJson = areaGeoJson;
  let intersectionGeoJson: object | null = null;
  let intersectionEmpty = false;
  if (areaGeoJson2) {
    const intRow = await query<{ geojson: string | null; empty: boolean }>(
      `SELECT ST_AsGeoJSON(ST_Intersection(a1.g, a2.g)) AS geojson,
              ST_IsEmpty(ST_Intersection(a1.g, a2.g)) AS empty
         FROM (SELECT ST_SetSRID(ST_GeomFromGeoJSON($1), 4326) AS g) a1,
              (SELECT ST_SetSRID(ST_GeomFromGeoJSON($2), 4326) AS g) a2`,
      [JSON.stringify(areaGeoJson), JSON.stringify(areaGeoJson2)],
    );
    const row = intRow[0];
    intersectionEmpty = row?.empty ?? true;
    intersectionGeoJson = row?.geojson ? (JSON.parse(row.geojson) as object) : null;
    filterGeoJson = intersectionGeoJson ?? areaGeoJson;
  }

  // 교집합이 없으면 건물 조회 자체가 무의미하다 — 조인 비용을 아끼고 바로 반환.
  if (intersectionEmpty) {
    return NextResponse.json(
      {
        origin: { lon: cell.lon, lat: cell.lat },
        origin2: cell2 ? { lon: cell2.lon, lat: cell2.lat } : undefined,
        area: { ...area, geojson: areaGeoJson },
        area2: area2 ? { ...area2, geojson: areaGeoJson2 } : undefined,
        intersection: null,
        intersectionEmpty: true,
        mode,
        window: { sinceYm: monthsAgo(MONTHS_WINDOW), months: MONTHS_WINDOW },
        truncated: false,
        count: 0,
        buildings: [],
      },
      { headers: { 'Cache-Control': 'no-store, private' } },
    );
  }

  try {
    const rows = await query<Row>(
      `WITH origin AS (
         SELECT ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography AS g
       ),
       area AS (
         -- 1인 모드면 본인 통근권 폴리곤, 2인 모드면 두 사람 통근권의 교집합
         -- (filterGeoJson — 위에서 이미 계산됨). 어느 쪽이든 여기서는 폴리곤
         -- 하나일 뿐이라 쿼리가 갈라지지 않는다.
         SELECT ST_SetSRID(ST_GeomFromGeoJSON($3), 4326)::geography AS g
       ),
       nearby AS (
         -- 위 area 폴리곤 안의 건물. 점 대 폴리곤이므로 ST_Intersects 가
         -- GiST 인덱스를 그대로 쓴다.
         SELECT b.id, b.name, b.housing_type, b.legal_dong, b.built_year,
                b.commute_usable, b.geo_precision, b.geom,
                r.sido, r.sigungu,
                ST_Distance(b.geom, o.g) AS dist_m
           FROM building b, area a, origin o, region_code r
          WHERE b.geom IS NOT NULL
            AND r.code = b.region_code
            AND ST_Intersects(b.geom, a.g)
            AND b.housing_type = ANY($4::text[])
            AND ($5::boolean OR b.commute_usable)
            AND ($12::int = 0 OR b.built_year >= $12)
       )
       SELECT n.id, n.name, n.housing_type, n.legal_dong, n.built_year,
              n.commute_usable, n.geo_precision, n.sido, n.sigungu,
              ST_X(n.geom::geometry) AS lon,
              ST_Y(n.geom::geometry) AS lat,
              round(n.dist_m)                                    AS dist_m,
              count(*)                                           AS deals,
              -- 중앙값을 쓴다. 평균은 이상치 한 건에 크게 흔들린다.
              percentile_cont(0.5) WITHIN GROUP (ORDER BY d.deposit)      AS med_deposit,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY d.monthly_rent) AS med_rent,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY d.area)         AS med_area,
              max(d.deal_ym)                                     AS latest_ym
         FROM nearby n
         JOIN rent_deal d ON d.building_id = n.id
        WHERE d.deal_ym >= $6
          AND ($7::text = 'jeonse') = (d.monthly_rent = 0)
          AND ($8::bigint = 0 OR d.deposit <= $8)
          AND ($9::bigint = 0 OR d.monthly_rent <= $9)
          AND ($10::numeric = 0 OR d.area >= $10)
        GROUP BY n.id, n.name, n.housing_type, n.legal_dong, n.built_year,
                 n.commute_usable, n.geo_precision, n.sido, n.sigungu, n.geom, n.dist_m
        ORDER BY n.dist_m
        LIMIT $11`,
      [
        cell.lon, cell.lat, JSON.stringify(filterGeoJson),
        typeFilter, includeUnreliable,
        monthsAgo(MONTHS_WINDOW), mode,
        maxDepositManwon * 10_000, maxRentManwon * 10_000, minArea,
        MAX_RESULTS, minBuiltYear,
      ],
    );

    return NextResponse.json(
      {
        origin: { lon: cell.lon, lat: cell.lat },
        origin2: cell2 ? { lon: cell2.lon, lat: cell2.lat } : undefined,
        area: { ...area, geojson: areaGeoJson },
        area2: area2 ? { ...area2, geojson: areaGeoJson2 } : undefined,
        intersection: intersectionGeoJson,
        intersectionEmpty: false,
        mode,
        window: { sinceYm: monthsAgo(MONTHS_WINDOW), months: MONTHS_WINDOW },
        truncated: rows.length >= MAX_RESULTS,
        count: rows.length,
        buildings: rows.map((r) => ({
          id: Number(r.id),
          name: r.name,
          type: r.housing_type,
          sido: r.sido,
          sigungu: r.sigungu,
          dong: r.legal_dong,
          lon: r.lon,
          lat: r.lat,
          distM: Number(r.dist_m),
          // 만원 단위로 내려보낸다. 클라이언트에서 다시 나누지 않게 한다.
          deposit: r.med_deposit === null ? null : Math.round(Number(r.med_deposit) / 10_000),
          rent: r.med_rent === null ? null : Math.round(Number(r.med_rent) / 10_000),
          area: r.med_area === null ? null : Math.round(Number(r.med_area) * 10) / 10,
          deals: Number(r.deals),
          builtYear: r.built_year,
          latestYm: r.latest_ym,
          // false 면 통근시간을 표시하지 않는다. 지도가 거짓말하지 않게 하는 핵심 플래그.
          commuteUsable: r.commute_usable,
          precision: r.geo_precision,
        })),
      },
      { headers: { 'Cache-Control': 'no-store, private' } },
    );
  } catch (e) {
    console.error('rents query failed:', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'query_failed' }, { status: 500 });
  }
}

function monthsAgo(n: number): string {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth() - n, 1);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
}
