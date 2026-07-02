import type { Metadata } from "next";
// @tf-hwp/react 는 자체 CSS를 지참한다(이슈: Tailwind 불필요). 한 번만 import.
import "@tf-hwp/react/styles.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "hwp-lab — tf-hwp 통합 실험 앱",
  description:
    "HWP 업로드 → 전 페이지 SVG 렌더 → 표 마킹 + 채팅 바이브편집(서버 프록시) → 프리뷰/적용/undo → HTML/PDF. QA 전용.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
