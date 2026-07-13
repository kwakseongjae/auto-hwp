import path from "node:path";
import { expect, test, type CDPSession, type Page } from "@playwright/test";

// 이슈 059 IME 한글 조합 — CHROME CDP e2e (059 회귀 잠금).
//
// 기존 ime-composition-059.spec.ts 는 `new CompositionEvent(...)` 를 JS 로 직접 디스패치했다. 이 스펙은
// 한 단계 더 실물에 가깝게, **Chromium 의 실제 입력 파이프라인**을 CDP 로 구동한다:
//   · Input.dispatchKeyEvent(keyCode 229 = IME sentinel/"Process") — 실 IME 가 조합 중 보내는 keydown.
//   · Input.imeSetComposition(text) — 조합 문자열(marked text) 설정 → compositionstart/update 를 렌더러가 발화.
//   · Input.insertText(text) — 조합 확정 → compositionend + input 을 발화(SetTableCellRuns 커밋).
//
// 잠그는 계약(059):
//   1) keyCode 229 keydown 이 raw-typing 레인(053 `keyCode===229` 가드)에 통째로 삼켜지지 않고, 조합이
//      실제로 시작된다 — `.hw-ime-preview` 오버레이가 뜨고 실제 `.hw-caret` 는 숨는다(더블 캐럿 방지).
//   2) 조합 중에는 모델/ SVG 가 불변(프리뷰는 오버레이일 뿐 커밋 아님).
//   3) compositionend(확정) 시에만 SetTableCellRuns 1 undo 단위로 커밋되어 자체렌더 SVG 에 반영되고, undo 로 복원.
//
// ⚠️ ImeCompositionLayer 는 읽기 전용(이 스펙은 관찰만). WKWebView 실기 IME 는 스코프 밖(수동 QA 큐) — CDP 는
// 로컬 Chromium 에서 조합 파이프라인을 재현하는 최선의 자동 회귀다.
const BENCHMARK = path.resolve(process.cwd(), "..", "..", "benchmarks", "benchmark.hwp");

// 실문서에 사실상 없는 조합 토큰(희귀 음절 1자 — SVG tspan 분할에 강건).
const TOKEN = "뷁";
// 커밋된 본문은 오직 SVG 안에만 산다. `.hw-pages` 는 조합 오버레이/툴바/앵커칩까지 품으므로 커밋 판정에는
// SVG 서브트리만 본다(조합 중 프리뷰 토큰이 .hw-pages 에 섞여 오탐하는 것을 배제).
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

/** 캐럿 추종 hidden textarea 에 렌더러 포커스를 준다 — CDP 입력은 focused 엘리먼트로 전달되므로 필수. */
async function focusImeInput(page: Page): Promise<void> {
  await page.evaluate(() => {
    const ta = document.querySelector('[data-testid="hw-ime-input"]') as HTMLTextAreaElement | null;
    if (!ta) throw new Error("IME 캡처 textarea 부재 — 캐럿에 입력 표면이 붙지 않음");
    ta.focus();
  });
  await expect(page.locator('[data-testid="hw-ime-input"]')).toBeFocused();
}

/** 실 IME 의 조합-중 sentinel: keyCode 229("Process") keydown/keyup 한 쌍. raw-typing 가드가 이를
 *  무시(053 `keyCode===229`)하고 조합 레인이 대신 소유하는지를 검증하려고 매 조합 단계마다 발사한다. */
async function key229(client: CDPSession): Promise<void> {
  await client.send("Input.dispatchKeyEvent", { type: "keyDown", windowsVirtualKeyCode: 229, key: "Process" });
  await client.send("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: 229, key: "Process" });
}

/** 조합 문자열(marked text)을 설정 → 렌더러가 compositionstart(첫 회)/compositionupdate 를 발화. */
async function setComposition(client: CDPSession, text: string): Promise<void> {
  await client.send("Input.imeSetComposition", { text, selectionStart: text.length, selectionEnd: text.length });
}

test("CDP 한글 조합: 229 keydown→조합 시작(오버레이·캐럿 숨김) → 확정(insertText)→SetTableCellRuns 커밋 → undo", async ({ page }) => {
  await open(page);

  // 1) 셀 텍스트 클릭 → 글리프 캐럿 + 입력 캡처 textarea 마운트 → 렌더러 포커스(조합 시작의 전제).
  await placeCaret(page);
  await expect(page.locator(".hw-caret")).toBeVisible();
  await expect(page.locator('[data-testid="hw-ime-input"]')).toHaveCount(1);
  await focusImeInput(page);
  await expect(page.locator(COMMITTED)).not.toContainText(TOKEN); // 커밋 전 SVG 에 없음

  const client = await page.context().newCDPSession(page);

  // 2) 229 keydown(삼켜져야 하는 raw 레인) + imeSetComposition("ㅂ") → 조합이 실제로 시작:
  //    프리뷰 오버레이가 뜨고 실제 캐럿 바는 숨는다(계약 1). 229 가 "통째로 삼켜졌다면" 여기서 아무 일도 안 났을 것.
  await key229(client);
  await setComposition(client, "ㅂ");
  await expect(page.locator('[data-testid="hw-ime-preview"]')).toContainText("ㅂ", { timeout: 10_000 });
  await expect(page.locator(".hw-caret")).toHaveCount(0); // 조합 중 더블 캐럿 방지 — 실제 바 숨김

  // 3) 조합 진행: 완성 음절까지. 모델/ SVG 는 여전히 불변(계약 2 — 프리뷰는 커밋 아님).
  await key229(client);
  await setComposition(client, TOKEN);
  await expect(page.locator('[data-testid="hw-ime-preview"]')).toContainText(TOKEN);
  await expect(page.locator(COMMITTED)).not.toContainText(TOKEN);

  // 4) 확정: insertText 로 조합을 커밋 → compositionend(data=TOKEN) → SetTableCellRuns 1 undo 단위 →
  //    자체렌더 SVG 에 반영, 오버레이 사라지고 실제 캐럿 복귀(계약 3).
  await client.send("Input.insertText", { text: TOKEN });
  await expect(page.locator(COMMITTED)).toContainText(TOKEN, { timeout: 30_000 });
  await expect(page.locator('[data-testid="hw-ime-preview"]')).toHaveCount(0);
  await expect(page.locator(".hw-caret")).toBeVisible();

  // 5) undo → 조합 커밋 이전으로 복원(1 undo 단위였음을 증명).
  await page.locator('.hw-tool[title="실행취소"]').click();
  await expect(page.locator(COMMITTED)).not.toContainText(TOKEN, { timeout: 30_000 });
});
