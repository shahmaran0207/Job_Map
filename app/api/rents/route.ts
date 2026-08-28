import { NextResponse } from 'next/server';
import { query } from '../../../src/lib/db';
import { snapToCell } from '../../../src/lib/grid';
import { clientKey, rateLimit } from '../../../src/lib/rate-limit';
import { assertKoreanCoord } from '../../../src/lib/security';
import { HOUSING_TYPES, type HousingType } from '../../../src/collectors/molit-types';

/**
 * 직장 좌표 기준 반경 내 거주지 시세.
 *
 * 지금은 **직선 반경**이다. 라우팅 엔진이 붙으면 이 자리를 등시선 폴리곤
 * (`ST_Contains`)으로 교체한다. 쿼리 구조는 그대로 두고 조건만 바뀌도록 짰다.
 *
 * 사용자 좌표는 격자로 스냅한 뒤에만 쓴다. 직장 주소는 개인을 특정할 수 있는
 * 정보이고, 정확한 좌표를 로그·캐시에 남기지 않는 것이 이 프로젝트의 원칙이다.
 * 250m 격자는 통근 계산 정확도에 영향이 거의 없다.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 허용 반경(m). 임의 값을 받으면 전국 스캔으로 DB를 태울 수 있다. */
const ALLOWED_RADIUS = [500, 1000, 2000, 3000, 5000, 10_000] as const;

/** 시세 신뢰도를 위해 최근 N개월 거래만 본다. */
const MONTHS_WINDOW = 12;

/** 응답 상한. 지도에 그릴 수 있는 양을 넘기면 브라우저가 죽는다. */
const MAX_RESULTS = 3000;

type Mode = 'wolse' | 'jeonse';

interface Row {
  id: string;
  name: string | null;
  housing_type: HousingType;
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

function parseIntParam(v: string | null, fallback: number, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
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

  // 사용자 좌표를 격자로 스냅한다. 이후 로직은 격자 중심만 사용한다.
  const cell = snapToCell(lon, lat, 250);

  const radiusRaw = Number(p.get('radius'));
  const radius = ALLOWED_RADIUS.find((r) => r === radiusRaw) ?? 2000;

  const mode: Mode = p.get('mode') === 'jeonse' ? 'jeonse' : 'wolse';

  // 상한은 만원 단위로 받는다(UI 표기와 일치). 0 이하는 '제한 없음'.
  const maxDepositManwon = parseIntParam(p.get('maxDeposit'), 0, 0, 2_000_000);
  const maxRentManwon = parseIntParam(p.get('maxRent'), 0, 0, 100_000);
  const minArea = parseIntParam(p.get('minArea'), 0, 0, 1000);

  const typesRaw = (p.get('types') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const types = typesRaw.filter((t): t is HousingType =>
    (HOUSING_TYPES as string[]).includes(t),
  );
  const typeFilter = types.length > 0 ? types : HOUSING_TYPES;

  // 통근 계산 불가 건물(단독다가구 등)을 포함할지. 기본은 포함하되 구분해 표시한다.
  const includeUnreliable = p.get('unreliable') !== '0';

  const sinceYm = monthsAgo(MONTHS_WINDOW);

  try {
    const rows = await query<Row>(
      `WITH origin AS (
         SELECT ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography AS g
       ),
       nearby AS (
         -- 공간 인덱스(GiST)를 쓰는 조건. 라우팅 엔진이 붙으면 이 부분을
         -- 등시선 폴리곤 포함 조건으로 교체한다.
         SELECT b.id, b.name, b.housing_type, b.legal_dong, b.built_year,
                b.commute_usable, b.geo_precision, b.geom,
                ST_Distance(b.geom, o.g) AS dist_m
           FROM building b, origin o
          WHERE b.geom IS NOT NULL
            AND ST_DWithin(b.geom, o.g, $3)
            AND b.housing_type = ANY($4::text[])
            AND ($5::boolean OR b.commute_usable)
       )
       SELECT n.id, n.name, n.housing_type, n.legal_dong, n.built_year,
              n.commute_usable, n.geo_precision,
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
                 n.commute_usable, n.geo_precision, n.geom, n.dist_m
        ORDER BY n.dist_m
        LIMIT $11`,
      [
        cell.lon, cell.lat, radius, typeFilter, includeUnreliable,
        sinceYm, mode,
        maxDepositManwon * 10_000, maxRentManwon * 10_000, minArea,
        MAX_RESULTS,
      ],
    );

    return NextResponse.json(
      {
        origin: { lon: cell.lon, lat: cell.lat },
        radius,
        mode,
        window: { sinceYm, months: MONTHS_WINDOW },
        truncated: rows.length >= MAX_RESULTS,
        count: rows.length,
        buildings: rows.map((r) => ({
          id: Number(r.id),
          name: r.name,
          type: r.housing_type,
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
