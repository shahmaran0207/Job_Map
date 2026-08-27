import { confidenceOf, geocode, type GeoResult } from './geocode.ts';
import { clean } from './text.ts';

/**
 * 근무지 좌표 확정.
 *
 * 이 모듈이 제품의 성립 조건이다. 이유:
 *
 * 사람인 API 는 근무지를 시군구 해상도로만 준다("서울 > 관악구"). 시군구
 * 중심점으로 통근시간을 계산하면 관악구만 해도 동서 5km 오차가 생기고,
 * "도보 30분 이내" 필터가 의미를 잃는다. 워크넷도 상세주소가 없는 공고가 많다.
 *
 * 그래서 시군구를 건물 단위로 끌어올리는 것이 핵심 과제다. 핵심 착안점은
 * **회사명 + 시군구 키워드 검색**이다. '카카오 판교', '삼성전자 수원' 처럼
 * 상호와 지역을 함께 검색하면 실제 사업장 건물이 잡힌다. 지사·공장도 이 경로로
 * 상당 부분 해결된다.
 *
 * 그리고 얻은 좌표를 통근 계산에 써도 되는지를 데이터에 명시한다. 정확도 낮은
 * 좌표로 통근시간을 계산해 보여주면 지도가 조용히 거짓말을 하게 된다.
 */

export type ResolveStrategy = 'address' | 'company_region' | 'company' | 'region_centroid';

export interface ResolveInput {
  companyName: string;
  /** 공고에 적힌 주소 원문. 상세주소일 수도, '서울 관악구' 수준일 수도 있다. */
  rawAddress: string | null;
  /** '서울 > 관악구' 같은 지역 표기 */
  regionHint: string | null;
}

export interface Resolution {
  lon: number;
  lat: number;
  address: string | null;
  regionCode: string | null;
  sido: string | null;
  sigungu: string | null;
  precision: GeoResult['precision'];
  confidence: number;
  strategy: ResolveStrategy;
  /** 실제로 사용한 질의문. 재현성과 오류 추적용. */
  query: string;
  /** 이 좌표로 통근시간을 계산해도 되는가 */
  commuteUsable: boolean;
}

/** 통근 계산을 허용할 최소 신뢰도. road(0.8) 이상만 통과한다. */
const COMMUTE_THRESHOLD = 0.8;

/** 이 값 이상이면 더 나은 전략을 시도하지 않고 확정한다. */
const GOOD_ENOUGH = 0.95;

export async function resolveWorksite(input: ResolveInput): Promise<Resolution | null> {
  const company = clean(input.companyName, 100);
  if (!company) return null;

  const region = parseRegion(input.rawAddress ?? input.regionHint);
  const hasDetailedAddress = looksDetailed(input.rawAddress);

  // 전략 순서가 중요하다. 상세주소가 있으면 그것이 가장 정확하고,
  // 없으면 회사명+지역 키워드 검색이 시군구를 건물로 승격시킨다.
  const candidates: { strategy: ResolveStrategy; query: string }[] = [];

  if (hasDetailedAddress && input.rawAddress) {
    candidates.push({ strategy: 'address', query: input.rawAddress });
  }
  if (region.full) {
    candidates.push({ strategy: 'company_region', query: `${company} ${region.full}` });
  }
  if (region.sigungu) {
    candidates.push({ strategy: 'company_region', query: `${company} ${region.sigungu}` });
  }
  candidates.push({ strategy: 'company', query: company });

  let best: Resolution | null = null;

  for (const c of candidates) {
    const hit = await geocode(c.query);
    if (!hit) continue;

    // 지역 정보가 있으면 결과가 그 지역에 있는지 검증한다.
    // 검증 없이 받으면 동명 회사의 다른 지역 사업장을 잡는다.
    if (region.sigungu && hit.sigungu && !sameRegion(region, hit)) continue;

    const resolution = toResolution(hit, c.strategy, c.query);
    if (!best || resolution.confidence > best.confidence) best = resolution;
    if (resolution.confidence >= GOOD_ENOUGH) break;
  }

  if (best) return best;

  // 마지막 폴백: 시군구 중심점. 지도 표시는 되지만 통근 계산에는 쓰지 않는다.
  if (region.full) {
    const hit = await geocode(region.full);
    if (hit) {
      const fallback = toResolution(hit, 'region_centroid', region.full);
      // 전략이 중심점이면 정밀도를 강제로 강등한다. Kakao 가 시군구 질의에
      // building 정밀도를 돌려주는 경우가 있어(예: 구청사) 그대로 믿으면 안 된다.
      return { ...fallback, precision: 'sigungu', confidence: 0.4, commuteUsable: false };
    }
  }

  return null;
}

function toResolution(hit: GeoResult, strategy: ResolveStrategy, query: string): Resolution {
  const confidence = confidenceOf(hit.precision);
  return {
    lon: hit.lon,
    lat: hit.lat,
    address: hit.address,
    regionCode: hit.regionCode,
    sido: hit.sido,
    sigungu: hit.sigungu,
    precision: hit.precision,
    confidence,
    strategy,
    query,
    commuteUsable: confidence >= COMMUTE_THRESHOLD,
  };
}

// ── 지역 표기 파싱 ──────────────────────────────────────────────────────────
export interface Region {
  sido: string | null;
  sigungu: string | null;
  /** 검색에 쓸 '시도 시군구' 형태 */
  full: string | null;
}

/**
 * '서울 > 관악구', '서울특별시 강남구 테헤란로 152', '경기 성남시 분당구' 등을
 * 시도/시군구로 정규화한다. 소스별 표기가 달라 여기서 흡수한다.
 */
export function parseRegion(text: string | null | undefined): Region {
  const s = clean(text, 200);
  if (!s) return { sido: null, sigungu: null, full: null };

  // 사람인은 '서울 > 관악구' 형태로 준다
  const normalized = s.replace(/\s*>\s*/g, ' ').replace(/\s+/g, ' ').trim();
  const tokens = normalized.split(' ');

  const sido = tokens[0] ?? null;
  if (!sido) return { sido: null, sigungu: null, full: null };

  // 시군구 토큰: 시/군/구 로 끝나는 첫 토큰.
  // '성남시 분당구' 처럼 두 단계인 경우 둘을 합쳐야 정확도가 올라간다.
  const parts: string[] = [];
  for (let i = 1; i < Math.min(tokens.length, 4); i++) {
    const t = tokens[i]!;
    if (/(시|군|구)$/.test(t)) {
      parts.push(t);
      // 광역시가 아닌 도의 '○○시 ○○구' 조합만 두 개까지 허용한다
      if (parts.length === 2) break;
      continue;
    }
    break;
  }

  const sigungu = parts.length ? parts.join(' ') : null;
  return {
    sido,
    sigungu,
    full: sigungu ? `${sido} ${sigungu}` : sido,
  };
}

/** 지오코딩 결과가 기대한 지역에 있는지 확인한다. 동명 회사의 타지역 사업장을 배제한다. */
function sameRegion(expected: Region, hit: GeoResult): boolean {
  if (!expected.sigungu || !hit.sigungu) return true; // 비교 불가면 통과
  const a = shortSido(expected.sido);
  const b = shortSido(hit.sido);
  if (a && b && a !== b) return false;

  // '성남시 분당구' vs '분당구' 처럼 표기가 달라 부분 일치로 본다.
  const exp = expected.sigungu.replace(/\s/g, '');
  const got = hit.sigungu.replace(/\s/g, '');
  return exp.includes(got) || got.includes(exp);
}

/** '서울특별시' / '서울' 을 같게 본다. */
function shortSido(sido: string | null): string | null {
  if (!sido) return null;
  return sido.replace(/(특별자치시|특별자치도|특별시|광역시|자치시|자치도|도|시)$/, '') || sido;
}

/**
 * 주소가 도로명·번지 수준인지 판단한다.
 * '서울 관악구' 처럼 시군구까지만이면 주소 검색을 시도할 가치가 없고,
 * 회사명+지역 키워드 검색이 훨씬 나은 결과를 준다.
 */
export function looksDetailed(address: string | null | undefined): boolean {
  const s = clean(address, 200);
  if (!s) return false;
  // 도로명(로/길) + 번호, 또는 번지 형태가 있으면 상세주소로 본다
  if (/(로|길)\s*\d/.test(s)) return true;
  if (/\d+-\d+/.test(s)) return true;
  if (/(읍|면|동|가)\s*\d/.test(s)) return true;
  // 토큰이 4개 이상이면 상세주소일 가능성이 높다 ('서울특별시 강남구 역삼동 737')
  return s.split(/\s+/).length >= 4;
}
