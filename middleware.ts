import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

/**
 * CSP를 미들웨어에서 만드는 이유.
 *
 * App Router는 스트리밍(RSC) 데이터를 인라인 `<script>`로 페이지에 주입한다.
 * `unsafe-inline`을 허용하면 이 스크립트는 통과하지만 XSS 스크립트도 함께
 * 통과한다(SECURITY.md 9장이 금지하는 것). 요청마다 새 nonce를 발급해
 * CSP 헤더에 넣으면, Next가 자신이 렌더링하는 스크립트 태그에 그 nonce를
 * 자동으로 붙여준다 — 인라인 스크립트를 개별 허용하면서 임의 스크립트는 막는다.
 *
 * next.config.ts의 정적 headers()로는 요청마다 값이 바뀌는 nonce를 만들 수
 * 없어서 여기로 옮겼다. 다른 보안 헤더(HSTS 등)는 정적이라 그대로 둔다.
 */
const TILE_ORIGIN = 'https://tiles.openfreemap.org';

export function middleware(request: NextRequest): NextResponse {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  // dev 모드 HMR(react-refresh)은 eval()로 모듈을 실행한다. 프로덕션 빌드는
  // eval을 쓰지 않으므로 배포본의 CSP는 unsafe-eval 없이 엄격하게 유지된다.
  const isDev = process.env.NODE_ENV !== 'production';

  const csp = [
    "default-src 'self'",
    // wasm-unsafe-eval: MapLibre가 WebWorker(blob)에서 쓰는 WebAssembly 컴파일에 필요.
    `script-src 'self' 'nonce-${nonce}' 'wasm-unsafe-eval'${isDev ? " 'unsafe-eval'" : ''}`,
    "worker-src 'self' blob:",
    "child-src 'self' blob:",
    // Tailwind가 주입하는 스타일 때문에 인라인 스타일은 허용한다.
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: ${TILE_ORIGIN}`,
    `connect-src 'self' ${TILE_ORIGIN}${isDev ? ' ws://127.0.0.1:3000' : ''}`,
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    'upgrade-insecure-requests',
  ].join('; ');

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

export const config = {
  matcher: [
    // _next/static, _next/image, favicon 은 CSP를 받을 필요가 없는 정적 자산이다.
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
};
