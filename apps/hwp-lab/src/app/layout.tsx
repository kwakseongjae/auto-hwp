import type { Metadata } from "next";
// @auto-hwp/react 는 자체 CSS를 지참한다(이슈: Tailwind 불필요). 한 번만 import.
import "@auto-hwp/react/styles.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "오토한글 (auto-hwp) — AI와 함께 한 화면에서 쓰는 한글",
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
