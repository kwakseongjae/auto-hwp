// 사이트 링크 조립 단일 지점.
//
// 두 배포 형태가 URL 모양이 다르다:
//  · full Next(Vercel)      → `/docs/embed`
//  · 정적 export(Pages)     → `trailingSlash: true` 라 `out/docs/embed/index.html` = `/docs/embed/`
// 슬래시를 빼먹으면 정적 호스트에서 리다이렉트 한 번을 더 타고(또는 404 가 되고), 붙이면 full Next
// 가 슬래시를 떼는 리다이렉트를 탄다. 그래서 **한 곳**에서 배포 형태를 보고 결정한다.
// (basePath 는 프로젝트 페이지 배포 전용 — 코드의 절대경로는 자동 접두되지 않는다.)
export const BASE = process.env.NEXT_PUBLIC_BASE_PATH || "";
const SLASH = process.env.NEXT_PUBLIC_DEMO === "1" ? "/" : "";

/** `siteHref("/docs/embed")` → `/docs/embed` 또는 `/auto-hwp/docs/embed/` */
export function siteHref(path: string): string {
  if (path === "/") return `${BASE}/`;
  return `${BASE}${path}${SLASH}`;
}

/** 문서 라우트 전용 단축 — `docHref("embed")` */
export function docHref(slug: string): string {
  return siteHref(`/docs/${slug}`);
}
