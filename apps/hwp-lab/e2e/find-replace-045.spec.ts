import path from "node:path";
import { expect, test } from "@playwright/test";

// Issue 045 — 찾기/바꾸기 SDK 승격, end-to-end through the SAME wasm engine (@auto-hwp/engine) the web shell
// runs. Uses benchmark1.hwpx: a binary .hwp carries NO NodeIds so Find matches nothing, but HWPX carries
// them, so Find returns matches AND caretRect resolves each match's box (the highlight + scroll geometry).
const HWPX = path.resolve(process.cwd(), "..", "..", "benchmarks", "benchmark1.hwpx");

// The workspace listens for ⌘/Ctrl+F on window; ControlOrMeta presses the platform's find modifier.
async function openFind(page: import("@playwright/test").Page) {
  await page.keyboard.press("ControlOrMeta+f");
  await expect(page.locator('[data-testid="hw-find"]')).toBeVisible({ timeout: 10_000 });
}

test("⌘F → 검색 n/m + 하이라이트 → 다음 이동; 바꾸기 1건 실반영 + undo; 모두 바꾸기 개수 토스트", async ({ page }) => {
  await page.goto("/");
  await page.locator('[data-testid="file-input"]').setInputFiles(HWPX);
  // The 25-page HWPX renders its first sheet (engine wasm fetch + per-page SVG are async).
  await expect(page.locator(".hw-sheet svg").first()).toBeVisible({ timeout: 60_000 });

  // ⌘F opens the capsule; the query field is focused.
  await openFind(page);
  const input = page.locator('[data-testid="hw-find-input"]');
  await expect(input).toBeFocused();

  // Search "사업" (14 matches). Enter runs the search → "1/N" + a highlight overlay. Geometry works here
  // because the doc is UNEDITED (the rhwp caretRect path is available pre-edit).
  const count = page.locator('[data-testid="hw-find-count"]');
  await input.fill("사업");
  await input.press("Enter");
  await expect(count).toHaveText(/^1\/\d+$/, { timeout: 15_000 });
  const total = Number((await count.innerText()).split("/")[1]);
  expect(total).toBeGreaterThan(1);
  // 매치 하이라이트: at least one match box on the page, exactly one is the current (강조).
  await expect(page.locator(".hw-find-hit").first()).toBeVisible();
  await expect(page.locator(".hw-find-current")).toHaveCount(1);

  // Enter again = 다음 → the ordinal advances (scroll-to-match moves the current match into view).
  await input.press("Enter");
  await expect(count).toHaveText(/^2\/\d+$/);
  // Shift+Enter = 이전 → back to the first.
  await input.press("Shift+Enter");
  await expect(count).toHaveText(/^1\/\d+$/);

  // 바꾸기(첫 일치): replace the first "사업" as ONE undo unit. Proof of a real SVG text change: the doc's
  // "사업" count DROPS by one (the auto re-find after the edit re-counts the live document), and undo
  // restores it — an engine-backed round-trip that doesn't depend on which page a match lands on.
  await page.locator('[data-testid="hw-find-replace-input"]').fill("완제품테스트X");
  await page.locator('[data-testid="hw-find-replace-one"]').click();
  await expect(page.locator(".hw-status")).toContainText("1개 바꿈", { timeout: 20_000 });
  await expect(count).toHaveText(new RegExp(`^1\\/${total - 1}$`), { timeout: 20_000 });
  // The replacement text is now IN the document (engine-level SVG/text change): searching it finds 1.
  await input.fill("완제품테스트X");
  await input.press("Enter");
  await expect(count).toHaveText("1/1", { timeout: 15_000 });

  // undo (툴바 ↶) → the replacement is reverted (one undo unit); the replacement is no longer found and
  // the original "사업" count is back to N.
  await page.locator('.hw-tool[title="실행취소"]').click();
  await input.fill("완제품테스트X");
  await input.press("Enter");
  await expect(count).toHaveText("결과 없음", { timeout: 15_000 });
  await input.fill("사업");
  await input.press("Enter");
  await expect(count).toHaveText(new RegExp(`^1\\/${total}$`), { timeout: 15_000 });

  // 모두 바꾸기: replace EVERY "사업" as one undo unit → a "N개 바꿈" toast with N ≥ 2.
  await page.locator('[data-testid="hw-find-replace-input"]').fill("전량완판");
  await page.locator('[data-testid="hw-find-replace-all"]').click();
  await expect(page.locator(".hw-status")).toContainText(new RegExp(`${total}개 바꿈`), { timeout: 20_000 });

  // Esc closes the bar.
  await input.press("Escape");
  await expect(page.locator('[data-testid="hw-find"]')).toBeHidden();
});
