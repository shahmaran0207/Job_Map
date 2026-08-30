import { assertKoreanCoord, safeFetch, stripDangerousKeys } from './security';
import { one, query } from './db';
import { clean } from './text';
import { env } from './env';

export interface GeoResult {
  lon: number;
  lat: number;
  address: string | null;
  regionCode: string | null;
  sido: string | null;
  sigungu: string | null;
  /** building > road > sigungu > sido. 통근시간 계산의 신뢰도를 좌우한다. */
  precision: 'building' | 'road' | 'sigungu' | 'sido' | 'unknown';
  provider: 'kakao_address' | 'kakao_keyword' | 'cache';
}

/**
 * 주소 -> 좌표. 캐시 우선.
 *
 * 1) 주소 검색: 정식 주소가 있을 때 가장 정확하다.
 * 2) 키워드 검색: '삼성전자 부산지사' 처럼 주소가 아니라 사업장 이름만 있을 때.
 *    공고에 근무지 주소가 없는 케이스가 태반이므로 이 폴백이 커버리지를 크게 올린다.
 */
export async function geocode(rawQuery: string): Promise<GeoResult | null> {
  // 캐시 PK 가 되므로 길이를 제한한다. clean() 이 태그·제어문자도 함께 제거한다.
  const q = clean(rawQuery, 300);
  if (!q) return null;

  const cached = await one<{
    lon: number; lat: number; address: string | null; region_code: string | null;
    sido: string | null; sigungu: string | null; precision: string | null;
  }>(
    `UPDATE geocode_cache SET hit_count = hit_count + 1
      WHERE query = $1
      RETURNING ST_X(geom::geometry) AS lon, ST_Y(geom::geometry) AS lat,
                address, region_code, sido, sigungu, precision`,
    [q],
  );
  if (cached) {
    if (cached.lon === null) return null; // 실패도 캐시한다 (재시도 낭비 방지)
    return {
      lon: cached.lon, lat: cached.lat, address: cached.address,
      regionCode: cached.region_code, sido: cached.sido, sigungu: cached.sigungu,
      precision: (cached.precision as GeoResult['precision']) ?? 'unknown',
      provider: 'cache',
    };
  }

  if (!env.kakaoRestKey) return null;

  // 여기서 예외가 나면(쿼터 소진·네트워크 장애) 캐시에 쓰지 않고 그대로 던진다.
  // 일시적 실패를 '주소 없음'으로 캐시하면 영구 오염이 된다. 아래 주석 참고.
  const hit = (await kakaoAddress(q)) ?? (await kakaoKeyword(q));
  const validated = validate(hit);
  await cachePut(q, validated);
  return validated;
}

/**
 * 지오코딩을 일시적으로 수행할 수 없는 상태.
 *
 * 쿼터 소진이나 네트워크 장애를 '주소 없음' 과 구별하기 위해 존재한다. 이 둘을
 * 섞으면 대규모 배치에서 치명적이다. 7만 건을 돌리다 쿼터가 끊기면 남은 전부가
 * miss 로 **영구 캐시**되고, 재실행해도 캐시가 먼저 걸려 되살릴 수 없다.
 *
 * 그래서 이 예외는 캐시하지 않고 위로 던진다. 배치 스크립트는 이걸 받으면
 * 나머지를 오염시키지 않고 중단해야 한다.
 */
export class GeocodeUnavailableError extends Error {
  constructor(reason: string) {
    super(`지오코딩을 일시적으로 수행할 수 없습니다: ${reason}`);
    this.name = 'GeocodeUnavailableError';
  }
}

/**
 * 응답 좌표를 검증한다. 외부 API 가 이상값을 주거나 파싱이 틀리면 지도에
 * 엉뚱한 위치의 공고가 뜨고, 그 좌표로 라우팅 엔진까지 태우게 된다.
 */
function validate(hit: GeoResult | null): GeoResult | null {
  if (!hit) return null;
  try {
    assertKoreanCoord(hit.lon, hit.lat);
    return hit;
  } catch {
    return null;
  }
}

async function cachePut(q: string, hit: GeoResult | null): Promise<void> {
  if (!hit) {
    await query(
      `INSERT INTO geocode_cache (query, geom, provider) VALUES ($1, NULL, 'miss')
         ON CONFLICT (query) DO NOTHING`,
      [q],
    );
    return;
  }
  await query(
    `INSERT INTO geocode_cache (query, geom, address, region_code, sido, sigungu, precision, provider)
     VALUES ($1, ST_SetSRID(ST_MakePoint($2,$3),4326)::geography, $4,$5,$6,$7,$8,$9)
       ON CONFLICT (query) DO NOTHING`,
    [q, hit.lon, hit.lat, hit.address, hit.regionCode, hit.sido, hit.sigungu, hit.precision, hit.provider],
  );
}

const KAKAO_HOST = 'dapi.kakao.com';

/**
 * Kakao 호출.
 *
 * 성공하면 파싱된 JSON 을 돌려준다. 재시도를 소진하면 **예외를 던진다**.
 * null 을 돌려주면 호출부가 '주소 없음' 과 구별할 수 없고, 그 결과가 캐시에
 * 영구 저장되어 되살릴 수 없게 된다.
 */
async function kakaoFetch(path: string, params: Record<string, string>): Promise<any> {
  const url = new URL(`https://${KAKAO_HOST}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  let lastReason = 'unknown';

  for (let i = 0; i < 3; i++) {
    try {
      const res = await safeFetch(url, {
        // REST 키가 Authorization 헤더로 나가므로 호스트를 고정한다.
        // 리다이렉트를 허용하면 키가 제3자 호스트로 전달될 수 있어 0 으로 둔다.
        allowHosts: [KAKAO_HOST],
        maxRedirects: 0,
        maxBytes: 1024 * 1024,
        timeoutMs: 15_000,
        headers: { Authorization: `KakaoAK ${env.kakaoRestKey}` },
      });

      if (res.status === 200) return stripDangerousKeys(JSON.parse(res.text));

      // 429 = 쿼터/속도 초과, 401·403 = 키 문제. 둘 다 '주소 없음' 이 아니다.
      lastReason = `HTTP ${res.status}`;
      if (res.status === 401 || res.status === 403) {
        throw new GeocodeUnavailableError(`${lastReason} (KAKAO_REST_KEY 확인 필요)`);
      }
      await sleep(2000 * (i + 1));
    } catch (e) {
      if (e instanceof GeocodeUnavailableError) throw e;
      // 에러 본문에 키가 섞일 수 있어 내용을 로그에 남기지 않는다.
      lastReason = 'network';
      await sleep(500 * (i + 1));
    }
  }

  throw new GeocodeUnavailableError(lastReason);
}

async function kakaoAddress(q: string): Promise<GeoResult | null> {
  const json = await kakaoFetch('/v2/local/search/address.json', { query: q, size: '1' });
  const doc = json?.documents?.[0];
  if (!doc) return null;

  const road = doc.road_address;
  const jibun = doc.address;
  const src = road ?? jibun;
  if (!src) return null;

  return {
    lon: Number(doc.x),
    lat: Number(doc.y),
    address: clean(road?.address_name ?? jibun?.address_name),
    regionCode: clean(jibun?.b_code ?? road?.zone_no),
    sido: clean(src.region_1depth_name),
    sigungu: clean(src.region_2depth_name),
    // 건물번호가 있으면 건물 단위, 없으면 도로/행정구역 단위로 강등한다.
    precision: road?.building_name || jibun?.main_address_no ? 'building'
             : road ? 'road'
             : src.region_2depth_name ? 'sigungu' : 'sido',
    provider: 'kakao_address',
  };
}

async function kakaoKeyword(q: string): Promise<GeoResult | null> {
  const json = await kakaoFetch('/v2/local/search/keyword.json', { query: q, size: '1' });
  const doc = json?.documents?.[0];
  if (!doc) return null;

  const addr = clean(doc.road_address_name ?? doc.address_name);
  const parts = (addr ?? '').split(' ');
  return {
    lon: Number(doc.x),
    lat: Number(doc.y),
    address: addr,
    regionCode: null,
    sido: parts[0] ?? null,
    sigungu: parts[1] ?? null,
    precision: 'building',
    provider: 'kakao_keyword',
  };
}

/** 주소가 '서울 강남구' 수준일 때 좌표를 믿을 수 있는 정도. 통근시간 표시 여부를 가른다. */
export function confidenceOf(p: GeoResult['precision']): number {
  switch (p) {
    case 'building': return 0.95;
    case 'road': return 0.8;
    case 'sigungu': return 0.4;
    case 'sido': return 0.15;
    default: return 0;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
