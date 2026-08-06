import { expect, test, type Page } from "@playwright/test";

// 문서 세션 URL(/d/<불투명 키>) e2e.
//
// 잠그는 계약:
//  ① 문서를 열면 주소가 /d/<키> 로 바뀐다 — **파일명·내용은 주소에 실리지 않는다**(불투명 키만).
//  ② 그 주소로 새로고침하면 같은 문서로 돌아온다(기존 재개 레이어 재사용).
//  ③ 문서를 닫으면 주소가 / 로 돌아온다. 뒤로가기도 같은 결론(닫힘)이다.
//  ④ 이 브라우저에 기록이 없는 /d/<키>(다른 기기·저장소 비움)는 **정직한 안내 + 홈**이다.
//     되살릴 수 없는 주소로 엉뚱한 다른 문서를 대신 열어 주지 않는다.
const SAMPLE = "sample-8p.hwp";
const MARKER = "auto-hwp:live-doc";

async function openSample(page: Page) {
  await page.goto("/");
  await page.locator(`[data-testid="sample-${SAMPLE}"]`).click();
  await expect(page.locator(".hw-sheet svg").first()).toBeVisible({ timeout: 60_000 });
}

const docKeyFromUrl = (page: Page) => new URL(page.url()).pathname.match(/^\/d\/([A-Za-z0-9_-]+)$/)?.[1] ?? null;

test("문서를 열면 /d/<불투명 키> · 파일명은 주소에 없다", async ({ page }) => {
  await openSample(page);

  const key = docKeyFromUrl(page);
  expect(key).not.toBeNull();
  expect(key!.length).toBeGreaterThanOrEqual(8);
  // 불투명성: 파일명 조각도, 확장자도 주소에 없다.
  expect(page.url()).not.toContain("sample");
  expect(page.url()).not.toContain("hwp5");
  expect(page.url()).not.toContain(".hwp");
});

test("/d/<키> 새로고침 → 같은 문서로 복원 (주소도 그대로)", async ({ page }) => {
  await openSample(page);
  const url = page.url();
  const key = docKeyFromUrl(page)!;

  await page.reload();

  await expect(page.locator(".hw-sheet svg").first()).toBeVisible({ timeout: 60_000 });
  // 재개는 새 자동저장 세션을 만들지만 **사용자가 들고 있는 주소는 변하지 않는다**.
  expect(docKeyFromUrl(page)).toBe(key);
  expect(page.url()).toBe(url);
  // 재개 경로를 탔다는 증거(토스트) — 배너로 되묻지 않았다.
  await expect(page.locator('[data-testid="resume-toast"]')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-testid="recovery-banner"]')).toHaveCount(0);
});

test("문서 닫기 → 주소가 / 로 복원 · 뒤로가기도 닫힘", async ({ page }) => {
  await openSample(page);
  expect(docKeyFromUrl(page)).not.toBeNull();

  await page.locator('[data-testid="doc-close"]').click();
  await expect(page.locator(".lab-empty")).toBeVisible({ timeout: 30_000 });
  expect(new URL(page.url()).pathname).toBe("/");

  // 다시 열고 이번엔 브라우저 뒤로가기로 나간다(열기 = 히스토리 항목 하나).
  await page.locator(`[data-testid="sample-${SAMPLE}"]`).click();
  await expect(page.locator(".hw-sheet svg").first()).toBeVisible({ timeout: 60_000 });
  expect(docKeyFromUrl(page)).not.toBeNull();

  await page.goBack();
  await expect(page.locator(".lab-empty")).toBeVisible({ timeout: 30_000 });
  expect(new URL(page.url()).pathname).toBe("/");
  await expect(page.locator(".hw-sheet svg")).toHaveCount(0);
});

test("이 브라우저에서 열린 적 없는 /d/<키> → 정직한 안내 + 홈 (다른 기기 시나리오)", async ({ page }) => {
  // 저장소가 비어 있는 브라우저에 남의 주소를 붙여넣은 상황.
  await page.goto("/d/zzzz999zzz99");

  const notice = page.locator('[data-testid="autosave-notice"]');
  await expect(notice).toBeVisible({ timeout: 30_000 });
  await expect(notice).toContainText("이 브라우저에서 열렸던 문서입니다");
  await expect(page.locator(".lab-empty")).toBeVisible();
  await expect(page.locator(".hw-sheet svg")).toHaveCount(0);
  // 홈으로 되돌려 놓는다 — 죽은 주소를 주소창에 남겨 두지 않는다.
  await expect.poll(() => new URL(page.url()).pathname, { timeout: 10_000 }).toBe("/");
});

test("죽은 주소는 다른 문서를 대신 열지 않는다 (주소가 마커보다 우선)", async ({ page }) => {
  // 이 탭에서 문서를 하나 열어 재개 마커를 만들어 둔 뒤 …
  await openSample(page);
  expect(await page.evaluate((k) => sessionStorage.getItem(k), MARKER)).toContain(SAMPLE);

  // … 존재하지 않는 문서 주소로 들어간다. 마커가 살아 있어도 그 문서를 대신 열면 안 된다.
  await page.goto("/d/zzzz999zzz99");

  await expect(page.locator('[data-testid="autosave-notice"]')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".hw-sheet svg")).toHaveCount(0);
  await expect.poll(() => new URL(page.url()).pathname, { timeout: 10_000 }).toBe("/");
});
