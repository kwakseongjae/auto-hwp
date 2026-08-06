import { expect, test, type Page } from "@playwright/test";

// 편집 화면 헤더의 두 가지 사용자 계약(스크린샷 피드백):
//  ① 좌상단 로고 = 홈 앵커. **확인을 묻지 않는다**(자동저장이 스냅샷을 남기므로 잃는 것이 없다).
//     주소도 / 로 돌아오고, 편집본은 복구 배너로 다시 제안된다 = 콘텐츠 유실 없음.
//  ② AI 배지는 "지금 어떤 모델로 도는지"를 툴팁으로 말한다(호버/클릭). e2e 서버는 키를 비워
//     mock 으로 고정되므로 mock 쪽 문구를 검증한다 — 존재/토글 계약은 라이브와 같다.
const SAMPLE = "sample-8p.hwp";

async function openSample(page: Page) {
  await page.goto("/");
  await page.locator(`[data-testid="sample-${SAMPLE}"]`).click();
  await expect(page.locator(".hw-sheet svg").first()).toBeVisible({ timeout: 60_000 });
}

test("로고 클릭 → 확인 없이 홈 · 주소도 / · 편집본은 배너로 남는다", async ({ page }) => {
  await openSample(page);

  // confirm 이 뜨면 실패한다(자동저장이 있으므로 물어볼 이유가 없다).
  let dialogs = 0;
  page.on("dialog", (d) => {
    dialogs++;
    void d.dismiss();
  });

  await page.locator('[data-testid="doc-home"]').click();

  await expect(page.locator(".lab-empty")).toBeVisible({ timeout: 30_000 });
  expect(dialogs).toBe(0);
  expect(new URL(page.url()).pathname).toBe("/");
  await expect(page.locator(".hw-sheet svg")).toHaveCount(0);
});

test("AI 배지 → 클릭하면 어떤 모델로 도는지 툴팁으로 말한다", async ({ page }) => {
  await openSample(page);

  const badge = page.locator('[data-testid="ai-badge"]');
  await expect(badge).toBeVisible({ timeout: 30_000 });

  const tip = page.locator('[data-testid="ai-badge-tip"]');
  await expect(tip).toBeHidden();

  await badge.click();
  await expect(tip).toBeVisible();
  await expect(tip).toContainText("mock"); // e2e 서버는 키 없음 = mock 고정
  await expect(badge).toHaveAttribute("aria-expanded", "true");

  // 닫기: 포인터를 치우고(호버 표시 해제) Esc — 열어 둔 툴팁이 화면에 눌러앉지 않는다.
  await page.mouse.move(400, 400);
  await page.keyboard.press("Escape");
  await expect(tip).toBeHidden();
  await expect(badge).toHaveAttribute("aria-expanded", "false");
});
