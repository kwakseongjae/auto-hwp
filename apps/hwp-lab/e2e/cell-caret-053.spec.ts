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

/** 06x 드릴 모델대로 표→셀을 먼저 고른 뒤, 그 셀의 텍스트 밴드를 훑어 캐럿을 세운다. */
async function placeCaret(page: Page): Promise<void> {
  const sheet = page.locator('.hw-sheet[data-page="0"]');
  const box = await sheet.boundingBox();
  if (!box) throw new Error("첫 페이지 시트 박스를 찾지 못함");
  const anchor = page.locator(".hw-anchor");
  const label = async () => ((await anchor.count()) > 0 ? (await anchor.first().innerText()).trim() : "");
  let drilled = false;
  for (let ry = 0.1; ry <= 0.9 && !drilled; ry += 0.04) {
    for (let rx = 0.1; rx <= 0.9; rx += 0.06) {
      const x = box.x + box.width * rx;
      const y = box.y + box.height * ry;
      await page.mouse.click(x, y);
      await page.waitForTimeout(120);
      const l = await label();
      if (l.includes("행")) {
        drilled = true;
        break;
      }
      if (!l.includes("표")) continue;
      await page.waitForTimeout(500);
      await page.mouse.click(x, y);
      await page.mouse.click(x, y);
      await expect.poll(label, { timeout: 3_000, intervals: [25, 50, 100] }).toContain("행");
      drilled = true;
      break;
    }
  }
  if (!drilled) throw new Error("표 셀을 드릴하지 못함 (스캔 실패)");

  // fresh whole-table click에서는 텍스트 캐럿을 일부러 막는다. 이미 드릴된 셀을 다시 클릭해야
  // cell mark + glyph caret가 공존하므로, 선택된 cell box 안에서 문단 밴드를 찾는다.
  const mark = page.locator(".hw-mark-cell").first();
  const markBox = await mark.boundingBox();
  if (!markBox) throw new Error("드릴된 셀 마킹 박스를 찾지 못함");
  for (let ry = 0.08; ry <= 0.92; ry += 0.12) {
    for (let rx = 0.05; rx <= 0.95; rx += 0.15) {
      // 셀 선택 뒤 생기는 행/열 resize grip이 sheet locator click의 actionability를 가로챌 수 있다.
      // 실제 포인터처럼 절대좌표로 쏘면 overlay를 포함한 정상 hit-test 경로를 그대로 탄다.
      await page.mouse.click(markBox.x + markBox.width * rx, markBox.y + markBox.height * ry);
      // 한 점의 image/selection/caret worker settle이 끝나기 전에 다음 점을 쏘면 최신-gesture 정책상
      // 앞 점의 늦은 캐럿은 의도대로 취소된다. 스캐너도 사용자 클릭처럼 한 점씩 settle시킨다.
      await page.waitForTimeout(200);
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

test("셀 캐럿의 paste 이벤트는 text/plain 개행을 한 커밋·한 undo로 왕복한다", async ({ page }) => {
  await open(page);
  await placeCaret(page);
  await expect(page.locator(".hw-caret")).toBeVisible();

  // 브라우저가 권한 확인을 끝내 paste 이벤트에 실어 준 text/plain만 소비한다. 실제 wasm 엔진의
  // SetTableCellRuns 경로를 타므로, DOM 전용 단위 테스트로는 놓치는 이벤트→adapter 배선을 잠근다.
  await page.evaluate(() => {
    const clipboard = new DataTransfer();
    clipboard.setData("text/plain", "VPASTE\nVLINE");
    window.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: clipboard,
        bubbles: true,
        cancelable: true,
      }),
    );
  });

  await expect(page.locator(".hw-status")).toContainText("붙여넣었습니다", { timeout: 30_000 });
  await expect(page.locator(".hw-pages")).toContainText("VPASTE", { timeout: 30_000 });
  await expect(page.locator(".hw-pages")).toContainText("VLINE", { timeout: 30_000 });

  // 개행 포함 전체 paste가 단 하나의 SetTableCellRuns이므로 undo 한 번에 함께 사라진다.
  await page.locator('.hw-tool[title="실행취소"]').click();
  await expect(page.locator(".hw-pages")).not.toContainText("VPASTE", { timeout: 30_000 });
  await expect(page.locator(".hw-pages")).not.toContainText("VLINE", { timeout: 30_000 });
});
