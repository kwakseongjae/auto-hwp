import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { showVibePanel } from "./cell-gesture";

// caret-undo 증상 4 회귀: "적용 → 되돌리기 1클릭 → 원상복구"를 **문서 내용으로** 검증한다.
// 기존 e2e(chat-table-grid-066)는 실행취소 토스트만 봤기 때문에, 배치가 부분 실패해 undo 장부에
// 아무것도 안 남는 실사용 실패(적용 실패인데 문서는 바뀜 + ⌘Z 가 엉뚱한 편집을 벗김)를 놓쳤다.
//
// 상류 응답을 NDJSON 으로 스텁해 제안 intents 를 결정적으로 고정한다(모델/mock 휴리스틱 무관).
const SAMPLE = path.resolve(process.cwd(), "public", "samples", "sample-8p.hwp");
/** 표지 아래 본문 문단 — 편집/복원을 눈으로(글리프로) 확인할 수 있는 지점. */
const PARA_BLOCK = 46;
const PARA_MARK = "사업추진";

async function open(page: Page) {
  await page.goto("/");
  await page.locator('[data-testid="file-input"]').setInputFiles(SAMPLE);
  await expect(page.locator(".hw-sheet svg").first()).toBeVisible({ timeout: 60_000 });
}

/** 렌더된 모든 페이지의 글리프 텍스트 — 원상복구 판정용 지문. */
async function docText(page: Page): Promise<string> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll(".hw-pages text"))
      .map((e) => e.textContent ?? "")
      .join(""),
  );
}

async function stubIntents(page: Page, intents: unknown[]) {
  await page.route("**/api/hwp-edit**", async (route) => {
    const body =
      [JSON.stringify({ type: "status", phase: "thinking" }), JSON.stringify({ type: "intents", intents })].join("\n") + "\n";
    await route.fulfill({ status: 200, headers: { "Content-Type": "application/x-ndjson; charset=utf-8" }, body });
  });
}

async function propose(page: Page, text: string) {
  await showVibePanel(page);
  await page.locator(".hw-textarea").fill(text);
  await page.locator(".hw-btn-send").click();
  await expect(page.locator(".hw-card").first()).toBeVisible({ timeout: 30_000 });
}

test("N건 일괄 적용 → 카드의 되돌리기 1클릭 → 문서가 원상으로 돌아온다", async ({ page }) => {
  await open(page);
  const before = await docText(page);
  expect(before).toContain(PARA_MARK);

  await stubIntents(page, [
    { intent: "SetParagraphText", section: 0, block: PARA_BLOCK, text: "AAA1" },
    { intent: "SetParagraphText", section: 0, block: PARA_BLOCK, text: "AAA2" },
    { intent: "SetParagraphText", section: 0, block: PARA_BLOCK, text: "AAA3" },
  ]);
  await propose(page, "이 문단을 고쳐줘");
  expect(await page.locator(".hw-card").count()).toBe(3);

  await page.locator(".hw-review .hw-btn-primary").click();
  await expect(page.locator(".hw-applied").first()).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => (await docText(page)).includes("AAA3"), { timeout: 30_000 }).toBe(true);

  // 3건 = 한 배치 → 되돌리기 한 번이면 전부 사라져야 한다.
  await page.getByRole("button", { name: "되돌리기" }).first().click();
  await expect.poll(async () => docText(page), { timeout: 30_000 }).toBe(before);
});

test("배치가 도중에 실패하면 이미 들어간 편집까지 롤백된다 (적용 실패 = 문서 그대로)", async ({ page }) => {
  await open(page);
  const before = await docText(page);

  await stubIntents(page, [
    { intent: "SetParagraphText", section: 0, block: PARA_BLOCK, text: "PARTIAL" },
    { intent: "SetParagraphText", section: 0, block: 99999, text: "없는 블록" }, // 엔진이 거절
  ]);
  await propose(page, "이 문단을 고쳐줘");

  await page.locator(".hw-review .hw-btn-primary").click();
  await expect(page.locator(".hw-chat")).toContainText("적용 실패", { timeout: 30_000 });

  // 실패 안내가 정직하려면 문서에 첫 건의 흔적도 남아 있으면 안 된다.
  await expect.poll(async () => docText(page), { timeout: 30_000 }).toBe(before);

  // 그리고 되돌릴 것이 없다고 정직하게 답해야 한다(예전엔 침묵 → "⌘Z 무반응"으로 읽혔다).
  // 툴바 ↶ 는 되돌릴 게 없으면 disabled 라 클릭이 닿지 않는다 — 사용자가 실제로 누르는 ⌘Z 로 확인한다.
  // (작성창 안에서의 ⌘Z 는 그 표면의 몫이므로, 먼저 포커스를 문서로 돌려놓는다.)
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Meta+z");
  await expect(page.locator(".hw-status")).toContainText("되돌릴 편집이 없습니다", { timeout: 30_000 });

  // ⚠️ 이 스펙은 **사용자에게 보이는 계약**(실패 = 화면 원상 + 정직한 ⌘Z 안내)만 잠근다. 수리 전 코드에서
  //   화면이 그대로였던 이유는 "안전해서"가 아니라 부분 실패가 리플로우조차 일으키지 않아 **오염이 보이지
  //   않았기 때문**이다(모델은 더러운데 렌더는 옛것). 롤백 자체의 red→green 증명은
  //   packages/editor-core/src/__tests__/session.test.ts 의 배치 원자성 3건이 담당한다.
});
