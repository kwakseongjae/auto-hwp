import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

// 이슈 059 IME 한글 인라인 조합 e2e: 셀 텍스트 클릭 → 글리프 캐럿 + 캐럿 추종 hidden textarea(입력 캡처
// 표면) 마운트/포커스 → CompositionEvent 합성(start→update→end)으로 조합 시뮬레이션 → 조합 중
// `.hw-ime-preview` 오버레이에 조합 문자열이 뜨고 실제 `.hw-caret` 는 숨는다(더블 캐럿 방지) → compositionend
// 로 `SetTableCellRuns` 1 undo 단위 커밋 → 자체렌더 SVG 에 반영 → undo 로 복원.
//
// ⚠️ Playwright/Chromium 은 OS IME 를 구동하지 못하므로 조합을 CompositionEvent 로 직접 합성한다(WKWebView
// 실기 IME 는 수동 QA 큐). 픽스처는 benchmark.hwp — 바이너리 .hwp(한글 폰트 보유)로 조합 커밋을 실문서로 증명.
const BENCHMARK = path.resolve(process.cwd(), "..", "..", "benchmarks", "benchmark.hwp");

// 실문서에 사실상 존재하지 않는 조합 토큰(희귀 음절 1자 — SVG 글리프 텍스트 매칭이 tspan 분할에 강건하도록).
const TOKEN = "뷁";
// 커밋된 본문은 오직 SVG 안에만 산다. `.hw-pages` 는 조합 오버레이(`.hw-ime-preview`)·툴바·앵커칩까지
// 품으므로 커밋 판정에는 SVG 서브트리만 본다(조합 중 프리뷰 토큰이 .hw-pages 에 섞여 오탐하는 것을 배제).
const COMMITTED = '.hw-sheet[data-page="0"] svg';

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

/** 캐럿 추종 hidden textarea 에 CompositionEvent 를 합성한다 (한 단계씩). */
async function dispatchComposition(page: Page, kind: "start" | "update" | "end", data: string) {
  await page.evaluate(
    ({ kind, data }) => {
      const ta = document.querySelector('[data-testid="hw-ime-input"]') as HTMLTextAreaElement | null;
      if (!ta) throw new Error("IME 캡처 textarea 부재 — 캐럿에 입력 표면이 붙지 않음");
      ta.focus();
      const type = kind === "start" ? "compositionstart" : kind === "update" ? "compositionupdate" : "compositionend";
      ta.dispatchEvent(new CompositionEvent(type, { data, bubbles: true }));
    },
    { kind, data },
  );
}

test("셀 클릭 → 조합 오버레이 표시(캐럿 숨김) → 확정 커밋(SVG 반영) → undo 복원", async ({ page }) => {
  await open(page);

  // 1) 셀 텍스트 클릭 → 글리프 캐럿 + 입력 캡처 textarea 가 캐럿에 붙는다(조합 시작 자체를 가능케 하는 핵심).
  await placeCaret(page);
  await expect(page.locator(".hw-caret")).toBeVisible();
  await expect(page.locator('[data-testid="hw-ime-input"]')).toHaveCount(1);
  await expect(page.locator(COMMITTED)).not.toContainText(TOKEN); // 커밋 전에는 SVG 에 없다

  // 2) 조합 시작 + 진행: compositionupdate 로 조합 문자열이 `.hw-ime-preview` 에 뜨고, 실제 캐럿 바는 숨는다.
  await dispatchComposition(page, "start", "");
  await dispatchComposition(page, "update", "ㅂ"); // 진행 중 낱자
  await expect(page.locator('[data-testid="hw-ime-preview"]')).toContainText("ㅂ", { timeout: 10_000 });
  await expect(page.locator(".hw-caret")).toHaveCount(0); // 조합 중 더블 캐럿 방지 — 실제 바 숨김
  await dispatchComposition(page, "update", TOKEN); // 완성 음절로 진행
  await expect(page.locator('[data-testid="hw-ime-preview"]')).toContainText(TOKEN);
  await expect(page.locator(COMMITTED)).not.toContainText(TOKEN); // 아직 미커밋 (모델/ SVG 불변)

  // 3) compositionend → end.data 를 SetTableCellRuns 1 undo 단위로 커밋 → 자체렌더 SVG 에 반영, 캐럿 복귀.
  await dispatchComposition(page, "end", TOKEN);
  await expect(page.locator(COMMITTED)).toContainText(TOKEN, { timeout: 30_000 }); // SVG 에 조합 결과 반영
  await expect(page.locator('[data-testid="hw-ime-preview"]')).toHaveCount(0); // 오버레이 사라짐
  await expect(page.locator(".hw-caret")).toBeVisible(); // 조합 종료 후 실제 캐럿 복귀

  // 4) undo → 조합 커밋 이전으로 복원.
  await page.locator('.hw-tool[title="실행취소"]').click();
  await expect(page.locator(COMMITTED)).not.toContainText(TOKEN, { timeout: 30_000 });
});
