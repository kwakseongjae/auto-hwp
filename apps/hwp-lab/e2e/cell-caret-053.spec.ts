import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

// 이슈 053 셀 주소형 캐럿 e2e: 표 셀 텍스트를 클릭 → 글리프 정밀 캐럿(.hw-caret) 표시 → 타이핑이
// 키 입력당 1 undo 단위(SetTableCellRuns)로 커밋되어 자체렌더 SVG에 반영 → Escape 로 캐럿 해제 →
// undo 로 복원. 픽스처는 benchmarks/benchmark.hwp — 바이너리 .hwp 로, CARET-GAP §3에서 NodeId 캐럿
// 해상률 0.0%였던 바로 그 문서다(셀 주소형 캐럿이 이 갭을 닫는 것을 실문서로 증명).
const BENCHMARK = path.resolve(process.cwd(), "..", "..", "benchmarks", "benchmark.hwp");

async function open(page: Page) {
  await page.goto("/");
  await page.locator('[data-testid="file-input"]').setInputFiles(BENCHMARK);
  await expect(page.locator(".hw-sheet svg").first()).toBeVisible({ timeout: 60_000 });
}

/** 첫 페이지를 훑으며 셀 텍스트 위를 클릭해 캐럿을 세운다 (셀 밖 클릭은 캐럿을 지우므로 보일 때까지 스캔). */
async function placeCaret(page: Page): Promise<void> {
  const sheet = page.locator('.hw-sheet[data-page="0"]');
  const box = await sheet.boundingBox();
  if (!box) throw new Error("첫 페이지 시트 박스를 찾지 못함");
  for (let ry = 0.15; ry <= 0.9; ry += 0.05) {
    for (let rx = 0.15; rx <= 0.85; rx += 0.08) {
      await sheet.click({ position: { x: box.width * rx, y: box.height * ry } });
      await page.waitForTimeout(80);
      if ((await page.locator(".hw-caret").count()) > 0) return;
    }
  }
  throw new Error("셀 텍스트 캐럿을 세우지 못함 (스캔 실패)");
}

test("셀 클릭 → 캐럿 → 타이핑 커밋(SVG 반영) → Escape 해제 → undo 복원", async ({ page }) => {
  await open(page);

  // 1) 셀 텍스트 클릭 → 글리프 캐럿 표시. (바이너리 .hwp — NodeId 캐럿이 0.0%였던 문서에서 뜬다.)
  await placeCaret(page);
  await expect(page.locator(".hw-caret")).toBeVisible();

  // 2) 타이핑: US 키보드 문자 2자("QX" — 미국 배열 밖 문자는 Playwright가 keydown을 만들지 않는다)를
  //    키 입력당 1 커밋으로 넣는다. 각 키 사이에 커밋→재조판→캐럿 재해석이 끝나도록 여유를 둔다.
  await page.keyboard.type("QX", { delay: 400 });
  await expect(page.locator(".hw-pages")).toContainText("QX", { timeout: 30_000 });
  // 타이핑 후에도 캐럿은 그 셀에 살아 있다 (커밋 후 지오메트리 재해석).
  await expect(page.locator(".hw-caret")).toBeVisible();

  // 3) Escape → 캐럿 해제 (018: 캐럿 없음은 곧 .hw-caret 부재).
  await page.keyboard.press("Escape");
  await expect(page.locator(".hw-caret")).toHaveCount(0);

  // 4) undo ×2 (키 입력당 1 undo 단위) → 타이핑 이전으로 복원.
  await page.locator('.hw-tool[title="실행취소"]').click();
  await expect(page.locator(".hw-status")).toContainText("실행취소", { timeout: 30_000 });
  await page.locator(".hw-tool[title=\"실행취소\"]").click();
  await expect(page.locator(".hw-pages")).not.toContainText("QX", { timeout: 30_000 });
});
