import { NextResponse } from 'next/server';
import { geocode, searchPlaces } from '../../../src/lib/geocode';
import { clientKey, rateLimit } from '../../../src/lib/rate-limit';
import { clean } from '../../../src/lib/text';

/**
 * 주소/장소 검색 프록시.
 *
 * 이 라우트가 존재하는 이유는 **Kakao REST 키를 클라이언트로 내보내지 않는
 * 것**이다. 브라우저에서 직접 호출하면 개발자 도구에 키가 노출되고, 도메인
 * 제한이 없는 REST 키는 그대로 남용될 수 있다. SECURITY.md 5장의 규칙이다.
 *
 * 부수 효과로 지오코딩 캐시(DB)가 공유되어 Kakao 쿼터를 아낀다.
 */
export const runtime = 'nodejs'; // pg 와 dns 를 쓰므로 edge 런타임이 아니다
export const dynamic = 'force-dynamic';

const MAX_QUERY_LEN = 100;

export async function GET(req: Request): Promise<NextResponse> {
  // 지오코딩은 외부 쿼터를 소비한다. 검색창 입력이라 버스트는 허용하되
  // 지속적인 연타는 막는다.
  const limit = rateLimit(clientKey(req, 'geocode'), 10, 1);
  if (!limit.ok) {
    return NextResponse.json(
      { error: 'too_many_requests' },
      { status: 429, headers: { 'Retry-After': String(limit.retryAfter) } },
    );
  }

  const q = clean(new URL(req.url).searchParams.get('q'), MAX_QUERY_LEN);
  if (!q || q.length < 2) {
    return NextResponse.json({ error: 'query_too_short' }, { status: 400 });
  }

  try {
    // 부산+인근 통근권 bbox로 제한한 후보 목록을 먼저 찾는다 — "동우기업"처럼
    // 흔한 상호가 서비스 커버리지 밖(예: 서울)에서 먼저 잡히는 것을 막는다.
    const candidates = await searchPlaces(q);
    if (candidates.length > 0) {
      return NextResponse.json({ candidates }, { headers: noStore() });
    }

    // bbox 안에 후보가 없으면 전국 단위 단일 결과로 물러선다(정확한 주소를
    // 직접 입력한 경우 등). 도보/자차(ORS)는 전국 커버라 완전히 무의미하지 않다.
    const hit = await geocode(q);
    if (!hit) {
      return NextResponse.json({ candidates: [] }, { headers: noStore() });
    }

    return NextResponse.json(
      {
        candidates: [
          { name: q, address: hit.address, lon: hit.lon, lat: hit.lat, sido: hit.sido, sigungu: hit.sigungu },
        ],
      },
      { headers: noStore() },
    );
  } catch {
    // 예외 내용을 클라이언트로 흘리지 않는다. 서버 로그에도 키가 섞이지
    // 않도록 geocode 내부에서 이미 마스킹 처리한다.
    return NextResponse.json({ error: 'geocode_failed' }, { status: 502 });
  }
}

/** 검색 결과는 사용자의 직장 주소다. 중간 캐시에 남지 않게 한다. */
function noStore(): Record<string, string> {
  return { 'Cache-Control': 'no-store, private' };
}
