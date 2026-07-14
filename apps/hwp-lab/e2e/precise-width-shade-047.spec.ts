import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

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
  const sheet = page.locator('.hw-sheet[data-page="0"]');
  const box = await sheet.boundingBox();
  if (!box) throw new Error("첫 페이지 시트 박스를 찾지 못함");
  const colGrip = page.locator('[data-testid="hw-col-grip-1"]');
  const anchor = page.locator(".hw-anchor");
  for (let ry = 0.1; ry <= 0.9; ry += 0.04) {
    for (let rx = 0.1; rx <= 0.9; rx += 0.06) {
      const px = box.x + box.width * rx;
      const py = box.y + box.height * ry;
      await page.mouse.click(px, py);
      if ((await colGrip.count()) === 0) continue; // 다열 표가 아님 → 다음 지점
      await page.keyboard.press("Escape");
      await page.mouse.click(px, py);
      await page.mouse.click(px, py);
      try {
        await page.locator(".hw-mark-cell").first().waitFor({ state: "visible", timeout: 4000 });
      } catch {
        continue; // 셀 경계/그립에 걸림 → 다음 지점
      }
      if ((await colGrip.count()) > 0 && (await anchor.count()) > 0 && (await anchor.first().innerText()).includes("행")) {
        return { cx: px, cy: py };
      }
    }
  }
  return null;
}

// 드릴된 셀에서 제자리 리치 에디터를 연다: Escape 초기화 → 더블클릭 A(표 전체 → 셀 드릴) → 드릴된 셀을
// 더블클릭 B(onDrilledCell → openEditorAt). 실제 앱은 finishClick 이 비동기라 드릴 시 셀-텍스트 캐럿(053)이
// 놓일 수 있어 Enter 는 053 타이핑에 가로채인다 — 재더블클릭 개봉이 캐럿 유무와 무관하게 결정적이다.
async function openCellEditor(page: Page, cx: number, cy: number) {
  await page.keyboard.press("Escape");
  await page.mouse.click(cx, cy); // 더블클릭 A: 표 전체 → 셀 드릴
  await page.mouse.click(cx, cy);
  await expect(page.locator(".hw-mark-cell").first()).toBeVisible({ timeout: 15_000 });
  await page.mouse.click(cx, cy); // 더블클릭 B: 드릴된 셀 재더블클릭 → 에디터 개봉
  await page.mouse.click(cx, cy);
  await expect(page.locator('[data-testid="hw-inplace-editor"]')).toBeVisible({ timeout: 15_000 });
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

test("편집 중 셀음영: 셀 드릴 → Enter 제자리 에디터 + 셀음영 팔레트 → 스와치 → 배경색 적용 + 에디터 유지", async ({ page }) => {
  await open(page);
  // 06x: 셀을 드릴(선택)한 뒤 Enter 로 제자리 리치 에디터를 연다(드릴+Enter — 가장 결정적).
  const found = await scanForMultiColCell(page);
  expect(found, "표 셀을 드릴해 셀 앵커가 떠야 한다").toBeTruthy();
  await openCellEditor(page, found!.cx, found!.cy);
  const editor = page.locator('[data-testid="hw-inplace-editor"]');
  await expect(editor).toBeVisible({ timeout: 15_000 });
  // 편집 중 셀음영 팔레트가 셀 위에 뜬다.
  const palette = page.locator('[data-testid="hw-cell-shade-palette"]');
  await expect(palette).toBeVisible({ timeout: 15_000 });
  // 스와치 클릭(mousedown preventDefault 로 에디터 blur→commit 없이) → 1셀 배경색 적용.
  await page.locator('[data-testid="hw-cell-shade-#E3F2FD"]').click();
  await expect(page.locator(".hw-status")).toContainText("배경색 적용", { timeout: 30_000 });
  // ★ 에디터 유지: 셀음영 커밋의 재-flow 가 에디터를 닫지 않았다(shield).
  await expect(editor).toBeVisible();
  await page.locator('.hw-tool[title="실행취소"]').click();
  await expect(page.locator(".hw-status")).toContainText("실행취소", { timeout: 30_000 });
});
