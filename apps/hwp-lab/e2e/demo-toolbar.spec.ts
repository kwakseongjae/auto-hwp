import { expect, test, type Page } from "@playwright/test";

// 데모 기본 툴바 계약(2026-08-05 사용자 결정): 노출 = 줌·실행취소/다시실행·HTML·PDF,
// 숨김 = 표 추가·이미지·레이아웃 정리·HWPX. SDK 기본값은 전 항목 노출이라 이 계약은
// 랩의 DEMO_TOOLBAR_ITEMS 배선에만 있고, 여기가 유일한 회귀 잠금이다(?toolbar=full 은 QA 탈출구).
async function openSample(page: Page) {
  await page.goto("/");
  await page.locator('[data-testid="sample-sample-8p.hwp"]').click();
  await expect(page.locator(".hw-sheet svg").first()).toBeVisible({ timeout: 60_000 });
}

test("데모 기본 툴바: HTML·PDF·줌·undo만 노출, 표추가/이미지/레이아웃/HWPX 숨김", async ({ page }) => {
  await openSample(page);
  const bar = page.locator(".hw-toolbar");
  await expect(bar.getByRole("button", { name: "HTML" })).toBeVisible();
  await expect(bar.getByRole("button", { name: "PDF" })).toBeVisible();
  await expect(bar.getByRole("button", { name: "실행취소" })).toBeVisible();
  for (const gone of ["표 추가", "이미지", "레이아웃 정리", "HWPX"]) {
    await expect(bar.getByRole("button", { name: gone, exact: true })).toHaveCount(0);
  }
});
