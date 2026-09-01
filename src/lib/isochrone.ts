import { one, query } from './db';
import { snapToCell, type GridCell } from './grid';
import { isochrone as computeIsochrone, type IsochronePolygon, type TravelMode } from './routing';

/**
 * 등시선 조회 계층.
 *
 * `routing.ts` 가 엔진을 호출한다면 여기는 **캐시와 실패 처리**를 맡는다.
 *
 * 캐시가 이 프로젝트의 비용 구조를 지탱한다. 출발지를 격자에 스냅해
 * `(격자, 모드, 분)` 키로 폴리곤을 영구 저장하면, 같은 동네의 두 번째 사용자부터는
 * 엔진을 아예 호출하지 않는다. 엔진이 꺼져 있어도 캐시된 지역은 계속 서비스된다.
 *
 * 격자 스냅은 개인정보 보호도 겸한다. 사용자가 입력하는 직장 주소는 개인을
 * 특정할 수 있는 정보이고, 캐시 키에서 원좌표가 복원되지 않아야 한다.
 * 500m 격자는 30분 통근권 계산에 사실상 영향이 없다.
 */
const CELL_SIZE = 500;

/**
 * 라우팅 엔진을 지금 쓸 수 없는 상태.
 *
 * 이 프로젝트에서 엔진은 개발 PC의 Docker 위에 있다(무료 티어에 안 들어간다).
 * 즉 **꺼져 있는 것이 정상적인 상태 중 하나**다. 그래서 이걸 장애로 취급해
 * 500 을 던지지 않고, 호출부가 직선 반경으로 물러설 수 있게 구별한다.
 */
export class RoutingUnavailableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'RoutingUnavailableError';
  }
}

export interface IsochroneResult {
  cell: GridCell;
  polygon: IsochronePolygon;
  /** 'cache' 면 엔진을 건드리지 않았다는 뜻이다. */
  source: 'cache' | 'engine';
}

/**
 * 등시선을 얻는다. 캐시 우선, 없으면 엔진 호출 후 저장.
 *
 * 엔진을 쓸 수 없으면 RoutingUnavailableError 를 던진다. 호출부가 직선 반경으로
 * 물러설지 실패로 처리할지 결정한다.
 */
export async function getIsochrone(
  lon: number,
  lat: number,
  mode: TravelMode,
  minutes: number,
): Promise<IsochroneResult> {
  const cell = snapToCell(lon, lat, CELL_SIZE);

  const cached = await one<{ geojson: string }>(
    `SELECT ST_AsGeoJSON(geom::geometry) AS geojson
       FROM isochrone_cache
      WHERE cell_key = $1 AND mode = $2 AND minutes = $3`,
    [cell.key, mode, minutes],
  );

  if (cached?.geojson) {
    return { cell, polygon: JSON.parse(cached.geojson) as IsochronePolygon, source: 'cache' };
  }

  let polygon: IsochronePolygon;
  try {
    // 격자 중심으로 계산한다. 원좌표는 엔진에도 넘기지 않는다.
    polygon = await computeIsochrone(cell.lon, cell.lat, mode, minutes);
  } catch (e) {
    throw new RoutingUnavailableError(e instanceof Error ? e.message : String(e));
  }

  // 저장 실패가 조회를 실패시키지 않도록 한다. 캐시는 최적화이지 정확성이 아니다.
  try {
    await query(
      `INSERT INTO isochrone_cache (cell_key, mode, minutes, geom, engine)
       VALUES ($1, $2, $3, ST_SetSRID(ST_GeomFromGeoJSON($4), 4326)::geography, $5)
         ON CONFLICT (cell_key, mode, minutes) DO NOTHING`,
      [cell.key, mode, minutes, JSON.stringify(polygon), mode === 'transit' ? 'otp2' : 'valhalla'],
    );
  } catch (e) {
    console.error('등시선 캐시 저장 실패(무시하고 진행):', e instanceof Error ? e.message : e);
  }

  return { cell, polygon, source: 'engine' };
}

/** 캐시 현황. 엔진이 꺼져 있어도 어느 지역이 서비스되는지 파악하는 데 쓴다. */
export async function isochroneCacheStats(): Promise<
  { mode: string; minutes: number; cells: number }[]
> {
  const rows = await query<{ mode: string; minutes: number; cells: string }>(
    `SELECT mode, minutes, count(*) AS cells
       FROM isochrone_cache GROUP BY mode, minutes ORDER BY mode, minutes`,
  );
  return rows.map((r) => ({ mode: r.mode, minutes: r.minutes, cells: Number(r.cells) }));
}
