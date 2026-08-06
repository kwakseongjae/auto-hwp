import { describe, expect, it } from "vitest";
import { DOCS, docBySlug, resolveRepoPath, rewriteDocLink } from "./docsRegistry";

// /docs 링크 매핑 계약. 레포 마크다운의 상대 링크는 세 갈래로만 나간다:
//   ① 사이트에 실린 문서 → /docs/<slug>   ② docs/assets → /docs-assets   ③ 나머지 → GitHub 폴백.
// "깨진 링크가 조용히 404 되는 것"을 막는 게 이 테스트의 목적이다.

describe("docs 레지스트리", () => {
  it("slug 가 유일하다", () => {
    expect(new Set(DOCS.map((d) => d.slug)).size).toBe(DOCS.length);
  });

  it("모든 file 이 docs/ 바로 아래의 .md 다", () => {
    for (const d of DOCS) expect(d.file).toMatch(/^docs\/[A-Za-z0-9.-]+\.md$/);
  });

  it("docBySlug 는 미등록 slug 에 undefined", () => {
    expect(docBySlug("why")?.file).toBe("docs/WHY.md");
    expect(docBySlug("nope")).toBeUndefined();
  });
});

describe("resolveRepoPath", () => {
  it("./ 와 ../ 를 레포 루트 기준으로 정규화한다", () => {
    expect(resolveRepoPath("./EMBED-GUIDE.md", "docs/WHY.md")).toBe("docs/EMBED-GUIDE.md");
    expect(resolveRepoPath("EMBED-GUIDE.md", "docs/WHY.md")).toBe("docs/EMBED-GUIDE.md");
    expect(resolveRepoPath("../CONTRIBUTING.md", "docs/WHY.md")).toBe("CONTRIBUTING.md");
    expect(resolveRepoPath("./issues/073-bulk-fill.md", "docs/BULK-GUIDE.md")).toBe("docs/issues/073-bulk-fill.md");
  });
});

describe("rewriteDocLink", () => {
  it("절대 URL·앵커는 그대로 둔다", () => {
    expect(rewriteDocLink("https://example.com", "docs/WHY.md")).toEqual({ href: "https://example.com", external: true });
    expect(rewriteDocLink("#english", "docs/WHY.md")).toEqual({ href: "#english", external: false });
  });

  it("사이트에 실린 문서는 /docs/<slug> 로 간다(앵커 보존)", () => {
    expect(rewriteDocLink("./EMBED-GUIDE.md", "docs/WHY.md").href).toBe("/docs/embed/");
    expect(rewriteDocLink("INTENT-SCHEMA.md", "docs/LLM-GUIDE.md").href).toBe("/docs/intent-schema/");
    expect(rewriteDocLink("./EMBED-GUIDE.en.md", "docs/EMBED-GUIDE.md").href).toBe("/docs/embed-en/");
    expect(rewriteDocLink("./CLI-GUIDE.md#설치", "docs/WHY.md").href).toBe("/docs/cli/#설치");
  });

  it("basePath 를 접두한다(정적 데모)", () => {
    expect(rewriteDocLink("./MCP-GUIDE.md", "docs/WHY.md", "/auto-hwp").href).toBe("/auto-hwp/docs/mcp/");
  });

  it("사이트에 없는 레포 문서는 GitHub blob 폴백", () => {
    const r = rewriteDocLink("./SDK-LAYERS.md", "docs/WHY.md");
    expect(r.external).toBe(true);
    expect(r.href).toBe("https://github.com/kwakseongjae/auto-hwp/blob/main/docs/SDK-LAYERS.md");
    expect(rewriteDocLink("../README.md#정확도와-한계", "docs/WHY.md").href).toBe(
      "https://github.com/kwakseongjae/auto-hwp/blob/main/README.md#정확도와-한계",
    );
  });

  it("확장자 없는 레포 경로(디렉터리)는 GitHub tree 폴백", () => {
    expect(rewriteDocLink("../crates/hwp-jsx", "docs/WHY.md").href).toBe(
      "https://github.com/kwakseongjae/auto-hwp/tree/main/crates/hwp-jsx",
    );
  });

  it("docs/assets 이미지는 복사된 정적 경로로 간다", () => {
    expect(rewriteDocLink("./assets/composable-editor-shells.png", "docs/WHY.md").href).toBe(
      "/docs-assets/composable-editor-shells.png",
    );
  });

  it("하위 폴더의 같은 이름 문서는 라우트로 오인하지 않는다", () => {
    // docs/issues/BENCHMARK.md 같은 게 생겨도 /docs/benchmark 로 가로채지 않는다(정규화 경로 비교).
    const r = rewriteDocLink("./issues/BENCHMARK.md", "docs/WHY.md");
    expect(r.external).toBe(true);
    expect(r.href).toContain("/blob/main/docs/issues/BENCHMARK.md");
  });
});
