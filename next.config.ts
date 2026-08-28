import type { NextConfig } from 'next';

/**
 * 보안 헤더.
 *
 * SECURITY.md 9장의 프론트엔드 항목을 여기서 실제로 적용한다.
 *
 * CSP 에서 허용하는 외부 출처는 지도 타일 하나뿐이다. Kakao Local API 는
 * 브라우저에서 직접 호출하지 않고 서버 라우트(/api/geocode)를 경유하므로
 * connect-src 에 넣지 않는다. REST 키가 클라이언트로 나가지 않게 하는 것이
 * 이 구조의 목적이다.
 */
const TILE_ORIGIN = 'https://tiles.openfreemap.org';

const csp = [
  "default-src 'self'",
  // MapLibre 는 WebWorker 를 blob 으로 만든다. wasm-unsafe-eval 은 지도 렌더링에 필요.
  "script-src 'self' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "child-src 'self' blob:",
  // Tailwind 가 주입하는 스타일 때문에 인라인 스타일은 허용한다.
  // script 쪽은 unsafe-inline 을 절대 허용하지 않는다.
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: blob: ${TILE_ORIGIN}`,
  `connect-src 'self' ${TILE_ORIGIN}`,
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  'upgrade-insecure-requests',
].join('; ');

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // 프로덕션에 소스맵을 배포하지 않는다.
  productionBrowserSourceMaps: false,
  poweredByHeader: false,

  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: csp },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains; preload',
          },
          // 사용하지 않는 브라우저 기능을 차단한다. 위치 정보는 사용자가
          // 주소를 직접 입력하는 방식이므로 geolocation 도 끈다.
          {
            key: 'Permissions-Policy',
            value: 'geolocation=(), camera=(), microphone=(), payment=()',
          },
        ],
      },
    ];
  },
};

export default nextConfig;
