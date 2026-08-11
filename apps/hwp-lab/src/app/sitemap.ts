import type { MetadataRoute } from "next";
import { DOCS } from "./docs/docsRegistry";

// sitemap.xml — 정적 생성. `output:"export"`(build:demo/Pages)에서도 out/sitemap.xml 로 떨어진다.
// 오리진은 layout.tsx 와 **같은 규칙**으로 조립한다(NEXT_PUBLIC_SITE_URL 우선, 없으면 Pages 기본).
export const dynamic = "force-static";

const BASE = process.env.NEXT_PUBLIC_BASE_PATH || "";
const SITE = (process.env.NEXT_PUBLIC_SITE_URL || `https://kwakseongjae.github.io${BASE}`).replace(/\/+$/, "");
const SLASH = process.env.NEXT_PUBLIC_DEMO === "1" ? "/" : "";

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  return [
    { url: `${SITE}/`, lastModified: now, changeFrequency: "weekly", priority: 1 },
    { url: `${SITE}/bulk${SLASH}`, lastModified: now, changeFrequency: "monthly", priority: 0.8 },
    { url: `${SITE}/bench${SLASH}`, lastModified: now, changeFrequency: "monthly", priority: 0.7 },
    { url: `${SITE}/docs${SLASH}`, lastModified: now, changeFrequency: "weekly", priority: 0.8 },
    { url: `${SITE}/privacy${SLASH}`, lastModified: now, changeFrequency: "yearly", priority: 0.4 },
    ...DOCS.map((d) => ({
      url: `${SITE}/docs/${d.slug}${SLASH}`,
      lastModified: now,
      changeFrequency: "monthly" as const,
      priority: 0.6,
    })),
  ];
}
