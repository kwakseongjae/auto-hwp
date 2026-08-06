import { expect, test } from "@playwright/test";

// 사이트화(/docs 허브 + 문서 페이지) e2e.
// 이 스펙이 잠그는 것:
//   ① 허브가 레포 마크다운을 실제로 렌더한 문서 카드를 낸다(빌드 타임 로딩이 죽지 않았다)
//   ② 허브 → 문서 이동 → 본문이 GitHub 원문에서 온 실제 내용이다
//   ③ 우측 TOC 앵커가 본문 heading id 와 맞아 실제로 스크롤한다(rehype-slug ↔ TOC 슬러거 일치)
//   ④ 문서 간 상대 링크가 GitHub 로 새지 않고 사이트 라우트로 간다
// wasm/엔진과 무관한 정적 페이지라 문서 열기·편집 경로를 건드리지 않는다.

test("docs 허브가 그룹별 문서 카드를 낸다", async ({ page }) => {
  await page.goto("/docs");
  await expect(page.getByRole("heading", { name: "오토한글 문서", level: 1 })).toBeVisible();

  // 좌측 네비 + 카드 양쪽에 같은 문서가 있다.
  await expect(page.locator('[data-testid="docs-nav"]')).toBeVisible();
  for (const slug of ["why", "embed", "mcp", "intent-schema"]) {
    await expect(page.locator(`[data-testid="doc-card-${slug}"]`)).toBeVisible();
  }
});

test("허브 → 문서 → TOC 앵커", async ({ page }) => {
  await page.goto("/docs");
  await page.locator('[data-testid="doc-card-embed"]').click();

  await expect(page).toHaveURL(/\/docs\/embed\/?$/);
  await expect(page.locator('[data-testid="doc-title"]')).toHaveText("임베드 가이드 (React SDK)");

  // 본문은 docs/EMBED-GUIDE.md 원문에서 온 것 — 원문에만 있는 문자열로 확인한다.
  const body = page.locator('[data-testid="doc-body"]');
  await expect(body).toContainText("@auto-hwp/react");
  // 코드 펜스가 하이라이트 처리되어 들어왔다(빌드 타임 rehype-highlight).
  expect(await body.locator("pre code.hljs").count()).toBeGreaterThan(0);

  // 우측 TOC → 첫 항목 클릭 → 해당 heading 이 뷰포트 안으로 들어온다.
  const toc = page.locator('[data-testid="doc-toc"]');
  await expect(toc).toBeVisible();
  const first = toc.locator("li a").first();
  const href = await first.getAttribute("href");
  expect(href).toMatch(/^#.+/);
  const id = href!.slice(1);
  await first.click();
  // 한글 앵커는 URL 에서 퍼센트 인코딩되므로 디코드해 비교한다.
  await expect
    .poll(() => decodeURIComponent(new URL(page.url()).hash))
    .toBe(href);

  // ⚠️ id 가 숫자로 시작하는 heading("1-설치-…")이 흔해서 `#id` CSS 선택자는 못 쓴다 — 속성 선택자로 잡는다.
  const target = page.locator(`[data-testid="doc-body"] [id="${id}"]`);
  await expect(target).toBeInViewport({ timeout: 10_000 });
});

test("문서 안의 상대 링크가 사이트 라우트로 매핑된다", async ({ page }) => {
  await page.goto("/docs/why");
  const body = page.locator('[data-testid="doc-body"]');
  // WHY.md 는 ./EMBED-GUIDE.md·./CLI-GUIDE.md·./INTENT-SCHEMA.md 를 건다 — 전부 사이트에 실린 문서다.
  // ⚠️ 본문 링크는 **슬래시로 끝난다**(Pages 정적 export 의 디렉터리 인덱스 — rewriteDocLink 참조).
  // `$="/docs/embed"` 로 잡으면 영원히 0건이다(2026-08-06 실측). 양쪽 형태를 다 인정한다.
  const embed = body.locator('a[href="/docs/embed/"], a[href="/docs/embed"]');
  await expect(embed.first()).toBeVisible();
  await embed.first().click();
  await expect(page.locator('[data-testid="doc-title"]')).toHaveText("임베드 가이드 (React SDK)");
});

test("랜딩에 사이트 헤더·문서 동선·푸터가 있다", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator('[data-testid="lab-hero"]')).toBeVisible();

  // 사이트 헤더의 Docs 링크
  const docsNav = page.locator('header nav[aria-label="사이트"] a', { hasText: "Docs" });
  await expect(docsNav).toHaveCount(1);

  // 기능 쇼케이스(GIF 3종) — 지연 로드라 뷰포트에 넣고 확인한다.
  const showcase = page.locator('[data-testid="landing-showcase"]');
  await showcase.scrollIntoViewIfNeeded();
  await expect(showcase.locator("img")).toHaveCount(3);

  await page.locator('[data-testid="docs-link"]').click();
  await expect(page).toHaveURL(/\/docs\/?$/);
});
