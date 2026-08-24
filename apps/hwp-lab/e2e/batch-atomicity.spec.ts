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

test("제안 검증이 도중에 실패하면 카드·부분 편집 없이 원문을 유지한다", async ({ page }) => {
  await open(page);
  const before = await docText(page);

  await stubIntents(page, [
    { intent: "SetParagraphText", section: 0, block: PARA_BLOCK, text: "PARTIAL" },
    { intent: "SetParagraphText", section: 0, block: 99999, text: "없는 블록" }, // 엔진이 거절
  ]);
  await showVibePanel(page);
  await page.locator(".hw-textarea").fill("이 문단을 고쳐줘");
  await page.locator(".hw-btn-send").click();
  await expect(page.locator(".hw-chat")).toContainText("proposal scratch intent[1] failed", { timeout: 30_000 });
  await expect(page.locator(".hw-card")).toHaveCount(0);

  // 검증 실패가 정직하려면 승인 카드도, 첫 intent의 흔적도 없어야 한다.
  await expect.poll(async () => docText(page), { timeout: 30_000 }).toBe(before);

  // 그리고 되돌릴 것이 없다고 정직하게 답해야 한다(예전엔 침묵 → "⌘Z 무반응"으로 읽혔다).
  // 툴바 ↶ 는 되돌릴 게 없으면 disabled 라 클릭이 닿지 않는다 — 사용자가 실제로 누르는 ⌘Z 로 확인한다.
  // (작성창 안에서의 ⌘Z 는 그 표면의 몫이므로, 먼저 포커스를 문서로 돌려놓는다.)
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Meta+z");
  await expect(page.locator(".hw-status")).toContainText("되돌릴 편집이 없습니다", { timeout: 30_000 });

  // UI는 검증 실패를 승인 가능한 카드로 가장하지 않는다. 엔진의 detached scratch와 live revision
  // 불변은 hwp-mcp Proposal v1 단위 테스트가 별도로 잠근다.
});
