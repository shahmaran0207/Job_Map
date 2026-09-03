'use client';

import { useState } from 'react';
import type { GeocodeResponse } from '../lib/types';

interface Props {
  onResolved: (r: { lon: number; lat: number; address: string | null }) => void;
  disabled: boolean;
}

/**
 * 직장 주소 검색.
 *
 * 회사명으로도 검색된다. 좌표 해결 엔진의 키워드 검색 경로가 '카카오 판교' 같은
 * 상호를 건물 단위로 잡아내기 때문이다. 사용자가 정확한 주소를 몰라도 된다.
 *
 * Kakao REST 키는 서버 라우트에만 있다. 이 컴포넌트는 /api/geocode 만 호출한다.
 */
export default function SearchBar({ onResolved, disabled }: Props) {
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const query = q.trim();
    if (query.length < 2 || busy) return;

    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/geocode?q=${encodeURIComponent(query)}`);
      if (res.status === 429) {
        setError('검색이 너무 잦습니다. 잠시 후 다시 시도해 주세요.');
        return;
      }
      if (!res.ok) {
        setError('검색에 실패했습니다.');
        return;
      }
      const data: GeocodeResponse = await res.json();
      if (!data.found || data.lon === undefined || data.lat === undefined) {
        setError('찾을 수 없습니다. 회사명이나 도로명 주소로 다시 시도해 보세요.');
        return;
      }
      onResolved({ lon: data.lon, lat: data.lat, address: data.address ?? null });
    } catch {
      setError('네트워크 오류입니다.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <label htmlFor="workplace" className="mb-1.5 block font-medium text-neutral-800">
        직장 위치
      </label>
      <div className="flex gap-2">
        <input
          id="workplace"
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          disabled={disabled || busy}
          placeholder="회사명 또는 주소"
          autoComplete="off"
          maxLength={100}
          className="min-w-0 flex-1 rounded-lg border border-neutral-300 px-3 py-2 text-[13px] outline-none placeholder:text-neutral-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100"
        />
        <button
          type="submit"
          disabled={disabled || busy || q.trim().length < 2}
          className="rounded-lg bg-neutral-900 px-4 py-2 text-[13px] font-medium text-white transition hover:bg-neutral-700 disabled:bg-neutral-300"
        >
          {busy ? '검색 중…' : '검색'}
        </button>
      </div>
      <p className="mt-1.5 text-[11px] text-neutral-400">
        예: 카카오 판교, 삼성전자 수원, 서울 강남구 테헤란로 152
      </p>
      {error && <p className="mt-2 text-[12px] text-red-600">{error}</p>}
    </form>
  );
}
