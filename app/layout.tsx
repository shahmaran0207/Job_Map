import type { Metadata, Viewport } from 'next';
import './globals.css';

/**
 * 정적 캐시 금지 — CSP nonce(middleware.ts)와 충돌한다.
 *
 * 미들웨어가 요청마다 새 nonce를 발급해 CSP 헤더에 넣는데, 페이지가 정적/ISR
 * 캐시되면 예전 요청 때 구운 nonce가 박힌 `<script nonce="...">` 가 새 요청의
 * CSP 헤더(다른 nonce)와 안 맞아 브라우저가 자체 스크립트까지 전부 차단한다.
 * 실배포(Vercel)에서 검색·지도 하이드레이션이 통째로 죽는 형태로 나타났다.
 */
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: '직장 근처 거주지 지도',
  description:
    '직장 위치를 입력하면 주변 아파트·오피스텔·원룸의 전월세 실거래 시세를 지도에서 확인합니다.',
  // 검색 결과에 사용자의 직장 주소가 담긴 URL 이 노출될 이유가 없다.
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // 지도를 쓰므로 확대를 막지 않는다. 접근성상 사용자 확대는 항상 허용해야 한다.
  maximumScale: 5,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body className="bg-neutral-50 text-neutral-900 antialiased">{children}</body>
    </html>
  );
}
