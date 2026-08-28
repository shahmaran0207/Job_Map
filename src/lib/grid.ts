import { assertKoreanCoord } from './security';

/**
 * 격자 스냅.
 *
 * 두 가지 목적을 동시에 해결한다.
 *
 * 1) 비용 — 등시선을 `(격자, 모드, 분)` 키로 캐시하면 같은 동네의 두 번째
 *    사용자부터 라우팅 엔진을 호출하지 않는다.
 *
 * 2) 개인정보 — 사용자가 입력하는 출발지는 사실상 '집 주소'다. 개인정보보호법상
 *    민감한 위치정보이며, 정확한 좌표를 그대로 저장하거나 로그에 남기면
 *    유출 시 피해가 크다. 그래서 이 프로젝트의 원칙은:
 *
 *      - 사용자 좌표는 **격자로 스냅한 뒤에만** 저장·캐시·로깅한다
 *      - 원좌표는 요청 처리 중 메모리에서만 쓰고 어디에도 남기지 않는다
 *      - 등시선 캐시는 격자 중심 기준이므로 특정 개인의 집을 역추적할 수 없다
 */

/** 격자 한 변의 대략 길이(m). 도심은 촘촘하게, 지방은 넓게 가져가도 된다. */
export type GridSize = 250 | 500 | 1000 | 2000;

/** 위도 1도 ≈ 111km. 경도 1도는 위도에 따라 줄어들지만 한국 범위에서는 근사로 충분하다. */
const METERS_PER_DEG_LAT = 111_000;
const METERS_PER_DEG_LON_KR = 88_000; // 위도 37도 부근

export interface GridCell {
  /** 캐시 키. 원좌표가 복원되지 않는다. */
  key: string;
  /** 격자 중심 좌표. 라우팅 엔진에는 이 값을 넘긴다. */
  lon: number;
  lat: number;
  size: GridSize;
}

export function snapToCell(lon: number, lat: number, size: GridSize = 500): GridCell {
  assertKoreanCoord(lon, lat);

  const stepLat = size / METERS_PER_DEG_LAT;
  const stepLon = size / METERS_PER_DEG_LON_KR;

  const iLat = Math.floor(lat / stepLat);
  const iLon = Math.floor(lon / stepLon);

  // 격자 중심을 쓴다. 격자 경계를 쓰면 인접 격자와 결과가 갈려 캐시 적중률이 떨어진다.
  const cellLat = (iLat + 0.5) * stepLat;
  const cellLon = (iLon + 0.5) * stepLon;

  return {
    key: `g${size}:${iLon}:${iLat}`,
    lon: Number(cellLon.toFixed(6)),
    lat: Number(cellLat.toFixed(6)),
    size,
  };
}

/**
 * 사용자 좌표를 로그에 남길 때 쓴다. 격자 키만 남기고 원좌표는 버린다.
 * 좌표를 직접 console.log 하는 코드는 리뷰에서 반려한다.
 */
export function logSafeLocation(lon: number, lat: number, size: GridSize = 2000): string {
  try {
    return snapToCell(lon, lat, size).key;
  } catch {
    return 'invalid';
  }
}
