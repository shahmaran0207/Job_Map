'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import FilterPanel from './components/FilterPanel';
import SearchBar from './components/SearchBar';
import {
  DEFAULT_FILTERS,
  HOUSING_LABEL_SHORT,
  formatManwon,
  type BuildingPoint,
  type Filters,
  type RentsResponse,
} from './lib/types';

// MapLibre 는 window 를 참조하므로 서버에서 렌더하지 않는다.
const RentMap = dynamic(() => import('./components/RentMap'), {
  ssr: false,
  loading: () => <div className="h-full w-full animate-pulse bg-neutral-100" />,
});

interface Origin {
  lon: number;
  lat: number;
  address: string | null;
}

export default function Page() {
  const [origin, setOrigin] = useState<Origin | null>(null);
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [data, setData] = useState<RentsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchRents = useCallback(async (o: Origin, f: Filters) => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({
      lon: String(o.lon),
      lat: String(o.lat),
      radius: String(f.radius),
      mode: f.mode,
      maxDeposit: String(f.maxDeposit),
      maxRent: String(f.maxRent),
      minArea: String(f.minArea),
      types: f.types.join(','),
      unreliable: f.includeUnreliable ? '1' : '0',
    });
    try {
      const res = await fetch(`/api/rents?${params}`);
      if (!res.ok) {
        setError(res.status === 429 ? '요청이 너무 잦습니다.' : '조회에 실패했습니다.');
        return;
      }
      setData(await res.json());
    } catch {
      setError('네트워크 오류입니다.');
    } finally {
      setLoading(false);
    }
  }, []);

  // 필터 변경은 슬라이더 드래그로 연속 발생한다. 디바운스로 요청을 합친다.
  useEffect(() => {
    if (!origin) return;
    const t = setTimeout(() => void fetchRents(origin, filters), 250);
    return () => clearTimeout(t);
  }, [origin, filters, fetchRents]);

  const buildings: BuildingPoint[] = data?.buildings ?? [];
  const summary = useMemo(() => summarize(buildings, filters.mode), [buildings, filters.mode]);

  return (
    <main className="flex h-dvh flex-col md:flex-row">
      <aside className="flex shrink-0 flex-col gap-5 overflow-y-auto border-neutral-200 bg-white p-5 md:w-88 md:border-r">
        <header>
          <h1 className="text-[15px] font-semibold tracking-tight text-neutral-900">
            직장 근처 거주지 지도
          </h1>
          <p className="mt-1 text-[12px] leading-relaxed text-neutral-500">
            직장 위치를 입력하면 주변 전월세 실거래 시세를 지도에서 봅니다.
          </p>
        </header>

        <SearchBar
          disabled={loading}
          onResolved={(r) => {
            setOrigin(r);
            setData(null);
          }}
        />

        {origin && (
          <div className="rounded-lg bg-indigo-50 px-3 py-2.5 text-[12px] leading-snug text-indigo-900">
            <div className="font-medium">{origin.address ?? '선택한 위치'}</div>
            <div className="mt-0.5 text-indigo-700/70">
              이 지점에서 반경{' '}
              {filters.radius >= 1000 ? `${filters.radius / 1000}km` : `${filters.radius}m`}
            </div>
          </div>
        )}

        <FilterPanel filters={filters} onChange={setFilters} disabled={!origin || loading} />

        {error && (
          <p className="rounded-lg bg-red-50 px-3 py-2 text-[12px] text-red-700">{error}</p>
        )}

        <Summary loading={loading} origin={!!origin} data={data} summary={summary} mode={filters.mode} />

        <footer className="mt-auto border-t border-neutral-100 pt-4 text-[11px] leading-relaxed text-neutral-400">
          국토교통부 전월세 실거래가 (공공데이터포털) · 최근 {data?.window.months ?? 12}개월 거래
          중앙값
          <br />
          <span className="text-neutral-400/80">
            실거래 기록이며 현재 매물이 아닙니다. 반경은 직선거리이고, 통근시간 기반 검색은 준비
            중입니다.
          </span>
        </footer>
      </aside>

      <section className="relative min-h-0 flex-1">
        <RentMap
          origin={origin ? { lon: origin.lon, lat: origin.lat } : null}
          radius={filters.radius}
          buildings={buildings}
          mode={filters.mode}
        />

        {!origin && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-white/55 backdrop-blur-[1px]">
            <p className="rounded-xl bg-white px-5 py-3 text-[13px] font-medium text-neutral-600 shadow-lg">
              직장 위치를 입력해 주세요
            </p>
          </div>
        )}

        {origin && <Legend mode={filters.mode} />}
      </section>
    </main>
  );
}

interface SummaryData {
  count: number;
  unreliable: number;
  medDeposit: number | null;
  medRent: number | null;
  byType: { type: keyof typeof HOUSING_LABEL_SHORT; count: number }[];
}

function summarize(buildings: BuildingPoint[], mode: 'wolse' | 'jeonse'): SummaryData {
  const counts = new Map<string, number>();
  const deposits: number[] = [];
  const rents: number[] = [];
  let unreliable = 0;

  for (const b of buildings) {
    counts.set(b.type, (counts.get(b.type) ?? 0) + 1);
    if (!b.commuteUsable) unreliable += 1;
    if (b.deposit !== null) deposits.push(b.deposit);
    if (b.rent !== null && mode === 'wolse') rents.push(b.rent);
  }

  return {
    count: buildings.length,
    unreliable,
    medDeposit: median(deposits),
    medRent: median(rents),
    byType: [...counts]
      .map(([type, count]) => ({ type: type as keyof typeof HOUSING_LABEL_SHORT, count }))
      .sort((a, b) => b.count - a.count),
  };
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
}

function Summary({
  loading,
  origin,
  data,
  summary,
  mode,
}: {
  loading: boolean;
  origin: boolean;
  data: RentsResponse | null;
  summary: SummaryData;
  mode: 'wolse' | 'jeonse';
}) {
  if (!origin) return null;
  if (loading && !data) {
    return <p className="text-[12px] text-neutral-400">조회 중…</p>;
  }
  if (!data) return null;

  if (summary.count === 0) {
    return (
      <div className="rounded-lg bg-amber-50 px-3 py-2.5 text-[12px] leading-snug text-amber-900">
        조건에 맞는 거래가 없습니다. 반경을 넓히거나 금액 상한을 올려 보세요.
        <div className="mt-1 text-amber-800/70">
          현재 데이터는 일부 지역만 수집된 상태일 수 있습니다.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2.5 rounded-lg border border-neutral-200 p-3.5">
      <div className="flex items-baseline justify-between">
        <span className="font-medium text-neutral-800">건물 {summary.count}곳</span>
        {loading && <span className="text-[11px] text-neutral-400">갱신 중…</span>}
      </div>

      <div className="flex items-baseline gap-2 text-[13px]">
        <span className="text-neutral-500">중앙값</span>
        <span className="font-semibold tabular-nums text-neutral-900">
          {formatManwon(summary.medDeposit)}
          {mode === 'wolse' && summary.medRent !== null && (
            <> / {formatManwon(summary.medRent)}</>
          )}
        </span>
      </div>

      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-neutral-500">
        {summary.byType.map((t) => (
          <span key={t.type} className="tabular-nums">
            {HOUSING_LABEL_SHORT[t.type]} {t.count}
          </span>
        ))}
      </div>

      {summary.unreliable > 0 && (
        <p className="text-[11px] leading-snug text-neutral-500">
          이 중 {summary.unreliable}곳은 위치가 법정동 중심점입니다(회색 점선).
        </p>
      )}

      {data.truncated && (
        <p className="text-[11px] text-amber-700">
          결과가 많아 가까운 순으로 일부만 표시했습니다.
        </p>
      )}
    </div>
  );
}

function Legend({ mode }: { mode: 'wolse' | 'jeonse' }) {
  const labels =
    mode === 'wolse'
      ? ['~40만', '~70만', '~100만', '~150만', '150만~']
      : ['~1억', '~2억', '~3.5억', '~6억', '6억~'];
  const colors = [
    'oklch(0.83 0.13 195)',
    'oklch(0.74 0.15 165)',
    'oklch(0.72 0.16 95)',
    'oklch(0.68 0.18 55)',
    'oklch(0.6 0.2 25)',
  ];

  return (
    <div className="absolute bottom-4 right-4 rounded-lg bg-white/95 px-3 py-2.5 shadow-lg backdrop-blur">
      <div className="mb-1.5 text-[11px] font-medium text-neutral-700">
        {mode === 'wolse' ? '월세 (중앙값)' : '전세 보증금'}
      </div>
      <div className="flex items-end gap-1">
        {colors.map((c, i) => (
          <div key={c} className="flex flex-col items-center gap-1">
            <div className="h-3.5 w-8 rounded-sm" style={{ background: c }} />
            <span className="text-[9px] tabular-nums text-neutral-500">{labels[i]}</span>
          </div>
        ))}
      </div>
      <div className="mt-2 flex items-center gap-1.5 border-t border-neutral-100 pt-1.5">
        <span
          className="h-3 w-3 rounded-full border-[1.5px] border-dashed"
          style={{
            background: 'oklch(0.65 0.02 260 / 0.5)',
            borderColor: 'oklch(0.45 0.02 260)',
          }}
        />
        <span className="text-[9px] text-neutral-500">위치 부정확 (동 중심점)</span>
      </div>
    </div>
  );
}
