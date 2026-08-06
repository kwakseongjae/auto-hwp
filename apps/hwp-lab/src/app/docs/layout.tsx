import type { Metadata } from "next";

// /docs 허브 메타데이터. bench/layout.tsx 와 같은 규칙:
//  - metadataBase 는 루트 layout.tsx 것을 상속한다(여기서 오리진을 다시 조립하지 않는다).
//  - Next 의 metadata 병합은 얕다 — openGraph 를 선언하면 부모 객체가 통째로 교체되므로
//    siteName/locale/images 까지 다시 적는다.
//  - 하위 /docs/[slug] 는 자기 generateMetadata 로 이걸 다시 덮어쓴다.
const TITLE = "문서";
const OG_TITLE = "오토한글 문서 — 임베드 · CLI · MCP · Intent";
const DESCRIPTION =
  "오토한글(auto-hwp) 사용자 문서 허브. React 임베드 가이드(한/영), CLI, MCP 서버, 양식 일괄 작성, LLM 연동, Intent 스키마, 충실도 벤치마크, 셀프호스팅 — 레포 마크다운 원문에서 빌드할 때 생성됩니다.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/docs/" },
  openGraph: {
    type: "website",
    locale: "ko_KR",
    siteName: "오토한글 (auto-hwp)",
    url: "/docs/",
    title: OG_TITLE,
    description: DESCRIPTION,
    images: [
      { url: "/og.png", width: 1200, height: 630, type: "image/png", alt: "오토한글 문서 허브" },
    ],
  },
  twitter: { card: "summary_large_image", title: OG_TITLE, description: DESCRIPTION, images: ["/og.png"] },
};

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
