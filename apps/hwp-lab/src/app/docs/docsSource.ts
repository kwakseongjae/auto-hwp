// 빌드 타임 마크다운 로더 — 레포 docs/*.md 를 읽어 HTML + TOC 로 만든다.
//
// ⚠️ **빌드 타임 전용**이다. /docs 라우트는 전부 `generateStaticParams` + 정적 생성이라 이 코드는
// `next build`(그리고 `build:demo` 의 `output:"export"`) 동안 한 번만 돈다 — 런타임 서버도,
// 클라이언트 번들도 이 모듈을 싣지 않는다(unified/remark/rehype 는 전부 devDependencies).
// 그래서 `../../docs` 를 fs 로 읽어도 서버리스 함수 번들 추적 문제가 없다. 같은 이유로 이 앱의
// 다른 prebuild 훅(copy-wasm/copy-fonts/copy-samples)도 레포 루트를 읽는다 — 빌드 환경은
// 이미 레포 전체를 갖고 있어야 한다.
//
// 신뢰 경계: 입력은 **우리가 레포에 커밋한 마크다운**이다(사용자 입력 아님). 그래서 rehype-raw 로
// 원문 HTML(WHY.md 의 <p align="center"><img …>)을 살린다. 외부 마크다운을 이 파이프라인에
// 태우게 되면 rehype-sanitize 를 반드시 끼워야 한다.
import { readFileSync } from "node:fs";
import path from "node:path";
import rehypeHighlight from "rehype-highlight";
import rehypeRaw from "rehype-raw";
import rehypeSlug from "rehype-slug";
import rehypeStringify from "rehype-stringify";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { visit } from "unist-util-visit";
import type { DocEntry } from "./docsRegistry";
import { rewriteDocLink } from "./docsRegistry";

const REPO_ROOT = path.join(process.cwd(), "..", "..");
const BASE = process.env.NEXT_PUBLIC_BASE_PATH || "";

export type TocItem = { id: string; text: string; depth: 2 | 3 };

export type RenderedDoc = {
  html: string;
  toc: TocItem[];
};

type HastNode = {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
  value?: string;
};

/**
 * 링크/이미지 src 를 사이트 라우트로 갈아끼우는 rehype 플러그인 **팩토리**.
 * `.use(rehypeRepoLinks(file))` 로 붙이므로 반환값 자체가 attacher(= () => transformer)여야 한다.
 */
function rehypeRepoLinks(fromFile: string) {
  return () => (tree: HastNode) => {
    visit(tree as never, "element", (node: HastNode) => {
      if (node.tagName === "a") {
        const href = node.properties?.href;
        if (typeof href !== "string") return;
        const { href: next, external } = rewriteDocLink(href, fromFile, BASE);
        node.properties!.href = next;
        if (external) {
          node.properties!.target = "_blank";
          node.properties!.rel = "noreferrer";
          node.properties!["dataExternal"] = "1";
        }
      } else if (node.tagName === "img") {
        const src = node.properties?.src;
        if (typeof src !== "string") return;
        node.properties!.src = rewriteDocLink(src, fromFile, BASE).href;
        // 문서 이미지는 전부 본문 아래쪽에 있다 — 첫 페인트를 막지 않게 지연 로드.
        node.properties!.loading = "lazy";
        node.properties!.decoding = "async";
      }
    });
  };
}

/**
 * 넓은 표는 **페이지 전체**를 가로 스크롤시킨다(모바일에서 레이아웃이 통째로 밀린다).
 * 표마다 `div.tableScroll` 로 감싸 스크롤을 그 상자 안에 가둔다 — CSS 만으로는 못 한다
 * (표 자신에 overflow 를 걸면 border-collapse 가 깨진다).
 */
function rehypeWrapTables() {
  return (tree: HastNode) => {
    visit(tree as never, "element", (node: HastNode, index: number | undefined, parent: HastNode | undefined) => {
      if (node.tagName !== "table" || !parent || index == null) return;
      if (parent.tagName === "div" && (parent.properties?.className as string[] | undefined)?.includes("tableScroll")) return;
      parent.children![index] = {
        type: "element",
        tagName: "div",
        properties: { className: ["tableScroll"] },
        children: [node],
      };
    });
  };
}

/** 첫 h1(문서 제목)은 사이트가 자기 헤더로 다시 그리므로 본문에서 지운다. */
function rehypeDropLeadingH1() {
  return (tree: HastNode) => {
    const kids = tree.children ?? [];
    const first = kids.findIndex((n) => n.type === "element");
    if (first >= 0 && kids[first].tagName === "h1") kids.splice(first, 1);
  };
}

function textOf(node: HastNode): string {
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(textOf).join("");
}

const processor = (fromFile: string) =>
  unified()
    .use(remarkParse)
    .use(remarkGfm)
    // allowDangerousHtml + rehype-raw: 우리 문서의 원문 HTML(정렬된 이미지 캡션 등)을 살린다.
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw)
    .use(rehypeDropLeadingH1)
    // rehype-slug 는 github-slugger 를 쓴다 = GitHub 과 같은 앵커 id → 문서 안 `#앵커` 링크가 그대로 산다.
    .use(rehypeSlug)
    .use(rehypeRepoLinks(fromFile))
    .use(rehypeWrapTables)
    .use(rehypeHighlight, { detect: false, ignoreMissing: true })
    .use(rehypeStringify, { allowDangerousHtml: true });

/** 본문 h2/h3 로 TOC 를 만든다. rehype-slug 와 **같은 슬러거**를 같은 순서로 돌려 id 를 일치시킨다. */
function buildToc(tree: HastNode): TocItem[] {
  const out: TocItem[] = [];
  visit(tree as never, "element", (node: HastNode) => {
    if (node.tagName !== "h2" && node.tagName !== "h3") return;
    const id = node.properties?.id;
    if (typeof id !== "string") return;
    const text = textOf(node).trim();
    if (!text) return;
    out.push({ id, text, depth: node.tagName === "h2" ? 2 : 3 });
  });
  return out;
}

export function readDoc(entry: DocEntry): RenderedDoc {
  const raw = readFileSync(path.join(REPO_ROOT, entry.file), "utf8");
  const proc = processor(entry.file);
  const mdast = proc.parse(raw);
  const hast = proc.runSync(mdast) as unknown as HastNode;
  const html = proc.stringify(hast as never) as string;
  const toc = buildToc(hast);

  return { html, toc };
}
