import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { placeCellCaret, selectFirstCell } from "./cell-gesture";

// 이슈 047 e2e: 열너비 mm 정밀 다이얼로그 + 균등 분배 + 편집 중 셀음영. 데모 픽스처는
// benchmarks/benchmark.hwp(8쪽, 다열 표 포함). enableEditing 이 켜진 lab 에서 검증한다.
const BENCHMARK = path.resolve(process.cwd(), "..", "..", "benchmarks", "benchmark.hwp");

async function open(page: Page) {
  await page.goto("/");
  await page.locator('[data-testid="file-input"]').setInputFiles(BENCHMARK);
  await expect(page.locator(".hw-sheet svg").first()).toBeVisible({ timeout: 60_000 });
}

// 다열 표의 셀을 드릴(선택)해 열 경계 핸들 + 셀 앵커("N행 M열")가 뜨는 지점을 찾는다.
// 06x Figma 드릴: 단일 클릭은 표 '전체'를 마킹하므로, 셀을 고르려면 그 지점을 더블클릭해 드릴 인한다.
// 열 그립(hw-col-grip-1)이 뜨는 다열 표 지점을 단일 클릭으로 찾고 → Escape 초기화 → 깨끗한 더블클릭
// (raw 좌표 → 행 그립 가로채기 우회)으로 셀을 캐럿 없이 선택한다. 드릴된 셀도 editTarget.boundaries 를
// 가지므로 열 그립이 유지된다(HwpWorkspace 818행). 그 셀의 클릭 좌표를 돌려준다.
async function scanForMultiColCell(page: Page): Promise<{ cx: number; cy: number } | null> {
  return selectFirstCell(page, true);
}

// 현재 보이는 모든 열 경계 핸들의 x-중심을 정렬해 반환(경계 이동 시각 assert 용).
async function gripXs(page: Page): Promise<number[]> {
  const grips = page.locator('[data-testid^="hw-col-grip-"]');
  const n = await grips.count();
  const xs: number[] = [];
  for (let i = 0; i < n; i++) {
    const b = await grips.nth(i).boundingBox();
    if (b) xs.push(Math.round(b.x + b.width / 2));
  }
  return xs.sort((a, b) => a - b);
}

test("열 너비 mm 다이얼로그: 셀 우클릭 → 열 너비… → mm 입력 적용 → 경계가 실제로 이동 (적용-확인)", async ({ page }) => {
  await open(page);
  const found = await scanForMultiColCell(page);
  expect(found, "다열 표 셀을 선택해 열 경계 핸들 + 셀 앵커가 떠야 한다").toBeTruthy();
  const before = await gripXs(page);
  expect(before.length, "열 경계 핸들이 있어야 한다").toBeGreaterThan(0);
  // 선택된 셀 위에서 우클릭 → 컨텍스트 메뉴 → '열 너비…'.
  const mark = await page.locator(".hw-mark-cell").first().boundingBox();
  if (!mark) throw new Error("셀 마킹 박스를 찾지 못함");
  await page.mouse.click(mark.x + mark.width / 2, mark.y + mark.height / 2, { button: "right" });
  await page.locator('[data-testid="hw-ctx-colwidth"]').click();
  const dialog = page.locator('[data-testid="hw-colwidth-dialog"]');
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  // 현재 mm(실측값)을 읽어 확실히 다른 값(≈ −10mm, 최소 5mm)으로 줄인다 → 경계가 왼쪽으로 이동.
  const input = page.locator('[data-testid="hw-colwidth-input"]');
  const cur = parseFloat((await input.inputValue()) || "0");
  const target = Math.max(5, Math.round(cur - 10));
  await input.fill(String(target));
  await input.press("Enter");
  // apply-verify 성공 토스트(무반영이면 실패 토스트가 뜬다).
  await expect(page.locator(".hw-status")).toContainText("열 너비를 변경했습니다", { timeout: 30_000 });
  // ★ 시각 이동 assert: 커밋 후 재조회한 열 경계 배치가 실제로 바뀌었다(어떤 핸들이 >6px 이동).
  await expect
    .poll(async () => {
      const after = await gripXs(page);
      if (after.length !== before.length) return 999; // 재배치 = 확실한 변화
      return Math.max(...after.map((x, i) => Math.abs(x - before[i])), 0);
    }, { timeout: 30_000 })
    .toBeGreaterThan(6);
  await page.locator('.hw-tool[title="실행취소"]').click();
  await expect(page.locator(".hw-status")).toContainText("실행취소", { timeout: 30_000 });
});

test("균등 분배: 셀 우클릭 → 열 너비… → 균등 분배 → 전 열 등폭 커밋(성공 토스트)", async ({ page }) => {
  await open(page);
  const found = await scanForMultiColCell(page);
  expect(found, "다열 표 셀을 선택해야 한다").toBeTruthy();
  const mark = await page.locator(".hw-mark-cell").first().boundingBox();
  if (!mark) throw new Error("셀 마킹 박스를 찾지 못함");
  await page.mouse.click(mark.x + mark.width / 2, mark.y + mark.height / 2, { button: "right" });
  await page.locator('[data-testid="hw-ctx-colwidth"]').click();
  await expect(page.locator('[data-testid="hw-colwidth-dialog"]')).toBeVisible({ timeout: 15_000 });
  const eq = page.locator('[data-testid="hw-colwidth-equalize"]');
  await expect(eq).toBeEnabled();
  await eq.click();
  await expect(page.locator(".hw-status")).toContainText("열 너비를 변경했습니다", { timeout: 30_000 });
  await page.locator('.hw-tool[title="실행취소"]').click();
  await expect(page.locator(".hw-status")).toContainText("실행취소", { timeout: 30_000 });
});

test("셀음영은 디자인 inspector에만 있고 텍스트 편집 중 팔레트는 나타나지 않는다", async ({ page }) => {
  await open(page);
  const found = await scanForMultiColCell(page);
  expect(found, "표 셀을 드릴해 셀 앵커가 떠야 한다").toBeTruthy();
  if ((await page.locator(".hw-caret").count()) > 0) {
    await page.keyboard.press("Escape"); // 텍스트 편집만 종료하고 셀 선택은 유지
  }
  await expect(page.getByRole("tab", { name: "디자인", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator('[data-testid="hw-design-shade"]')).toBeVisible();
  await page.locator('[data-testid="hw-design-shade"]').evaluate((el: HTMLInputElement) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    setter.call(el, "#e3f2fd");
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect(page.locator(".hw-status")).toContainText("배경색 적용", { timeout: 30_000 });

  await placeCellCaret(page);
  await expect(page.locator(".hw-workspace")).toHaveClass(/is-text-editing/);
  await expect(page.locator('[data-testid="hw-cell-shade-palette"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="hw-design-shade"]')).toHaveCount(0);
  await page.locator('.hw-tool[title="실행취소"]').click();
  await expect(page.locator(".hw-status")).toContainText("실행취소", { timeout: 30_000 });
});
