import { env } from './env.ts';
import { one, query } from './db.ts';
import { assertKoreanCoord, safeFetch, stripDangerousKeys } from './security.ts';
import { clean } from './text.ts';

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

  const hit = (await kakaoAddress(q)) ?? (await kakaoKeyword(q));
  const validated = validate(hit);
  await cachePut(q, validated);
  return validated;
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

async function kakaoFetch(path: string, params: Record<string, string>): Promise<any | null> {
  const url = new URL(`https://${KAKAO_HOST}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

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
      if (res.status === 429) {
        await sleep(2000 * (i + 1)); // 쿼터 초과: 잠시 물러난다
        continue;
      }
      if (res.status !== 200) return null;
      return stripDangerousKeys(JSON.parse(res.text));
    } catch {
      // 에러 본문에 키가 섞일 수 있어 내용을 로그에 남기지 않는다.
      await sleep(500 * (i + 1));
    }
  }
  return null;
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
