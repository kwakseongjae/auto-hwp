import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

// 이슈 048 상단 서식 리본 e2e: 영속 리본이 "비편집=선택 대상 서식 op / 편집 중=라이브 선택 스타일"로 이중
// 동작함을 실제 브라우저(Chromium)로 검증한다. ① 셀 선택 후 리본 굵게 → 셀 서식 op(토스트) + 토글 반영.
// ② 셀 더블클릭 → 제자리 에디터 → 일부 선택 → 리본 굵게 버튼(⌘B 아님) → 부분 서식 성립 → Enter 커밋 →
// SVG 반영. ③ 편집 중엔 밑줄/취소선 활성·배경/정렬 비활성(모드별 활성). 리본 클릭이 선택을 붕괴시키지
// 않는 함정(preventDefault)도 함께 걸린다(부분 서식이 성립하면 선택이 유지됐다는 뜻).
const BENCHMARK = path.resolve(process.cwd(), "..", "..", "benchmarks", "benchmark.hwp");

async function open(page: Page) {
  await page.goto("/");
  await page.locator('[data-testid="file-input"]').setInputFiles(BENCHMARK);
  await expect(page.locator(".hw-sheet svg").first()).toBeVisible({ timeout: 60_000 });
}

async function scanForCell(page: Page): Promise<void> {
  const sheet = page.locator('.hw-sheet[data-page="0"]');
  const box = await sheet.boundingBox();
  if (!box) throw new Error("첫 페이지 시트 박스를 찾지 못함");
  for (let ry = 0.1; ry <= 0.9; ry += 0.04) {
    for (let rx = 0.1; rx <= 0.9; rx += 0.06) {
      await sheet.click({ position: { x: box.width * rx, y: box.height * ry } });
      const a = page.locator(".hw-anchor");
      if ((await a.count()) > 0 && (await a.first().innerText()).includes("행")) return;
    }
  }
  throw new Error("표 셀 앵커를 찾지 못함");
}

async function doubleClickSelectedCell(page: Page) {
  const markBox = await page.locator(".hw-mark-cell").first().boundingBox();
  if (!markBox) throw new Error("셀 마킹 박스를 찾지 못함");
  const cx = markBox.x + markBox.width / 2;
  const cy = markBox.y + markBox.height / 2;
  await page.mouse.click(cx, cy);
  await page.mouse.click(cx, cy);
  await expect(page.locator('[data-testid="hw-inplace-editor"]')).toBeVisible({ timeout: 15_000 });
}

// 리치 에디터 DOM 에서 주어진 글자를 담은 span 의 볼드 여부(computed font-weight ≥ 600).
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

test("리본 표시 + 비편집 굵게가 선택 셀 서식 op 을 낸다 (028과 동일 op·토스트)", async ({ page }) => {
  await open(page);
  // 영속 리본은 편집 크롬(enableEditing)에 항상 떠 있다.
  await expect(page.locator('[data-testid="hw-format-ribbon"]')).toBeVisible();
  await scanForCell(page);
  // 셀이 선택되면 리본 굵게가 활성화된다.
  const bold = page.locator('[data-testid="hw-ribbon-bold"]');
  await expect(bold).toBeEnabled({ timeout: 15_000 });
  await bold.click();
  // 비편집 경로 → SetCellRangeFmt(useSelectionActions) → 토스트("굵게 적용"/"굵게 해제").
  await expect(page.locator(".hw-status")).toContainText("굵게", { timeout: 30_000 });
});

test("편집 중 리본 굵게 버튼이 라이브 선택만 스타일 → 부분 서식 성립 → Enter 커밋 → SVG 반영", async ({ page }) => {
  await open(page);
  await scanForCell(page);
  await doubleClickSelectedCell(page);
  await expect(page.locator('[data-testid="hw-inplace-editor"]')).toHaveAttribute("contenteditable", "true");

  // 편집 중엔 밑줄/취소선 활성, 배경/정렬 비활성(라이브-run vs 셀 op).
  await expect(page.locator('[data-testid="hw-ribbon-underline"]')).toBeEnabled();
  await expect(page.locator('[data-testid="hw-ribbon-shade"]')).toBeDisabled();

  // 전체 선택 상태로 진입 → 알려진 라틴 문자열로 교체. 앞 3글자(QWE)만 선택.
  await page.keyboard.type("QWERTY");
  await page.keyboard.press("Home");
  for (let i = 0; i < 3; i++) await page.keyboard.press("Shift+ArrowRight");

  // ★ 리본 굵게 버튼(⌘B 아님)을 클릭. mousedown preventDefault 덕에 선택이 유지되어 라이브로 부분 굵게.
  await page.locator('[data-testid="hw-ribbon-bold"]').click();
  const qLive = await editorBold(page, "Q");
  const yLive = await editorBold(page, "Y");
  expect(qLive, "선택 부분(Q)과 비선택 부분(Y)의 서식이 달라야 한다(부분 서식)").not.toBe(yLive);

  // Enter=저장 → run 보존 커밋(SetTableCellRuns) → 자체렌더 SVG 에 새 텍스트 반영.
  await page.keyboard.press("Enter");
  await expect(page.locator('[data-testid="hw-inplace-editor"]')).toHaveCount(0, { timeout: 15_000 });
  await expect(page.locator(".hw-pages")).toContainText("Q", { timeout: 30_000 });

  // 재개봉 시 부분 서식 왕복(무접촉 런 불변).
  await doubleClickSelectedCell(page);
  const qRound = await editorBold(page, "Q");
  const yRound = await editorBold(page, "Y");
  expect(qRound, "재개봉 시에도 부분 서식이 보존돼야 한다").not.toBe(yRound);
  expect(qRound, "커밋 전후 선택 부분 서식 일치").toBe(qLive);
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-testid="hw-inplace-editor"]')).toHaveCount(0, { timeout: 15_000 });

  // undo → 편집 복구(QWERTY 사라짐).
  await page.locator('.hw-tool[title="실행취소"]').click();
  await expect(page.locator(".hw-pages")).not.toContainText("QWERTY", { timeout: 30_000 });
});
