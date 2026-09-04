import type { HousingType } from '../../src/collectors/molit-types';

/** /api/rents 응답의 건물 한 건. 금액은 만원 단위. */
export interface BuildingPoint {
  id: number;
  name: string | null;
  type: HousingType;
  sido: string | null;
  sigungu: string | null;
  dong: string | null;
  lon: number;
  lat: number;
  distM: number;
  deposit: number | null;
  rent: number | null;
  area: number | null;
  deals: number;
  builtYear: number | null;
  latestYm: string | null;
  /** false 면 좌표 정밀도가 낮아 통근 계산에 쓸 수 없다. */
  commuteUsable: boolean;
  precision: string | null;
}

export type TravelMode = 'walk' | 'transit' | 'drive';

/**
 * 검색에 사용된 영역.
 *
 * `kind: 'radius'` 는 라우팅 엔진을 쓸 수 없어 직선거리로 물러선 상태다.
 * 이 구분을 화면에 반드시 표시해야 한다. 표시하지 않으면 사용자는 실제 통근
 * 시간이라고 믿는데 지도는 직선거리를 보여주는 셈이 된다.
 */
export interface AreaInfo {
  kind: 'isochrone' | 'radius';
  travel: TravelMode;
  minutes: number;
  /** kind === 'radius' 일 때만 */
  radius?: number;
  /** kind === 'isochrone' 일 때만. 'cache' 면 엔진을 건드리지 않았다 */
  source?: 'cache' | 'engine';
  degraded?: string;
  geojson: GeoJSON.Polygon | GeoJSON.MultiPolygon;
}

export interface RentsResponse {
  origin: { lon: number; lat: number };
  area: AreaInfo;
  mode: 'wolse' | 'jeonse';
  window: { sinceYm: string; months: number };
  truncated: boolean;
  count: number;
  buildings: BuildingPoint[];
}

export const TRAVEL_LABEL: Record<TravelMode, string> = {
  walk: '도보',
  transit: '대중교통',
  drive: '자차',
};

/** 허용 통근 시간. 서버의 assertAllowedMinutes 와 일치해야 한다. */
export const MINUTE_OPTIONS = [10, 15, 20, 30, 45, 60, 90] as const;

export interface GeocodeResponse {
  found: boolean;
  lon?: number;
  lat?: number;
  address?: string | null;
  sido?: string | null;
  sigungu?: string | null;
  precision?: string;
}

export interface Filters {
  travel: TravelMode;
  minutes: number;
  mode: 'wolse' | 'jeonse';
  /** 만원 단위. 0 = 제한 없음 */
  maxDeposit: number;
  maxRent: number;
  minArea: number;
  types: HousingType[];
  includeUnreliable: boolean;
}

export const DEFAULT_FILTERS: Filters = {
  travel: 'transit',
  minutes: 30,
  mode: 'wolse',
  maxDeposit: 0,
  maxRent: 0,
  minArea: 0,
  types: ['apt', 'offi', 'rh', 'sh'],
  includeUnreliable: true,
};

export const HOUSING_LABEL_SHORT: Record<HousingType, string> = {
  apt: '아파트',
  offi: '오피스텔',
  rh: '연립·다세대',
  sh: '단독·다가구',
};

/** 만원 단위 금액을 사람이 읽는 형태로. 1억 이상은 억 단위로 접는다. */
export function formatManwon(v: number | null): string {
  if (v === null) return '-';
  if (v >= 10_000) {
    const eok = v / 10_000;
    return `${eok % 1 === 0 ? eok.toFixed(0) : eok.toFixed(1)}억`;
  }
  return `${v.toLocaleString('ko-KR')}만`;
}

/** ㎡ → 평. 한국에서는 평이 직관적이다. */
export function toPyeong(sqm: number | null): string {
  if (sqm === null) return '-';
  return `${Math.round(sqm / 3.3058)}평`;
}
