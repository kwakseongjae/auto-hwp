import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

// 이슈 027 편집 패리티 e2e: 열너비 드래그 · 표 추가 · 텍스트 수정 · 볼드+배경. 데모 픽스처는
// benchmarks/benchmark.hwp(8쪽, 다열 표 포함). enableEditing 이 켜진 lab 에서 검증한다.
const BENCHMARK = path.resolve(process.cwd(), "..", "..", "benchmarks", "benchmark.hwp");

async function open(page: Page) {
  await page.goto("/");
  await page.locator('[data-testid="file-input"]').setInputFiles(BENCHMARK);
  await expect(page.locator(".hw-sheet svg").first()).toBeVisible({ timeout: 60_000 });
}

// 첫 페이지를 격자 스캔해 조건이 만족되는 클릭 지점을 찾는다(헤드리스에서 정확한 셀 좌표를 몰라도
// 됨). `predicate` 가 true 를 반환하는 첫 지점을 돌려준다.
async function scan(page: Page, predicate: () => Promise<boolean>): Promise<{ x: number; y: number } | null> {
  const sheet = page.locator('.hw-sheet[data-page="0"]');
  const box = await sheet.boundingBox();
  if (!box) throw new Error("첫 페이지 시트 박스를 찾지 못함");
  for (let ry = 0.1; ry <= 0.9; ry += 0.04) {
    for (let rx = 0.1; rx <= 0.9; rx += 0.06) {
      const pos = { x: box.width * rx, y: box.height * ry };
      await sheet.click({ position: pos });
      if (await predicate()) return pos;
    }
  }
  return null;
}

const scanForClick = (page: Page, testid: string) => scan(page, async () => (await page.locator(testid).count()) > 0);

// 표 셀 앵커("N행 M열" 라벨)가 뜨는 지점을 찾는다 — 텍스트/서식은 셀을 대상으로 해야 한다.
const scanForCell = (page: Page) =>
  scan(page, async () => {
    const a = page.locator(".hw-anchor");
    if ((await a.count()) === 0) return false;
    return (await a.first().innerText()).includes("행");
  });

test("표 추가: 툴바 버튼 → 2×3 픽커 → ApplyContent 로 표 삽입 → undo", async ({ page }) => {
  await open(page);
  await page.locator('[data-testid="hw-table-insert"]').click();
  await expect(page.locator('[data-testid="hw-table-picker"]')).toBeVisible();
  await page.locator('[data-testid="hw-table-cell-2-3"]').hover();
  await expect(page.locator('[data-testid="hw-table-picker-label"]')).toContainText("2 × 3");
  await page.locator('[data-testid="hw-table-cell-2-3"]').click();
  // 적용 토스트(문서 끝에 표 추가) — 편집이 op-bus 로 커밋됐다는 신호.
  await expect(page.locator(".hw-status")).toContainText("표를 문서 끝에 추가", { timeout: 30_000 });
  // undo 1회 복구.
  await page.locator('.hw-tool[title="실행취소"]').click();
  await expect(page.locator(".hw-status")).toContainText("실행취소", { timeout: 30_000 });
});

test("열너비 드래그: 표 선택 → 열 경계 핸들 드래그 → SetTableColWidths", async ({ page }) => {
  await open(page);
  // 다열 표를 찾을 때까지 스캔(열 경계 핸들 hw-col-grip-1 이 뜨는 지점).
  const found = await scanForClick(page, '[data-testid="hw-col-grip-1"]');
  expect(found, "다열 표를 찾아 열 경계 핸들이 떠야 한다").toBeTruthy();
  const grip = page.locator('[data-testid="hw-col-grip-1"]').first();
  const gb = await grip.boundingBox();
  if (!gb) throw new Error("열 경계 핸들 박스를 찾지 못함");
  // 핸들을 오른쪽으로 40px 드래그(프리뷰 → 놓으면 비율 적용).
  await page.mouse.move(gb.x + gb.width / 2, gb.y + gb.height / 2);
  await page.mouse.down();
  await page.mouse.move(gb.x + gb.width / 2 + 40, gb.y + gb.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect(page.locator(".hw-status")).toContainText("열 너비를 변경", { timeout: 30_000 });
  await page.locator('.hw-tool[title="실행취소"]').click();
  await expect(page.locator(".hw-status")).toContainText("실행취소", { timeout: 30_000 });
});

test("텍스트 수정: 셀 더블클릭 → 팝오버 → 저장(SetTableCellRuns) → 문서에 반영", async ({ page }) => {
  await open(page);
  // 셀 앵커("N행 M열" 포함)가 뜨는 지점을 찾는다 — 텍스트 수정은 셀을 대상으로 한다.
  const found = await scanForCell(page);
  expect(found, "표 셀을 클릭해 셀 앵커가 떠야 한다").toBeTruthy();
  // 선택된 셀의 마킹 박스(.hw-mark-cell) 중앙을 빠르게 두 번 클릭 = 더블클릭. (setPointerCapture 가
  // DOM dblclick 을 억제하므로 pointerup 타이밍으로 감지한다.) 스캔 좌표의 async 지연과 무관하게
  // 반드시 그 셀 안에서 팝오버가 열린다.
  const markBox = await page.locator(".hw-mark-cell").first().boundingBox();
  if (!markBox) throw new Error("셀 마킹 박스를 찾지 못함");
  const cx = markBox.x + markBox.width / 2;
  const cy = markBox.y + markBox.height / 2;
  await page.mouse.click(cx, cy);
  await page.mouse.click(cx, cy);
  const ta = page.locator('[data-testid="hw-cell-textarea"]');
  await expect(ta).toBeVisible({ timeout: 15_000 });
  await ta.fill("ZZZ텍스트확인");
  await page.locator('[data-testid="hw-cell-save"]').click();
  // 커밋되면 문서 SVG 에 새 텍스트가 나타난다(run 보존 커밋 경로).
  await expect(page.locator(".hw-pages")).toContainText("ZZZ텍스트확인", { timeout: 30_000 });
  await page.locator('.hw-tool[title="실행취소"]').click();
  await expect(page.locator(".hw-pages")).not.toContainText("ZZZ텍스트확인", { timeout: 30_000 });
});

test("볼드+배경: 셀 선택 → 서식 툴바 굵게 + 배경색 → SetCellRangeFmt/Shade", async ({ page }) => {
  await open(page);
  // 셀을 선택해야 서식 툴바가 활성화된다(문단 선택은 비활성).
  const found = await scanForCell(page);
  expect(found, "표 셀을 선택하면 서식 툴바가 떠야 한다").toBeTruthy();
  await expect(page.locator('[data-testid="hw-format-toolbar"]')).toBeVisible({ timeout: 30_000 });
  // 굵게 적용/해제(SetCellRangeFmt) — 셀의 현재 볼드 상태에 따라 토글.
  await page.locator('[data-testid="hw-fmt-bold"]').click();
  await expect(page.locator(".hw-status")).toContainText("굵게", { timeout: 30_000 });
  // 서식 툴바가 여전히 있어야 배경색을 이어서 적용할 수 있다(선택 유지).
  await expect(page.locator('[data-testid="hw-format-toolbar"]')).toBeVisible({ timeout: 30_000 });
  // 배경색 적용. color input 값을 NATIVE setter 로 설정해야(React 의 value 추적기 우회) onChange 가
  // 발생한다 — 인스턴스 setter 로 넣으면 추적값이 함께 갱신되어 이벤트가 무시된다.
  await page.locator('[data-testid="hw-fmt-shade"]').evaluate((el: HTMLInputElement) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    setter.call(el, "#ffe08a");
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect(page.locator(".hw-status")).toContainText("배경색 적용", { timeout: 30_000 });
});
