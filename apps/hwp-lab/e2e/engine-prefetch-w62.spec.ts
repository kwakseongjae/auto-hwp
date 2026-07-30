import { expect, test } from "@playwright/test";

// W6.2 — 랜딩 유휴 프리페치 + 엔진 내려받기 진행률.
//
// 잠그는 것:
//   1. 랜딩에 들어오면 **사용자가 아무것도 누르지 않아도** 엔진 wasm 요청이 나간다(유휴 프리페치).
//   2. 그 상태가 화면에 보인다: `engine-load` 칩이 "내려받는 중"에서 `data-engine-done="1"` 로 끝난다.
//   3. 진행률 콜백이 100% 를 미리 선언하지 않는다 — done 이 되기 전에는 "준비 완료" 문구가 뜨지 않는다.
//   4. 프리페치가 끝난 뒤 여는 문서도 정상 렌더된다(예열이 열기 경로를 깨지 않는다).
test("랜딩 유휴에 엔진을 미리 받고 진행률을 보여준다", async ({ page }) => {
  const wasmRequests: string[] = [];
  page.on("request", (r) => {
    if (r.url().endsWith(".wasm")) wasmRequests.push(r.url());
  });

  await page.goto("/");
  await expect(page.locator('[data-testid="lab-hero"]')).toBeVisible();

  const chip = page.locator('[data-testid="engine-load"]');
  // 유휴 콜백 → fetch 시작 → 첫 tick. 아무 클릭도 하지 않는다.
  await expect(chip).toBeVisible({ timeout: 30_000 });

  // 끝나기 전 표시는 "내려받는 중" 이어야 한다(추정 분모라도 조기 100%/완료 문구 금지).
  const midText = (await chip.innerText()).trim();
  const midDone = await chip.getAttribute("data-engine-done");
  if (midDone === "0") expect(midText).toContain("내려받는 중");

  await expect(chip).toHaveAttribute("data-engine-done", "1", { timeout: 60_000 });
  await expect(chip).toContainText("엔진 준비 완료");
  expect(wasmRequests.length, "랜딩에서 wasm 요청이 최소 1건 나가야 한다(프리페치)").toBeGreaterThan(0);

  // 예열 뒤 실제 열기가 정상 동작하는지(샘플 8쪽).
  await page.locator('[data-testid="sample-sample-8p.hwp"]').click();
  await expect(page.locator(".hw-sheet")).toHaveCount(8, { timeout: 60_000 });
});
