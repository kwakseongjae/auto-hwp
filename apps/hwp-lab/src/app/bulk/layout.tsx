import type { Metadata } from "next";

// /bulk 전용 메타데이터. 이게 없으면 클라이언트 컴포넌트인 bulk/page.tsx 가 루트 layout.tsx 의
// 메타를 그대로 물려받아 **canonical/og:url 이 사이트 루트를 가리킨다**(정적 데모 out/bulk/index.html
// 에서 실측된 결함) — 검색엔진에는 "루트의 중복 페이지", 공유 카드에는 루트 링크로 새어나간다.
//
// 규칙:
//  - metadataBase 는 루트 layout.tsx 가 정한 것(github.io + basePath 또는 DEMO_SITE_URL)을 **상속**한다.
//    여기서 오리진을 다시 조립하지 않는다 — 상대 경로만 쓰면 metadataBase 가 절대화한다.
//  - Next 의 metadata 병합은 **얕다**: openGraph/twitter 를 선언하는 순간 부모 객체 전체가 교체되므로
//    og:image·siteName·locale 까지 같은 값으로 다시 적어야 한다(빠뜨리면 카드에서 사라진다).
//  - title 은 문자열만 주고 루트의 template("%s · 오토한글 (auto-hwp)")을 태운다. 반면 og/twitter 의
//    title 은 template 을 타지 않으므로 완성형 문자열을 명시한다.
const TITLE = "양식 일괄 작성";
const OG_TITLE = "양식 일괄 작성 · 오토한글 (auto-hwp)";
const DESCRIPTION =
  "양식 하나와 명단만 있으면 사람 수만큼 완성본을 한 번에 만듭니다. 채울 자리를 문서에서 직접 찍고 엑셀 명단을 붙여넣으면 끝 — 설치도 회원가입도 없이, 양식·채움·검증이 전부 기기 안에서(Rust+wasm) 돌아갑니다.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/bulk/" },
  openGraph: {
    type: "website",
    locale: "ko_KR",
    siteName: "오토한글 (auto-hwp)",
    url: "/bulk/",
    title: OG_TITLE,
    description: DESCRIPTION,
    images: [
      {
        url: "/og.png",
        width: 1200,
        height: 630,
        type: "image/png",
        alt: "오토한글 양식 일괄 작성 — 양식 하나 + 명단 → 사람 수만큼 완성본 zip",
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

export default function BulkLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
