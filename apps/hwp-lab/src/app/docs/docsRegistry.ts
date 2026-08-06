// /docs 허브 레지스트리 — "레포의 마크다운 중 **사용자향** 문서만" 사이트에 싣는다.
//
// 규율:
//  - 여기 없는 docs/*.md 는 사이트에 뜨지 않는다(설계 노트·이슈·저널은 GitHub 몫). 문서를 늘리려면
//    이 배열에 한 줄 추가하면 라우트·네비·sitemap·링크 매핑이 전부 따라온다.
//  - `file` 은 **레포 루트 기준** 경로다(빌드 타임에 ../../ 로 읽는다 — docsSource.ts).
//  - 이 모듈은 **순수**하다(node:fs·next import 금지). 링크 재작성 규칙을 vitest 가 그대로 검증한다.

export type DocGroup = "start" | "integrate" | "deep";

export type DocEntry = {
  /** /docs/<slug> */
  slug: string;
  /** 레포 루트 기준 경로 */
  file: string;
  /** 사이트 표기 제목 (문서 첫 h1 대신 이걸 쓴다 — 네비/카드/OG 가 같은 이름을 본다) */
  title: string;
  /** 허브 카드 1줄 요약 */
  summary: string;
  group: DocGroup;
  /** 문서 본문 언어. 기본 ko. */
  lang?: "ko" | "en";
};

export const DOC_GROUPS: { id: DocGroup; label: string; blurb: string }[] = [
  { id: "start", label: "시작하기", blurb: "무엇인지, 어디서부터 만져 보면 되는지" },
  { id: "integrate", label: "통합", blurb: "내 앱·CLI·AI 도구에 붙이는 방법" },
  { id: "deep", label: "심화", blurb: "계약·수치·직접 운영" },
];

export const DOCS: DocEntry[] = [
  {
    slug: "why",
    file: "docs/WHY.md",
    title: "왜 엔진을 직접 만들었나",
    summary: "텍스트 추출이 문서를 둘로 가르는 문제와, 하나의 문서 모델로 여는 설계 배경.",
    group: "start",
  },
  {
    slug: "bulk",
    file: "docs/BULK-GUIDE.md",
    title: "양식 일괄 작성 가이드",
    summary: "양식 1개 + 명단 N행 → 완성본 N부. 채우기 규칙과 검수 흐름.",
    group: "start",
  },
  {
    slug: "cli",
    file: "docs/CLI-GUIDE.md",
    title: "CLI 가이드",
    summary: "auto-hwp 커맨드로 열기·렌더·조판 점검·내보내기를 터미널에서.",
    group: "start",
  },
  {
    slug: "embed",
    file: "docs/EMBED-GUIDE.md",
    title: "임베드 가이드 (React SDK)",
    summary: "내 웹앱에 편집기를 얹는 최단 경로 — 패키지, 에셋, 패널 배치.",
    group: "integrate",
  },
  {
    slug: "embed-en",
    file: "docs/EMBED-GUIDE.en.md",
    title: "Embed Guide (English)",
    summary: "Drop the editor into your React app — packages, assets, panel layout.",
    group: "integrate",
    lang: "en",
  },
  {
    slug: "llm",
    file: "docs/LLM-GUIDE.md",
    title: "LLM 연동 가이드",
    summary: "문서 프로필·Intent 로 LLM 을 붙이는 배선과 함정 목록.",
    group: "integrate",
  },
  {
    slug: "mcp",
    file: "docs/MCP-GUIDE.md",
    title: "MCP 서버 가이드",
    summary: "로컬 stdio MCP 로 Claude/Cursor 에 연결 — 문서는 기기 밖으로 나가지 않는다.",
    group: "integrate",
  },
  {
    slug: "intent-schema",
    file: "docs/INTENT-SCHEMA.md",
    title: "Intent 스키마",
    summary: "AI 가 낼 수 있는 편집 명령의 전체 계약(v0) — 필드·제약·거부 규칙.",
    group: "deep",
  },
  {
    slug: "benchmark",
    file: "docs/BENCHMARK.md",
    title: "충실도 벤치마크 (원문)",
    summary: "한컴 저장 lineseg 오라클 대비 게이트 수치와 재현 커맨드.",
    group: "deep",
  },
  {
    slug: "self-host",
    file: "docs/SELF-HOST.md",
    title: "셀프호스팅",
    summary: "컨테이너·서비스로 직접 굴릴 때의 배선, 한계, 보안 주의.",
    group: "deep",
  },
];

export const REPO = "https://github.com/kwakseongjae/auto-hwp";
const GITHUB_BLOB = `${REPO}/blob/main`;
const GITHUB_TREE = `${REPO}/tree/main`;

export function docBySlug(slug: string): DocEntry | undefined {
  return DOCS.find((d) => d.slug === slug);
}

export function docsInGroup(group: DocGroup): DocEntry[] {
  return DOCS.filter((d) => d.group === group);
}

/** `docs/EMBED-GUIDE.en.md` → `EMBED-GUIDE.en.md` */
function basename(p: string): string {
  return p.slice(p.lastIndexOf("/") + 1);
}

/** 마크다운 파일명 → 사이트 slug (사이트에 실린 문서만). */
const BY_FILENAME = new Map<string, DocEntry>(DOCS.map((d) => [basename(d.file), d]));

export type RewrittenLink = {
  href: string;
  /** 레포(GitHub)로 나가는 링크인가 — 새 창 + rel 을 붙이고 아이콘을 단다. */
  external: boolean;
};

/**
 * 마크다운 안의 상대 링크를 사이트 라우트로 매핑한다.
 *
 * 규칙(우선순위 순):
 *  1. 절대 URL(http/https/mailto) · 페이지 내 앵커(#…) → 그대로.
 *  2. `./FOO.md` / `FOO.md` — 레지스트리에 있으면 `/docs/<slug>`(앵커 보존), 없으면 GitHub blob.
 *  3. `./assets/x.png` → 빌드 때 복사해 둔 `/docs-assets/x.png`.
 *  4. 그 밖의 레포 상대경로(`../README.md`, `../crates/hwp-jsx`, `./issues/073-…`) → **GitHub 폴백**.
 *     디렉터리(확장자 없음)는 tree/, 파일은 blob/ 로 보낸다.
 *
 * `base` 는 정적 데모의 basePath(NEXT_PUBLIC_BASE_PATH). 없으면 빈 문자열.
 * `fromFile` 은 링크를 담은 문서의 레포 경로 — `./`, `../` 를 레포 루트 기준으로 정규화한다.
 */
export function rewriteDocLink(href: string, fromFile: string, base = ""): RewrittenLink {
  if (!href) return { href, external: false };
  if (/^(https?:|mailto:|tel:)/i.test(href)) return { href, external: true };
  if (href.startsWith("#")) return { href, external: false };

  const hashAt = href.indexOf("#");
  const path = hashAt >= 0 ? href.slice(0, hashAt) : href;
  const hash = hashAt >= 0 ? href.slice(hashAt) : "";

  // 문서 간 링크: 파일명만 보고 매핑한다(같은 이름의 다른 폴더 문서는 레지스트리에 없으므로 안전).
  const name = basename(path);
  const target = BY_FILENAME.get(name);
  // `./issues/073-…` 처럼 하위 폴더로 내려가는 링크는 파일명이 겹칠 일이 없지만, 명시적으로
  // "docs/ 바로 아래"만 라우트로 인정한다 — 나머지는 GitHub 폴백.
  const normalized = resolveRepoPath(path, fromFile);
  if (target && normalized === target.file) {
    // Pages 정적 export(trailingSlash: true)에서 디렉터리 인덱스로 해석되도록 슬래시를 붙인다 —
    // 없으면 /docs/<slug> → 404 (Vercel에서는 양쪽 다 동작).
    return { href: `${base}/docs/${target.slug}/${hash}`, external: false };
  }

  if (normalized.startsWith("docs/assets/")) {
    return { href: `${base}/docs-assets/${basename(normalized)}`, external: false };
  }

  const isDir = !/\.[a-z0-9]+$/i.test(basename(normalized));
  return { href: `${isDir ? GITHUB_TREE : GITHUB_BLOB}/${normalized}${hash}`, external: true };
}

/** `./EMBED-GUIDE.md` + `docs/WHY.md` → `docs/EMBED-GUIDE.md` (레포 루트 기준 정규화). */
export function resolveRepoPath(relative: string, fromFile: string): string {
  if (relative.startsWith("/")) return relative.replace(/^\/+/, "");
  const dir = fromFile.slice(0, fromFile.lastIndexOf("/"));
  const parts = dir ? dir.split("/") : [];
  for (const seg of relative.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}
