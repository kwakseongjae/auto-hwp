import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

// 이슈 040 리치 제자리 에디터 e2e: 셀 더블클릭 → contentEditable 리치 에디터 → 텍스트 일부 선택 ⌘B →
// Enter 커밋(SetTableCellRuns, run 보존) → 셀을 다시 열면 그 부분 서식이 그대로(부분 서식 왕복) →
// 자체렌더 SVG 에 반영 → undo 복구. 데스크톱 richedit 를 웹으로 포팅한 부분 서식 편집의 핵심 계약을
// 실제 브라우저(Chromium)로 검증한다. ⌘B 는 토글이므로(셀이 이미 볼드일 수 있음) "선택 부분과 나머지
// 부분의 서식이 서로 다르다"(부분 서식 성립)로 견고하게 단언한다 — 초기 볼드 여부와 무관.
const BENCHMARK = path.resolve(process.cwd(), "..", "..", "benchmarks", "benchmark.hwp");

async function open(page: Page) {
  await page.goto("/");
  await page.locator('[data-testid="file-input"]').setInputFiles(BENCHMARK);
  await expect(page.locator(".hw-sheet svg").first()).toBeVisible({ timeout: 60_000 });
}

// 06x Figma 드릴: 단일 클릭은 표 '전체'를 마킹하므로, 셀을 고르려면 그 지점을 더블클릭해 드릴 인한다.
// 표 위 지점을 단일 클릭으로 찾고(.hw-mark-table) → Escape 초기화 → 깨끗한 더블클릭(raw 좌표 → 행 그립
// 가로채기 우회)으로 셀을 캐럿 없이 선택한다. 그 셀의 클릭 좌표를 돌려준다(에디터 재개봉에 재사용).
async function scanForCell(page: Page): Promise<{ cx: number; cy: number }> {
  const sheet = page.locator('.hw-sheet[data-page="0"]');
  const box = await sheet.boundingBox();
  if (!box) throw new Error("첫 페이지 시트 박스를 찾지 못함");
  const anchor = page.locator(".hw-anchor");
  for (let ry = 0.1; ry <= 0.9; ry += 0.04) {
    for (let rx = 0.1; rx <= 0.9; rx += 0.06) {
      const px = box.x + box.width * rx;
      const py = box.y + box.height * ry;
      await page.mouse.click(px, py);
      if ((await page.locator(".hw-mark-table").count()) === 0) continue;
      await page.keyboard.press("Escape");
      await page.mouse.click(px, py);
      await page.mouse.click(px, py);
      try {
        await page.locator(".hw-mark-cell").first().waitFor({ state: "visible", timeout: 4000 });
      } catch {
        continue; // 셀 경계/그립에 걸림 → 다음 지점
      }
      if ((await anchor.count()) > 0 && (await anchor.first().innerText()).includes("행")) return { cx: px, cy: py };
    }
  }
  throw new Error("표 셀 앵커를 찾지 못함");
}

// 셀 제자리 리치 에디터를 연다(첫 개봉·재개봉 공용, 상태 무관): Escape 초기화 → 더블클릭 A(표 전체 →
// 셀 드릴) → 드릴된 셀을 더블클릭 B(onDrilledCell → openEditorAt). 실제 앱은 finishClick 이 비동기라 드릴
// 시 셀-텍스트 캐럿(053)이 놓일 수 있어 Enter 는 053 타이핑에 가로채인다 — 재더블클릭 개봉이 결정적이다.
async function openCellEditor(page: Page, cx: number, cy: number) {
  await page.keyboard.press("Escape");
  await page.mouse.click(cx, cy); // 더블클릭 A: 표 전체 → 셀 드릴
  await page.mouse.click(cx, cy);
  await expect(page.locator(".hw-mark-cell").first()).toBeVisible({ timeout: 15_000 });
  await page.mouse.click(cx, cy); // 더블클릭 B: 드릴된 셀 재더블클릭 → 에디터 개봉
  await page.mouse.click(cx, cy);
  await expect(page.locator('[data-testid="hw-inplace-editor"]')).toBeVisible({ timeout: 15_000 });
}

// 리치 에디터 DOM 에서 주어진 글자를 담은 span 의 볼드 여부(computed font-weight ≥ 600). 오염이 없다.
function editorBold(page: Page, ch: string): Promise<boolean> {
  return page.evaluate((c) => {
    const ed = document.querySelector("[data-inline-edit]");
    if (!ed) return false;
    for (const sp of Array.from(ed.querySelectorAll("span"))) {
      if ((sp.textContent ?? "").includes(c)) {
        const fw = getComputedStyle(sp).fontWeight;
        return fw === "bold" || parseInt(fw, 10) >= 600;
      }
    }
    return false;
  }, ch);
}

test("부분 서식: 셀 더블클릭 → 일부 선택 ⌘B → Enter 커밋 → 셀 재개봉 시 부분 서식 왕복 → SVG 반영 → undo", async ({ page }) => {
  await open(page);
  const cell = await scanForCell(page); // 셀을 드릴(선택)하고 그 클릭 좌표를 기억
  await openCellEditor(page, cell.cx, cell.cy);
  const editor = page.locator('[data-testid="hw-inplace-editor"]');
  await expect(editor).toHaveAttribute("contenteditable", "true"); // 리치 에디터(구 textarea 아님)

  // 진입 시 전체 선택 → 알려진 라틴 문자열로 교체. 앞 3글자(QWE)만 선택해 ⌘B(토글).
  await page.keyboard.type("QWERTY");
  await page.keyboard.press("Home");
  for (let i = 0; i < 3; i++) await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("Meta+b");

  // 라이브 단언: 선택한 앞부분(Q)과 뒷부분(Y)의 볼드 상태가 서로 다르다 = 부분 서식이 걸렸다.
  const qLive = await editorBold(page, "Q");
  const yLive = await editorBold(page, "Y");
  expect(qLive, "선택 부분(Q)과 비선택 부분(Y)의 서식이 달라야 한다(부분 서식)").not.toBe(yLive);

  // Enter=저장 → run 보존 커밋(SetTableCellRuns). 자체렌더 SVG 에 새 텍스트가 나타난다.
  await page.keyboard.press("Enter");
  await expect(page.locator('[data-testid="hw-inplace-editor"]')).toHaveCount(0, { timeout: 15_000 }); // 커밋 후 에디터 닫힘
  await expect(page.locator(".hw-pages")).toContainText("Q", { timeout: 30_000 }); // Q 는 문서에 없는 고유 글자 = 커밋 반영

  // ★ 부분 서식 왕복: 같은 셀을 다시 열면 커밋된 runs(=SetTableCellRuns→runsAt→runsToHtml)가 그대로
  //   그려진다 — 선택했던 부분과 나머지의 서식 차이가 보존돼야 한다(무접촉 런 서식 불변).
  await openCellEditor(page, cell.cx, cell.cy);
  const qRound = await editorBold(page, "Q");
  const yRound = await editorBold(page, "Y");
  expect(qRound, "재개봉 시에도 부분 서식이 보존돼야 한다").not.toBe(yRound);
  expect(qRound, "커밋 전후 선택 부분의 서식이 일치해야 한다").toBe(qLive);
  await page.keyboard.press("Escape"); // 재개봉한 에디터 닫기(취소)
  await expect(page.locator('[data-testid="hw-inplace-editor"]')).toHaveCount(0, { timeout: 15_000 });

  // undo → 편집 복구(QWERTY 사라짐).
  await page.locator('.hw-tool[title="실행취소"]').click();
  await expect(page.locator(".hw-status")).toContainText("실행취소", { timeout: 30_000 });
  await expect(page.locator(".hw-pages")).not.toContainText("QWERTY", { timeout: 30_000 });
});
