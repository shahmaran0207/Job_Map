'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import dynamic from 'next/dynamic';
import FilterPanel from './components/FilterPanel';
import SearchBar from './components/SearchBar';
import {
  DEFAULT_FILTERS,
  HOUSING_LABEL_SHORT,
  TRAVEL_LABEL,
  formatManwon,
  type BuildingPoint,
  type Filters,
  type RentsResponse,
} from './lib/types';

// MapLibre 는 window 를 참조하므로 서버에서 렌더하지 않는다.
const RentMap = dynamic(() => import('./components/RentMap'), {
  ssr: false,
  loading: () => <div className="h-full w-full animate-pulse bg-neutral-950" />,
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
      travel: f.travel,
      minutes: String(f.minutes),
      mode: f.mode,
      maxDeposit: String(f.maxDeposit),
      maxRent: String(f.maxRent),
      minArea: String(f.minArea),
      minBuiltYear: String(f.minBuiltYear),
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
  const area = data?.area ?? null;
  const degraded = area?.kind === 'radius';
  const summary = useMemo(() => summarize(buildings, filters.mode), [buildings, filters.mode]);

  return (
    <main className="flex h-dvh flex-col md:flex-row">
      {loading && <LoadingOverlay />}

      <aside className="flex shrink-0 flex-col gap-5 overflow-y-auto border-cyan-400/10 bg-neutral-950/90 p-5 backdrop-blur-md md:w-88 md:border-r">
        <header>
          <div className="flex items-center gap-2">
            <span className="h-1.5 w-1.5 rounded-full bg-cyan-400 shadow-[0_0_8px_2px_rgba(34,211,238,0.7)]" />
            <h1 className="text-[15px] font-semibold tracking-tight text-neutral-50">
              직장 근처 거주지 지도
            </h1>
          </div>
          <p className="mt-1.5 text-[12px] leading-relaxed text-neutral-300">
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
          <div className="rounded-lg border border-cyan-400/20 bg-cyan-400/10 px-3 py-2.5 text-[12px] leading-snug text-cyan-100">
            <div className="font-medium">{origin.address ?? '선택한 위치'}</div>
            <div className="mt-0.5 text-cyan-300/70">
              {TRAVEL_LABEL[filters.travel]} {filters.minutes}분 이내
              {area?.kind === 'isochrone' && ' (실제 이동 경로 기준)'}
            </div>
          </div>
        )}

        {/*
          직선거리 폴백을 반드시 알린다. 알리지 않으면 사용자는 실제 통근시간이라고
          믿는데 지도는 직선거리를 보여주는 셈이 된다. 이 프로젝트에서 가장 피하려는
          "지도가 조용히 거짓말하는" 상태다.
        */}
        {degraded && (
          <div className="rounded-lg border border-amber-400/25 bg-amber-400/10 px-3 py-2.5 text-[12px] leading-snug text-amber-200">
            <div className="font-medium">직선거리 근사로 표시 중</div>
            <div className="mt-0.5 text-amber-300/70">
              라우팅 엔진이 꺼져 있어 실제 이동 경로 대신 직선거리로 계산했습니다.
              {area?.radius && ` (반경 약 ${(area.radius / 1000).toFixed(1)}km)`} 지도의
              경계선이 점선으로 표시됩니다.
            </div>
          </div>
        )}

        <FilterPanel
          filters={filters}
          onChange={setFilters}
          disabled={!origin || loading}
          degraded={degraded}
        />

        {error && (
          <p className="rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2 text-[12px] text-red-300">
            {error}
          </p>
        )}

        <Summary loading={loading} origin={!!origin} data={data} summary={summary} mode={filters.mode} />

        <footer className="mt-auto border-t border-neutral-800 pt-4 text-[11px] leading-relaxed text-neutral-300">
          국토교통부 전월세 실거래가 (공공데이터포털) · 최근 {data?.window.months ?? 12}개월 거래
          중앙값
          <br />
          <span className="text-neutral-300">실거래 기록이며 현재 매물이 아닙니다.</span>
        </footer>
      </aside>

      <section className="relative min-h-0 flex-1">
        <RentMap
          origin={origin ? { lon: origin.lon, lat: origin.lat } : null}
          area={area}
          buildings={buildings}
          mode={filters.mode}
        />

        {!origin && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-neutral-950/50 backdrop-blur-[1px]">
            <p className="rounded-xl border border-cyan-400/20 bg-neutral-950/90 px-5 py-3 text-[13px] font-medium text-neutral-200 shadow-[0_0_40px_-12px_rgba(34,211,238,0.4)]">
              직장 위치를 입력해 주세요
            </p>
          </div>
        )}

        {origin && <Legend mode={filters.mode} />}
      </section>
    </main>
  );
}

/**
 * 필터를 바꾸면 서버 왕복(공간 쿼리 + 집계) 이 있어 즉시 반영되지 않는다.
 * 버튼 disabled 상태만으로는 "느리다/고장났다"로 오해하기 쉬워서, 화면 전체를
 * 반투명하게 덮고 중앙에 큰 로딩 패널을 띄운다 — 지금 뭔가 진행 중이라는 걸
 * 놓칠 수 없게 만드는 게 목적이다.
 */
function LoadingOverlay() {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-950/60 backdrop-blur-sm">
      <div className="flex flex-col items-center gap-7 rounded-3xl border border-cyan-400/30 bg-neutral-950/90 px-20 py-16 shadow-[0_0_90px_-10px_rgba(34,211,238,0.55)]">
        <DotSpinner />
        <div className="flex flex-col items-center gap-1.5">
          <p className="bg-gradient-to-b from-cyan-200 to-cyan-500 bg-clip-text text-3xl font-bold tracking-tight text-transparent">
            불러오는 중
          </p>
          <p className="text-[13px] text-neutral-300">통근권과 시세를 다시 계산하고 있습니다</p>
        </div>
      </div>
    </div>
  );
}

/** Windows 로딩 스피너처럼 점 12개가 원을 그리며 도는 형태. 각 점은 유리구슬처럼
 * 하이라이트를 넣고 발광 그림자를 씌워 입체감을 준다. */
const SPINNER_DOTS = Array.from({ length: 12 }, (_, i) => i);

function DotSpinner() {
  return (
    <div className="relative h-36 w-36 animate-spin" style={{ animationDuration: '1.3s' }}>
      {SPINNER_DOTS.map((i) => {
        // 회전은 시계방향(animate-spin)인데 꼬리를 +방향에 두면 꼬리가 머리보다
        // 앞서 도는 것처럼 보인다(거꾸로 도는 느낌). 꼬리를 반대(-)로 둬야
        // 머리가 앞장서고 꼬리가 뒤에서 옅어지며 따라오는 방향이 맞는다.
        const angle = -(i / SPINNER_DOTS.length) * 360;
        const t = i / SPINNER_DOTS.length; // 0 = 머리(가장 밝음) → 1 직전 = 꼬리(가장 흐림)
        const opacity = 1 - t * 0.88;
        const scale = 1 - t * 0.55;
        return (
          <span
            key={i}
            className="absolute top-1/2 left-1/2 h-4 w-4 rounded-full"
            style={{
              transform: `translate(-50%, -50%) rotate(${angle}deg) translateY(-62px) scale(${scale})`,
              opacity,
              background: 'radial-gradient(circle at 32% 28%, #cffafe 0%, #22d3ee 45%, #0891b2 80%, #155e75 100%)',
              boxShadow: `0 0 ${12 * (1 - t) + 2}px ${2 + 2 * (1 - t)}px rgba(34,211,238,${0.85 * (1 - t) + 0.1})`,
            }}
          />
        );
      })}
    </div>
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
    return <p className="text-[12px] text-neutral-300">조회 중…</p>;
  }
  if (!data) return null;

  if (summary.count === 0) {
    return (
      <div className="rounded-lg border border-amber-400/25 bg-amber-400/10 px-3 py-2.5 text-[12px] leading-snug text-amber-200">
        조건에 맞는 거래가 없습니다. 반경을 넓히거나 금액 상한을 올려 보세요.
        <div className="mt-1 text-amber-300/70">
          현재 데이터는 일부 지역만 수집된 상태일 수 있습니다.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2.5 rounded-lg border border-cyan-400/15 bg-neutral-900/40 p-3.5">
      <div className="flex items-baseline justify-between">
        <span className="font-medium text-neutral-100">건물 {summary.count}곳</span>
        {loading && <span className="text-[11px] text-cyan-400/80">갱신 중…</span>}
      </div>

      <div className="flex items-baseline gap-2 text-[13px]">
        <span className="text-neutral-300">중앙값</span>
        <span className="font-semibold tabular-nums text-cyan-100">
          {formatManwon(summary.medDeposit)}
          {mode === 'wolse' && summary.medRent !== null && (
            <> / {formatManwon(summary.medRent)}</>
          )}
        </span>
      </div>

      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-neutral-300">
        {summary.byType.map((t) => (
          <span key={t.type} className="tabular-nums">
            {HOUSING_LABEL_SHORT[t.type]} {t.count}
          </span>
        ))}
      </div>

      {summary.unreliable > 0 && (
        <p className="text-[11px] leading-snug text-neutral-300">
          이 중 {summary.unreliable}곳은 위치가 법정동 중심점입니다(회색 점선).
        </p>
      )}

      {data.truncated && (
        <p className="text-[11px] text-amber-300/80">
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
  // RentMap.tsx colorFor() 팔레트와 동일한 값이어야 범례가 실제 색과 맞는다.
  const colors = ['#3be1e1', '#1fc893', '#c4a200', '#e97300', '#de3b3d'];

  return (
    <div className="absolute right-4 bottom-4 rounded-lg border border-cyan-400/15 bg-neutral-950/90 px-3 py-2.5 shadow-[0_0_30px_-10px_rgba(34,211,238,0.35)] backdrop-blur">
      <div className="mb-1.5 text-[11px] font-medium text-neutral-300">
        {mode === 'wolse' ? '월세 (중앙값)' : '전세 보증금'}
      </div>
      <div className="flex items-end gap-1">
        {colors.map((c, i) => (
          <div key={c} className="flex flex-col items-center gap-1">
            <div className="h-3.5 w-8 rounded-sm" style={{ background: c }} />
            <span className="text-[9px] tabular-nums text-neutral-300">{labels[i]}</span>
          </div>
        ))}
      </div>
      <div className="mt-2 flex items-center gap-1.5 border-t border-neutral-800 pt-1.5">
        <span
          className="h-3 w-3 rounded-full border-[1.5px] border-dashed"
          style={{ background: 'rgba(139, 150, 163, 0.5)', borderColor: '#4b5563' }}
        />
        <span className="text-[9px] text-neutral-300">위치 부정확 (동 중심점)</span>
      </div>
    </div>
  );
}
