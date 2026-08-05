import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { placeCellCaret, selectFirstCell } from "./cell-gesture";

// 048의 제품 표면은 상단 영속 리본에서 우측 Figma식 inspector로 이동했다. 상단은 문서 전역 도구만,
// 선택 서식은 디자인 탭만 소유하고, 엔진 캐럿 편집 중에는 문서를 가리는 셀 팔레트가 없어야 한다.
const BENCHMARK = path.resolve(process.cwd(), "..", "..", "benchmarks", "benchmark.hwp");

async function open(page: Page) {
  await page.goto("/");
  await page.locator('[data-testid="file-input"]').setInputFiles(BENCHMARK);
  await expect(page.locator(".hw-sheet svg").first()).toBeVisible({ timeout: 60_000 });
}

test("선택 전 바이브 기본 → 셀 선택 시 디자인 자동 전환 → inspector에서 굵게·배경 적용", async ({ page }) => {
  await open(page);
  await expect(page.locator('[data-testid="hw-format-ribbon"]')).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "바이브 편집", exact: true })).toHaveAttribute("aria-selected", "true");

  await selectFirstCell(page);
  if ((await page.locator(".hw-caret").count()) > 0) {
    await page.keyboard.press("Escape"); // 텍스트 편집 → 요소 선택 단계(셀 inspector 복귀)
  }
  await expect(page.getByRole("tab", { name: "디자인", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator('[data-testid="hw-design-panel"]')).toBeVisible();

  const bold = page.locator('[data-testid="hw-design-bold"]');
  await expect(bold).toBeEnabled();
  await bold.click();
  await expect(page.locator(".hw-status")).toContainText("굵게", { timeout: 30_000 });

  await expect(page.locator('[data-testid="hw-design-shade"]')).toBeVisible();
  await page.locator('[data-testid="hw-design-shade"]').evaluate((el: HTMLInputElement) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    setter.call(el, "#ffe08a");
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect(page.locator(".hw-status")).toContainText("배경색 적용", { timeout: 30_000 });
});

test("엔진 캐럿 편집은 SVG를 유지하고 선택 틴트·셀 팔레트 없이 텍스트 도구만 보인다", async ({ page }) => {
  await open(page);
  await placeCellCaret(page);

  await expect(page.locator(".hw-caret")).toBeVisible();
  await expect(page.locator(".hw-workspace")).toHaveClass(/is-text-editing/);
  await expect(page.getByRole("tab", { name: "디자인", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByText("텍스트 편집 중", { exact: true })).toBeVisible();
  await expect(page.locator('[data-testid="hw-cell-shade-palette"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="hw-design-shade"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="hw-inplace-editor"]')).toHaveCount(0);

  const fill = await page.locator(".hw-mark-cell").first().evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(fill).toBe("rgba(0, 0, 0, 0)");

  await page.keyboard.type("QX", { delay: 300 });
  await expect(page.locator(".hw-pages")).toContainText("QX", { timeout: 30_000 });
  await page.locator('.hw-tool[title="실행취소"]').click();
  await page.locator('.hw-tool[title="실행취소"]').click();
  await expect(page.locator(".hw-pages")).not.toContainText("QX", { timeout: 30_000 });
});
