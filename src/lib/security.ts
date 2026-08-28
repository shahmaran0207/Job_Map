import { lookup } from 'node:dns/promises';
import { redact } from './env';

/**
 * 외부 요청 방어 계층.
 *
 * 이 프로젝트는 (1) 공공 API, (2) Kakao API, (3) 향후 임의 기업 채용페이지(JSON-LD)
 * 세 종류의 외부 요청을 보낸다. 3번이 위험하다. 수집 대상 URL 이 DB/외부 데이터에서
 * 오기 때문에, 그대로 fetch 하면 SSRF 로 내부망·클라우드 메타데이터가 노출된다.
 * (예: http://169.254.169.254/latest/meta-data/ 로 클라우드 자격증명 탈취)
 */

// ── SSRF: 사설/예약 IP 대역 차단 ────────────────────────────────────────────
function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

/** CIDR 목록. 링크로컬(169.254/16)이 클라우드 메타데이터 엔드포인트를 포함한다. */
const BLOCKED_V4: [string, number][] = [
  ['0.0.0.0', 8],        // this network
  ['10.0.0.0', 8],       // private
  ['100.64.0.0', 10],    // CGNAT (Alibaba 메타데이터 100.100.100.200 포함)
  ['127.0.0.0', 8],      // loopback
  ['169.254.0.0', 16],   // link-local / 클라우드 메타데이터
  ['172.16.0.0', 12],    // private
  ['192.0.0.0', 24],     // IETF protocol assignments
  ['192.0.2.0', 24],     // TEST-NET-1
  ['192.168.0.0', 16],   // private
  ['198.18.0.0', 15],    // benchmarking
  ['198.51.100.0', 24],  // TEST-NET-2
  ['203.0.113.0', 24],   // TEST-NET-3
  ['224.0.0.0', 4],      // multicast
  ['240.0.0.0', 4],      // reserved
];

export function isBlockedIp(ip: string): boolean {
  const v4 = ipv4ToInt(ip);
  if (v4 !== null) {
    for (const [base, bits] of BLOCKED_V4) {
      const baseInt = ipv4ToInt(base)!;
      const mask = bits === 0 ? 0 : (-1 << (32 - bits)) >>> 0;
      if ((v4 & mask) === (baseInt & mask)) return true;
    }
    return false;
  }

  const v6 = ip.toLowerCase().replace(/^\[|\]$/g, '');
  // IPv4-mapped(::ffff:a.b.c.d) / NAT64(64:ff9b::) 는 내부 v4 주소를 우회 통로로 쓴다.
  const mapped = v6.match(/(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped?.[1]) return isBlockedIp(mapped[1]);

  if (v6 === '::' || v6 === '::1') return true;
  if (/^f[cd][0-9a-f]{2}:/.test(v6)) return true;   // fc00::/7 unique-local
  if (/^fe[89ab][0-9a-f]:/.test(v6)) return true;   // fe80::/10 link-local
  if (/^2001:db8:/.test(v6)) return true;           // documentation
  if (/^ff[0-9a-f]{2}:/.test(v6)) return true;      // multicast
  return false;
}

/**
 * 호스트명이 공인 IP 로만 해석되는지 검사한다.
 *
 * 한계(정직하게): 검사 시점과 실제 연결 시점 사이에 DNS 응답이 바뀌면 우회된다
 * (DNS rebinding, TOCTOU). 완전 차단은 해석한 IP 로 직접 연결하고 Host 헤더를
 * 붙이는 방식이 필요하다. 그래서 신뢰 경계를 이중으로 둔다:
 *   - 알려진 API(워크넷/Kakao)는 호스트 allowlist 로 고정한다 (rebinding 무관)
 *   - 임의 URL 크롤링은 이 검사 + 리다이렉트 수동 처리 + 프록시 격리로 다룬다
 */
export async function assertPublicHost(hostname: string): Promise<void> {
  if (isBlockedIp(hostname)) {
    throw new Error(`차단된 주소로의 요청입니다: ${hostname}`);
  }
  // 내부 서비스 디스커버리 이름 차단 (.local, .internal, 단일 라벨 호스트)
  if (/\.(local|internal|localdomain|home|lan)$/i.test(hostname) || !hostname.includes('.')) {
    throw new Error(`내부 호스트명으로의 요청입니다: ${hostname}`);
  }

  const records = await lookup(hostname, { all: true });
  if (records.length === 0) throw new Error(`DNS 해석 실패: ${hostname}`);
  for (const r of records) {
    if (isBlockedIp(r.address)) {
      throw new Error(`사설/예약 IP 로 해석되는 호스트입니다: ${hostname}`);
    }
  }
}

// ── 안전한 fetch ────────────────────────────────────────────────────────────
export interface SafeFetchOptions {
  /** 허용 호스트 목록. 지정하면 DNS 검사 대신 이것만 신뢰한다 (가장 강한 방어) */
  allowHosts?: string[];
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** 응답 본문 상한. 무제한 스트림으로 메모리를 고갈시키는 공격을 막는다 */
  maxBytes?: number;
  /** 리다이렉트 허용 횟수. 기본 0 — 리다이렉트를 통한 SSRF 우회를 막는다 */
  maxRedirects?: number;
  method?: 'GET' | 'POST';
  body?: string;
}

const DEFAULT_MAX_BYTES = 20 * 1024 * 1024; // 20MB

export async function safeFetch(
  rawUrl: string | URL,
  opts: SafeFetchOptions = {},
): Promise<{ status: number; text: string; contentType: string }> {
  const {
    allowHosts, headers = {}, timeoutMs = 30_000,
    maxBytes = DEFAULT_MAX_BYTES, maxRedirects = 0, method = 'GET', body,
  } = opts;

  let url = new URL(String(rawUrl));
  let redirects = 0;

  while (true) {
    if (url.protocol !== 'https:') {
      // 로컬 개발용 라우팅 엔진(localhost)만 예외로 허용한다.
      const isLocalHttp = url.protocol === 'http:' && isBlockedIp(url.hostname);
      if (!isLocalHttp) throw new Error(`HTTPS 가 아닌 요청은 허용하지 않습니다: ${url.protocol}`);
    }

    if (allowHosts) {
      if (!allowHosts.includes(url.hostname)) {
        throw new Error(`허용되지 않은 호스트입니다: ${url.hostname}`);
      }
    } else {
      await assertPublicHost(url.hostname);
    }

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        body,
        headers: { 'User-Agent': 'JobMap/0.1 (+research)', ...headers },
        redirect: 'manual', // 리다이렉트를 직접 검증한다
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      // 에러 메시지에 URL(=API 키 포함)이 들어가는 경우가 있어 마스킹한다.
      throw new Error(redact(`요청 실패: ${String(e)}`));
    }

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc || redirects >= maxRedirects) {
        throw new Error(`리다이렉트를 허용하지 않습니다 (${res.status})`);
      }
      url = new URL(loc, url); // 다음 루프에서 새 호스트를 다시 검증한다
      redirects += 1;
      continue;
    }

    // Content-Length 로 1차 차단, 실제 읽으면서 2차 차단 (헤더는 위조 가능)
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > maxBytes) throw new Error(`응답이 너무 큽니다: ${declared} bytes`);

    const text = await readCapped(res, maxBytes);
    return {
      status: res.status,
      text,
      contentType: res.headers.get('content-type') ?? '',
    };
  }
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`응답이 상한(${maxBytes} bytes)을 초과했습니다`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// ── 프로토타입 오염 방어 ────────────────────────────────────────────────────
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * 외부 XML/JSON 을 파싱한 객체에서 위험 키를 제거한다.
 * fast-xml-parser 계열은 프로토타입 오염 CVE 이력이 있고, 우리는 파싱 결과를
 * 재귀 순회(deepFind)한 뒤 jsonb 로 저장하므로 입력 단계에서 잘라낸다.
 */
export function stripDangerousKeys<T>(input: T, depth = 0): T {
  if (depth > 20 || input === null || typeof input !== 'object') return input;
  if (Array.isArray(input)) {
    return input.map((v) => stripDangerousKeys(v, depth + 1)) as unknown as T;
  }
  const out: Record<string, unknown> = Object.create(null);
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (DANGEROUS_KEYS.has(k)) continue;
    out[k] = stripDangerousKeys(v, depth + 1);
  }
  return out as unknown as T;
}

// ── 저장 전 정제 ────────────────────────────────────────────────────────────
const MAX_RAW_BYTES = 64 * 1024; // 공고 하나의 원본 payload 상한

/** jsonb 컬럼이 악성/거대 payload 로 부풀지 않도록 상한을 건다. */
export function capRawPayload(raw: unknown): unknown {
  const json = JSON.stringify(raw ?? null);
  if (json.length <= MAX_RAW_BYTES) return raw;
  return { _truncated: true, _originalBytes: json.length, _head: json.slice(0, MAX_RAW_BYTES) };
}

/**
 * 외부에서 들어온 텍스트를 저장용으로 정제한다.
 *
 * 공고 제목·회사명은 외부 입력이고 결국 브라우저에 렌더된다. React 는 기본
 * 이스케이프하지만, 이 프로젝트는 공고 상세를 HTML 로 받을 계획이 있으므로
 * "저장 시점에 태그를 제거"하는 원칙을 세운다. dangerouslySetInnerHTML 은 금지한다.
 */
export function sanitizeText(input: string | null | undefined, maxLen = 500): string | null {
  if (input === null || input === undefined) return null;
  const s = stripInvisible(String(input))
    .replace(/<[^>]*>/g, ' ')                    // 태그 제거
    .replace(/&(?:#x?[0-9a-f]+|[a-z]+);/gi, ' ') // 엔티티 제거 (이중 인코딩 우회 차단)
    .replace(/\s+/g, ' ')
    .trim();
  return s.length ? s.slice(0, maxLen) : null;
}

/**
 * 제어문자·제로폭 문자·양방향 제어문자를 제거한다.
 *
 * 양방향 제어문자(U+202A~U+202E 등)는 화면에 보이는 문자열과 실제 저장된 문자열을
 * 다르게 만들 수 있다(트로이 소스 공격). 공고 제목·회사명이 외부 입력이므로,
 * 가짜 회사명으로 사용자를 속이는 시각적 위장을 저장 시점에 차단한다.
 *
 * 정규식 리터럴에 보이지 않는 문자를 직접 넣으면 소스 자체가 읽을 수 없게 되므로
 * 코드포인트로 판정한다.
 */
export function stripInvisible(input: string): string {
  let out = '';
  for (const ch of input) {
    const c = ch.codePointAt(0)!;
    const blocked =
      c <= 0x08 ||                      // C0 제어문자 (탭/개행 제외)
      c === 0x0b || c === 0x0c ||
      (c >= 0x0e && c <= 0x1f) ||
      (c >= 0x7f && c <= 0x9f) ||       // DEL + C1 제어문자
      (c >= 0x200b && c <= 0x200f) ||   // 제로폭 문자, LRM/RLM
      (c >= 0x2028 && c <= 0x202e) ||   // 라인/문단 구분자, 양방향 재정의
      (c >= 0x2060 && c <= 0x206f) ||   // word joiner, 불가시 연산자, 방향 지정
      c === 0xfeff;                     // BOM
    if (!blocked) out += ch;
  }
  return out;
}

/**
 * 저장·렌더링할 외부 링크를 검증한다.
 *
 * 공고 URL 은 외부에서 들어오고 프론트에서 <a href> 로 렌더된다. 검증 없이 넣으면
 * `javascript:`, `data:`, `vbscript:` 스킴으로 XSS 가 성립한다. http/https 만 허용한다.
 */
export function safeExternalUrl(input: string | null | undefined): string | null {
  if (!input) return null;
  const s = stripInvisible(String(input)).trim();
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return null; // 상대 경로/깨진 URL 은 버린다
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!url.hostname.includes('.')) return null;
  if (s.length > 2048) return null;
  return url.toString();
}

// ── 좌표 검증 (사용자 입력) ─────────────────────────────────────────────────
/** 대한민국 영역 대략 경계. 범위 밖 좌표는 라우팅 엔진을 무의미하게 태우므로 거른다. */
const KR_BOUNDS = { minLon: 124.0, maxLon: 132.5, minLat: 32.5, maxLat: 39.0 };

export function assertKoreanCoord(lon: number, lat: number): void {
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) throw new Error('좌표 형식이 올바르지 않습니다');
  if (lon < KR_BOUNDS.minLon || lon > KR_BOUNDS.maxLon || lat < KR_BOUNDS.minLat || lat > KR_BOUNDS.maxLat) {
    throw new Error('대한민국 범위를 벗어난 좌표입니다');
  }
}
