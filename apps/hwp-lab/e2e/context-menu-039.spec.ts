import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

// 이슈 039 컨텍스트 메뉴 e2e: 우클릭 → 셀/문단/바탕 분기 메뉴 + 액션 위임 + 닫힘 규칙. 데모 픽스처는
// benchmark.hwp(8쪽, 다열 표 + 본문 문단). enableEditing 이 켜진 lab 에서 검증한다.
const BENCHMARK = path.resolve(process.cwd(), "..", "..", "benchmarks", "benchmark.hwp");

async function open(page: Page) {
  await page.goto("/");
  await page.locator('[data-testid="file-input"]').setInputFiles(BENCHMARK);
  await expect(page.locator(".hw-sheet svg").first()).toBeVisible({ timeout: 60_000 });
}

// 한 페이지를 격자 스캔해 우클릭 시 predicate 가 만족되는 지점을 찾는다(정확한 좌표를 몰라도 됨).
async function rightClickScanPage(page: Page, dp: number, predicate: () => Promise<boolean>): Promise<{ x: number; y: number } | null> {
  const sheet = page.locator(`.hw-sheet[data-page="${dp}"]`);
  if ((await sheet.count()) === 0) return null;
  await sheet.scrollIntoViewIfNeeded();
  const box = await sheet.boundingBox();
  if (!box) return null;
  for (let ry = 0.04; ry <= 0.98; ry += 0.045) {
    for (let rx = 0.06; rx <= 0.94; rx += 0.06) {
      const pos = { x: box.x + box.width * rx, y: box.y + box.height * ry };
      await page.mouse.click(pos.x, pos.y, { button: "right" });
      if (await predicate()) return pos;
      if ((await page.locator('[data-testid="hw-context-menu"]').count()) > 0) await page.keyboard.press("Escape");
    }
  }
  return null;
}

// 여러 페이지에 걸쳐 스캔한다(픽스처 레이아웃에 견고 — 빈 바탕/특정 블록이 어느 페이지에 있든 찾는다).
async function rightClickScan(page: Page, predicate: () => Promise<boolean>, pages = 1): Promise<{ x: number; y: number } | null> {
  for (let dp = 0; dp < pages; dp++) {
    const found = await rightClickScanPage(page, dp, predicate);
    if (found) return found;
  }
  return null;
}

test("셀 우클릭 → 셀 메뉴(굵게/행 삽입 포함) → 굵게 → SetCellRangeFmt 토스트", async ({ page }) => {
  await open(page);
  // 셀 우클릭 시 '행 삽입' 항목이 뜨는(=셀 분기) 지점을 찾는다.
  const found = await rightClickScan(page, async () => (await page.locator('[data-testid="hw-ctx-row-below"]').count()) > 0);
  expect(found, "표 셀을 우클릭하면 셀 메뉴(행 삽입 포함)가 떠야 한다").toBeTruthy();
  const menu = page.locator('[data-testid="hw-context-menu"]');
  await expect(menu).toBeVisible();
  await expect(page.locator('[data-testid="hw-ctx-edit"]')).toBeVisible();
  await expect(page.locator('[data-testid="hw-ctx-bold"]')).toBeVisible();
  await expect(page.locator('[data-testid="hw-ctx-shade"]')).toBeVisible();
  await expect(page.locator('[data-testid="hw-ctx-ai"]')).toBeVisible();
  // 굵게 → 셀 서식 위임(028과 동일 액션) → 토스트.
  await page.locator('[data-testid="hw-ctx-bold"]').click();
  await expect(page.locator(".hw-status")).toContainText("굵게", { timeout: 30_000 });
  // 액션 후 메뉴는 닫힌다.
  await expect(menu).toBeHidden();
});

test("셀 우클릭 → 아래에 행 삽입 → 커밋(문서에 반영) → undo", async ({ page }) => {
  await open(page);
  const found = await rightClickScan(page, async () => (await page.locator('[data-testid="hw-ctx-row-below"]').count()) > 0);
  expect(found, "표 셀을 우클릭해 행 삽입 항목이 떠야 한다").toBeTruthy();
  await page.locator('[data-testid="hw-ctx-row-below"]').click();
  // 기존 TableInsertRows op 위임 성공 → 토스트(무효 대상이면 실패 토스트가 뜨므로 성공 문구를 확인).
  await expect(page.locator(".hw-status")).toContainText("행을 삽입", { timeout: 30_000 });
  await page.locator('.hw-tool[title="실행취소"]').click();
  await expect(page.locator(".hw-status")).toContainText("실행취소", { timeout: 30_000 });
});

test("바탕(비개체) 우클릭 → 표 추가 그리드 → 2×3 → 문서 끝에 표 추가 토스트", async ({ page }) => {
  await open(page);
  // 표/문단이 없는 빈 영역(여백/문단 사이/페이지 하단)을 우클릭해 '표 추가' 그리드가 뜨는(=바탕 분기)
  // 지점을 찾는다. 밀집 픽스처에서도 빈 바탕이 어느 페이지엔가 있으므로 여러 페이지를 스캔한다.
  const found = await rightClickScan(
    page,
    async () => {
      const menu = page.locator('[data-testid="hw-context-menu"]');
      if ((await menu.count()) === 0) return false;
      // 바탕 메뉴는 표 크기 그리드(hw-table-cell-*)를 가진다.
      return (await menu.locator('[data-testid="hw-table-cell-1-1"]').count()) > 0;
    },
    4,
  );
  expect(found, "빈 영역 우클릭 시 표 추가 그리드가 떠야 한다").toBeTruthy();
  await page.locator('[data-testid="hw-context-menu"] [data-testid="hw-table-cell-2-3"]').click();
  await expect(page.locator(".hw-status")).toContainText("표를 문서 끝에 추가", { timeout: 30_000 });
  await page.locator('.hw-tool[title="실행취소"]').click();
  await expect(page.locator(".hw-status")).toContainText("실행취소", { timeout: 30_000 });
});

test("메뉴 닫힘 규칙: 외부 클릭으로 닫히고, 채팅 패널 우클릭은 기본 메뉴(시트 밖) — 우리 메뉴 안 뜸", async ({ page }) => {
  await open(page);
  const found = await rightClickScan(page, async () => (await page.locator('[data-testid="hw-context-menu"]').count()) > 0);
  expect(found, "우클릭으로 메뉴가 떠야 한다").toBeTruthy();
  // 외부(빈 회색 여백) 클릭으로 닫힘.
  await page.mouse.click(5, 5);
  await expect(page.locator('[data-testid="hw-context-menu"]')).toBeHidden();
  // 채팅 패널(시트 밖) 우클릭은 우리 메뉴를 열지 않는다(브라우저 기본 유지).
  const composer = page.locator(".hw-textarea");
  await composer.click({ button: "right" });
  await expect(page.locator('[data-testid="hw-context-menu"]')).toHaveCount(0);
});
