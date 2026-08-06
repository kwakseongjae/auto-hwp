import type { MetadataRoute } from "next";

// robots.txt — 정적 생성(export 에서도 out/robots.txt 로 떨어진다).
// /api/* 는 크롤링 대상이 아니다(AI 프록시 — 정적 데모에는 아예 없다).
// /d/* 는 **문서 세션 URL**이다: 열쇠는 그 브라우저 안에만 있어 크롤러에게는 언제나 빈 랜딩이다.
// 색인해 봐야 중복 페이지만 늘어나므로 처음부터 막는다(canonical 은 layout 이 "/" 로 고정한다).
export const dynamic = "force-static";

const BASE = process.env.NEXT_PUBLIC_BASE_PATH || "";
const SITE = (process.env.NEXT_PUBLIC_SITE_URL || `https://kwakseongjae.github.io${BASE}`).replace(/\/+$/, "");

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: "/", disallow: ["/api/", "/d/"] }],
    sitemap: `${SITE}/sitemap.xml`,
  };
}
