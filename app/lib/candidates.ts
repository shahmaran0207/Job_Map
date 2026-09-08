import type { Filters, PersonB } from './types';

/**
 * 저장한 후보지.
 *
 * 지도 폴리곤 같은 무거운 데이터는 저장하지 않는다 — 다시 볼 때 /api/rents 를
 * 그대로 다시 호출한다. 여기엔 재검색에 필요한 입력값과, 목록에서 바로 보여줄
 * 가벼운 요약값만 담는다.
 */
export interface Candidate {
  id: string;
  savedAt: string;
  origin: { lon: number; lat: number; address: string | null };
  origin2: { lon: number; lat: number; address: string | null } | null;
  person2: PersonB | null;
  filters: Filters;
  summary: {
    count: number;
    medDeposit: number | null;
    medRent: number | null;
  };
}

const STORAGE_KEY = 'jobmap:candidates';
const MAX_CANDIDATES = 20;

/** localStorage 는 시크릿 모드·용량 초과 등으로 언제든 실패할 수 있다. 실패해도 앱이 죽으면 안 된다. */
export function loadCandidates(): Candidate[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Candidate[]) : [];
  } catch {
    return [];
  }
}

function persist(list: Candidate[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    // 저장 실패(용량 초과 등)는 조용히 무시한다 — 비교 기능이 안 되는 것뿐이지
    // 지도 조회 자체는 이것 없이도 정상 동작해야 한다.
  }
}

export function saveCandidate(c: Omit<Candidate, 'id' | 'savedAt'>): Candidate[] {
  const candidate: Candidate = {
    ...c,
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    savedAt: new Date().toISOString(),
  };
  // 최신이 위로, 너무 쌓이면 오래된 것부터 버린다.
  const next = [candidate, ...loadCandidates()].slice(0, MAX_CANDIDATES);
  persist(next);
  return next;
}

export function removeCandidate(id: string): Candidate[] {
  const next = loadCandidates().filter((c) => c.id !== id);
  persist(next);
  return next;
}
