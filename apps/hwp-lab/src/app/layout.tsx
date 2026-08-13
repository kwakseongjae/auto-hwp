import type { Metadata } from "next";
// @auto-hwp/react 는 자체 CSS를 지참한다(이슈: Tailwind 불필요). 한 번만 import.
import "@auto-hwp/react/styles.css";
import "./globals.css";
import { THEME_BOOT_SCRIPT } from "@/lib/theme";
import { AnalyticsConsent } from "@/components/AnalyticsConsent";

// 정적 데모(GitHub Pages)는 basePath(/auto-hwp) 아래에 산다. OG/twitter 는 **절대 URL**만 유효하고
// (스크래퍼가 상대경로를 못 푼다) favicon 링크는 basePath 접두가 필요하다 — 코드의 다른 절대경로
// fetch(/hwp, /fonts, /samples)와 같은 규칙(NEXT_PUBLIC_BASE_PATH)을 그대로 쓴다.
// 커스텀 도메인으로 옮기면 DEMO_SITE_URL 로 오리진만 덮어쓰면 된다(next.config.mjs).
const BASE = process.env.NEXT_PUBLIC_BASE_PATH || "";
const SITE = (process.env.NEXT_PUBLIC_SITE_URL || `https://kwakseongjae.github.io${BASE}`).replace(/\/+$/, "");

// 가치제안 한 줄 — "QA 전용"(자기부정) 대체. 과장 금지: 데모 입력은 아직 .hwp 이고(HWPX 는 내보내기),
// AI 편집만 동의 후 프록시를 거친다(README §설치 없이 웹에서 써보기와 같은 사실).
const DESCRIPTION =
  "브라우저에서 한글(HWP) 문서를 열고, 고치고, PDF·HTML·HWPX로 내보냅니다. 설치도 회원가입도 없이 — 열기·렌더·편집·내보내기가 전부 기기 안에서(Rust+wasm) 돌아갑니다.";
const OG_DESCRIPTION = `${DESCRIPTION} 양식 1개 + 명단 N행이면 완성본 N부 일괄 작성까지.`;
const TITLE = "오토한글 (auto-hwp) — 브라우저에서 열고 고치는 한글(HWP) 문서";
const GOOGLE_SITE_VERIFICATION = process.env.NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION || "";
const NAVER_SITE_VERIFICATION = process.env.NEXT_PUBLIC_NAVER_SITE_VERIFICATION || "";

export const metadata: Metadata = {
  metadataBase: new URL(`${SITE}/`),
  title: { default: TITLE, template: "%s · 오토한글 (auto-hwp)" },
  description: DESCRIPTION,
  applicationName: "오토한글 (auto-hwp)",
  keywords: ["한글 문서", "HWP", "HWPX", "HWP 뷰어", "HWP 편집", "PDF 변환", "양식 일괄 작성", "auto-hwp", "오토한글"],
  alternates: { canonical: "/" },
  verification: {
    ...(GOOGLE_SITE_VERIFICATION ? { google: GOOGLE_SITE_VERIFICATION } : {}),
    ...(NAVER_SITE_VERIFICATION ? { other: { "naver-site-verification": NAVER_SITE_VERIFICATION } } : {}),
  },
  icons: {
    icon: [
      { url: `${BASE}/favicon.ico`, sizes: "48x48 32x32 16x16", type: "image/x-icon" },
      { url: `${BASE}/icon.png`, sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: `${BASE}/apple-icon.png`, sizes: "180x180", type: "image/png" }],
  },
  openGraph: {
    type: "website",
    locale: "ko_KR",
    siteName: "오토한글 (auto-hwp)",
    url: `${SITE}/`,
    title: TITLE,
    description: OG_DESCRIPTION,
    images: [
      {
        url: `${SITE}/og.png`,
        width: 1200,
        height: 630,
        type: "image/png",
        alt: "오토한글 — AI와 함께, 한 화면을 보면서 쓰는 한글",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: OG_DESCRIPTION,
    images: [`${SITE}/og.png`],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // suppressHydrationWarning: 아래 부트 스크립트가 하이드레이션 **전에** <html data-theme> 를 세운다
    // (서버 HTML 에는 없는 속성이므로 경고가 뜨는데, 그게 정확히 의도한 동작이다).
    <html lang="ko" suppressHydrationWarning>
      <body>
        {/* 첫 페인트 전에 테마를 확정한다 — 동기 스크립트라 여기서 파싱이 잠깐 멈추고,
            그 사이 data-theme 이 서므로 다크↔라이트 깜빡임이 없다(정적 export 에서도 동작). */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
        {children}
        <AnalyticsConsent />
      </body>
    </html>
  );
}
