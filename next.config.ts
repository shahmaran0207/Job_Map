import type { NextConfig } from 'next';

/**
 * 보안 헤더.
 *
 * SECURITY.md 9장의 프론트엔드 항목을 여기서 실제로 적용한다.
 *
 * CSP는 요청마다 nonce가 바뀌어야 해서 여기(정적 config)가 아니라
 * `middleware.ts`에서 만든다. 이유는 그쪽 주석 참고.
 */
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
