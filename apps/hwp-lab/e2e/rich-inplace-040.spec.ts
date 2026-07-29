import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { placeCellCaret } from "./cell-gesture";

// 040의 run 보존 계약을 full-box contentEditable 대신 엔진 캐럿 범위 + 디자인 inspector로 검증한다.
// 문서 SVG는 편집 중에도 그대로이며, 선택 범위 서식은 SetTableCellRuns로 즉시 커밋된다.
const BENCHMARK = path.resolve(process.cwd(), "..", "..", "benchmarks", "benchmark.hwp");

async function open(page: Page) {
  await page.goto("/");
  await page.locator('[data-testid="file-input"]').setInputFiles(BENCHMARK);
  await expect(page.locator(".hw-sheet svg").first()).toBeVisible({ timeout: 60_000 });
}

async function glyphBold(page: Page, ch: string): Promise<boolean> {
  return page.locator('.hw-sheet[data-page="0"] text').filter({ hasText: ch }).first().evaluate((el) => {
    const weight = getComputedStyle(el).fontWeight;
    return weight === "bold" || Number.parseInt(weight, 10) >= 600;
  });
}

test("엔진 캐럿 범위 → 디자인 B → 선택 부분만 run 서식 → SVG 즉시 반영", async ({ page }) => {
  await open(page);
  await placeCellCaret(page);
  await page.keyboard.type("QWERTY", { delay: 250 });
  await expect(page.locator(".hw-pages")).toContainText("QWERTY", { timeout: 30_000 });

  for (let i = 0; i < 3; i++) await page.keyboard.press("Shift+ArrowLeft");
  await expect(page.getByRole("tab", { name: "디자인", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.locator('[data-testid="hw-design-bold"]').click();

  await expect.poll(() => glyphBold(page, "R"), { timeout: 30_000 }).not.toBe(await glyphBold(page, "Q"));
  await expect(page.locator('[data-testid="hw-inplace-editor"]')).toHaveCount(0);
  await expect(page.locator(".hw-caret")).toBeVisible();
});
