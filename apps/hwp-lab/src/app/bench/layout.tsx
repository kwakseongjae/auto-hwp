import type { Metadata } from "next";

// /bench 전용 메타데이터. bulk/layout.tsx 와 같은 이유·같은 규칙이다:
//  - metadataBase 는 루트 layout.tsx 가 정한 것을 **상속**한다(여기서 오리진을 다시 조립하지 않는다).
//    상대 경로만 쓰면 metadataBase 가 절대화한다.
//  - Next 의 metadata 병합은 **얕다**: openGraph/twitter 를 선언하는 순간 부모 객체 전체가 교체되므로
//    og:image·siteName·locale 까지 같은 값으로 다시 적어야 한다.
//  - title 은 문자열만 주고 루트의 template("%s · 오토한글 (auto-hwp)")을 태운다. og/twitter 의 title 은
//    template 을 타지 않으므로 완성형 문자열을 명시한다.
const TITLE = "충실도 벤치마크";
const OG_TITLE = "충실도 벤치마크 · 오토한글 (auto-hwp)";
const DESCRIPTION =
  "한글이 문서에 저장해 둔 줄바꿈(lineseg)을 정답지로 놓고 우리 조판을 자동 대조합니다. 쪽수 게이트, 본문 줄바꿈 정확 일치율, 표 셀 lineseg, 캐럿 좌표, HWPX 파서 파리티 — 모든 수치에 재현 커맨드와 한계 고지를 함께 답니다.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/bench/" },
  openGraph: {
    type: "website",
    locale: "ko_KR",
    siteName: "오토한글 (auto-hwp)",
    url: "/bench/",
    title: OG_TITLE,
    description: DESCRIPTION,
    images: [
      {
        url: "/og.png",
        width: 1200,
        height: 630,
        type: "image/png",
        alt: "오토한글 충실도 벤치마크 — 한컴 저장 lineseg 오라클 대비 자동 게이트",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: OG_TITLE,
    description: DESCRIPTION,
    images: ["/og.png"],
  },
};

export default function BenchLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
