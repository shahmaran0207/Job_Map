import type { Metadata, Viewport } from 'next';
import './globals.css';

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
