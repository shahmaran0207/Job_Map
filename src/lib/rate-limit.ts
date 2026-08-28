/**
 * 프로세스 내 토큰 버킷 레이트리밋.
 *
 * 한계를 먼저 밝힌다: 서버리스에서는 인스턴스마다 버킷이 따로 생기므로 정확한
 * 전역 제한이 아니다. 그래도 두는 이유는 이 프로젝트가 **무료 쿼터로 운영**되기
 * 때문이다. Kakao Local API 일 10만 회, 라우팅 엔진은 개발 PC CPU 다. 한 명이
 * 스크립트로 두들기면 서비스가 멈춘다. 정확한 차단이 아니라 사고 규모를 줄이는
 * 장치로 본다.
 *
 * 전역 제한이 필요해지면 Postgres 나 Upstash 같은 외부 저장소로 옮긴다.
 */
interface Bucket {
  tokens: number;
  updatedAt: number;
}

const buckets = new Map<string, Bucket>();

/** 메모리 누수 방지. 오래된 버킷을 정리한다. */
const MAX_BUCKETS = 10_000;
const IDLE_MS = 10 * 60 * 1000;

function sweep(now: number): void {
  if (buckets.size < MAX_BUCKETS) return;
  for (const [key, b] of buckets) {
    if (now - b.updatedAt > IDLE_MS) buckets.delete(key);
  }
  // 그래도 넘치면 오래된 것부터 버린다(Map 은 삽입 순서를 유지한다).
  if (buckets.size >= MAX_BUCKETS) {
    const excess = buckets.size - Math.floor(MAX_BUCKETS / 2);
    let i = 0;
    for (const key of buckets.keys()) {
      if (i++ >= excess) break;
      buckets.delete(key);
    }
  }
}

export interface RateLimitResult {
  ok: boolean;
  /** 다음 토큰이 차기까지 남은 초. 429 응답의 Retry-After 에 쓴다. */
  retryAfter: number;
}

/**
 * @param key      식별자 (보통 IP + 엔드포인트)
 * @param capacity 버스트 허용량
 * @param refillPerSec 초당 회복 토큰 수
 */
export function rateLimit(key: string, capacity: number, refillPerSec: number): RateLimitResult {
  const now = Date.now();
  sweep(now);

  const b = buckets.get(key);
  if (!b) {
    buckets.set(key, { tokens: capacity - 1, updatedAt: now });
    return { ok: true, retryAfter: 0 };
  }

  const elapsedSec = (now - b.updatedAt) / 1000;
  b.tokens = Math.min(capacity, b.tokens + elapsedSec * refillPerSec);
  b.updatedAt = now;

  if (b.tokens < 1) {
    return { ok: false, retryAfter: Math.ceil((1 - b.tokens) / refillPerSec) };
  }

  b.tokens -= 1;
  return { ok: true, retryAfter: 0 };
}

/**
 * 요청자 식별자.
 *
 * 프록시 뒤에서는 소켓 주소가 프록시 IP 이므로 헤더를 봐야 한다. 다만 헤더는
 * 위조 가능하므로 이것을 인증 수단으로 쓰지 않는다. 레이트리밋의 그룹 키로만
 * 쓰며, 위조 시 공격자가 자기 버킷을 나누는 것뿐이라 피해가 제한된다.
 */
export function clientKey(req: Request, scope: string): string {
  const h = req.headers;
  const fwd = h.get('x-forwarded-for')?.split(',')[0]?.trim();
  const ip = h.get('x-real-ip') ?? fwd ?? 'unknown';
  return `${scope}:${ip}`;
}
