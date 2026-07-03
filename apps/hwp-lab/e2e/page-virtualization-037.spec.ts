import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

// 이슈 037 페이지 가상화 e2e: 25쪽 문서를 열면 뷰포트 근처(±버퍼) 페이지만 SVG로 마운트되고, 멀리 있는
// 페이지는 같은 크기의 빈 placeholder(.hw-sheet + data-page, svg 없음)로 남는다. 마지막 페이지로 스크롤하면
// 그 페이지가 즉시 마운트되어 내용이 채워진다. 픽스처는 benchmarks/benchmark2.hwp(25쪽, 가장 큰 픽스처).
const BENCHMARK2 = path.resolve(process.cwd(), "..", "..", "benchmarks", "benchmark2.hwp");
const PAGES = 25;

async function open(page: Page) {
  await page.goto("/");
  await page.locator('[data-testid="file-input"]').setInputFiles(BENCHMARK2);
  // 모든 페이지의 .hw-sheet 슬롯(마운트된 것 + placeholder)이 생겨야 한다 — DOM 계약: 페이지 수 = 슬롯 수.
  await expect(page.locator(".hw-sheet")).toHaveCount(PAGES, { timeout: 90_000 });
  await expect(page.locator(".hw-sheet svg").first()).toBeVisible({ timeout: 90_000 });
  await page.waitForTimeout(1200); // 폰트 재배치 + IntersectionObserver settle
}

test("25쪽 열기 → 가상화(마운트 SVG ≤ 6, 마지막 페이지 svg 없음) → 스크롤 재진입 시 마운트+내용 정상", async ({ page }) => {
  await open(page);

  // 1) DOM 계약: 25개의 .hw-sheet 슬롯이 모두 존재한다(가상화가 페이지 수를 줄이지 않는다).
  await expect(page.locator(".hw-sheet")).toHaveCount(PAGES);

  // 2) 가상화: 실제 SVG가 붙은 시트(=마운트)는 소수(≤ 6, 버퍼 포함)여야 한다.
  const mounted = await page.locator(".hw-sheet svg").count();
  expect(mounted).toBeLessThanOrEqual(6);
  expect(mounted).toBeGreaterThan(0); // 상단은 반드시 보인다

  // 3) 마지막 페이지(#24)는 placeholder — svg 없음, 그러나 data-page + 실제 높이(스크롤 지오메트리)는 유지.
  const last = page.locator(`.hw-sheet[data-page="${PAGES - 1}"]`);
  await expect(last).toHaveCount(1);
  expect(await last.locator("svg").count()).toBe(0);
  const box = await last.boundingBox();
  expect(box, "placeholder 시트도 실제 크기를 가져야 한다(높이>0)").toBeTruthy();
  expect(box!.height).toBeGreaterThan(100); // A4 높이 수준의 실제 크기 유지

  // 4) 스크롤 재진입: 마지막 페이지를 뷰포트로 스크롤 → SVG가 마운트되고 내용이 채워진다.
  await last.scrollIntoViewIfNeeded();
  await expect(last.locator("svg")).toHaveCount(1, { timeout: 30_000 });
  await expect(last.locator("svg").first()).toBeVisible();

  // 여전히 25개 슬롯 유지(재진입이 페이지 수를 바꾸지 않는다).
  await expect(page.locator(".hw-sheet")).toHaveCount(PAGES);
});
