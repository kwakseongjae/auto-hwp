import type { MetadataRoute } from "next";

// robots.txt — 정적 생성(export 에서도 out/robots.txt 로 떨어진다).
// /api/* 는 크롤링 대상이 아니다(AI 프록시 — 정적 데모에는 아예 없다).
export const dynamic = "force-static";

const BASE = process.env.NEXT_PUBLIC_BASE_PATH || "";
const SITE = (process.env.NEXT_PUBLIC_SITE_URL || `https://kwakseongjae.github.io${BASE}`).replace(/\/+$/, "");

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: "/", disallow: ["/api/"] }],
    sitemap: `${SITE}/sitemap.xml`,
  };
}
