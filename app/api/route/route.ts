import { NextResponse } from 'next/server';
import { clientKey, rateLimit } from '../../../src/lib/rate-limit';
import { route, type TransitDeparture, type TransitModeFilter, type TravelMode } from '../../../src/lib/routing';
import { assertKoreanCoord } from '../../../src/lib/security';

/**
 * 건물 상세 팝업의 "경로 보기" — 직장 위치와 건물 사이의 실제 경로.
 *
 * `/api/rents`(등시선, 캐시됨)와 달리 이건 지점→지점 단일 경로라 캐시하지
 * 않는다. `src/lib/routing.ts`의 `route()` 주석 참고.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// 대중교통은 minotor 콜드스타트(그래프 로드)가 수 초 걸릴 수 있다 — /api/rents 와 동일한 이유.
export const maxDuration = 60;

function isTravelMode(v: string): v is TravelMode {
  return v === 'walk' || v === 'transit' || v === 'drive';
}

function isTransitModeFilter(v: string | null): TransitModeFilter {
  return v === 'subway' || v === 'bus' ? v : 'all';
}

export async function GET(req: Request): Promise<NextResponse> {
  const limit = rateLimit(clientKey(req, 'route'), 20, 2);
  if (!limit.ok) {
    return NextResponse.json(
      { error: 'too_many_requests' },
      { status: 429, headers: { 'Retry-After': String(limit.retryAfter) } },
    );
  }

  const p = new URL(req.url).searchParams;

  const fromLon = Number(p.get('fromLon'));
  const fromLat = Number(p.get('fromLat'));
  const toLon = Number(p.get('toLon'));
  const toLat = Number(p.get('toLat'));
  try {
    assertKoreanCoord(fromLon, fromLat);
    assertKoreanCoord(toLon, toLat);
  } catch {
    return NextResponse.json({ error: 'invalid_coord' }, { status: 400 });
  }

  const travelRaw = p.get('travel') ?? 'transit';
  const travel: TravelMode = isTravelMode(travelRaw) ? travelRaw : 'transit';

  let departure: TransitDeparture | undefined;
  if (travel === 'transit') {
    const dayOfWeek = Number(p.get('depDay') ?? 1);
    const hour = Number(p.get('depHour') ?? 8);
    const minute = Number(p.get('depMinute') ?? 0);
    if (
      !Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6 ||
      !Number.isInteger(hour) || hour < 0 || hour > 23 ||
      !Number.isInteger(minute) || minute < 0 || minute > 59
    ) {
      return NextResponse.json({ error: 'invalid_departure' }, { status: 400 });
    }
    departure = { dayOfWeek: dayOfWeek as TransitDeparture['dayOfWeek'], hour, minute };
  }

  const transitModes = isTransitModeFilter(p.get('transitModes'));

  try {
    const segments = await route(fromLon, fromLat, toLon, toLat, travel, departure, transitModes);
    return NextResponse.json({ segments }, { headers: { 'Cache-Control': 'no-store, private' } });
  } catch (e) {
    console.error('route 계산 실패:', e instanceof Error ? e.message : e);
    return NextResponse.json({ error: 'route_failed' }, { status: 502 });
  }
}
