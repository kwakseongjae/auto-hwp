import { expect, test, type Page } from "@playwright/test";

// 데모 전역 테마(라이트/다크) e2e.
//
// 잠그는 것 세 가지:
//   ① 기본값은 **라이트**다(저장된 선택이 없을 때). OS 가 다크여도 첫 방문은 라이트로 뜬다 —
//      문서/제품 사이트 관례. 저장소도 건드리지 않는다(선택 없음 = null 유지).
//   ② 토글은 `<html data-theme>` 를 바꾸고 **팔레트가 실제로 적용**된다(속성만 바뀌고 색이 그대로면
//      토큰 배선이 끊긴 것 — 계산된 배경색까지 확인한다).
//   ③ 선택은 localStorage 에 남아 **새로고침·다른 페이지(/bulk·/bench)** 에서도 유지되고,
//      OS 설정을 이긴다.
const LIGHT_BODY_BG = "rgb(245, 246, 251)"; // globals.css :root[data-theme="light"] --ah-bg
const DARK_BODY_BG = "rgb(7, 9, 13)"; // globals.css :root --ah-bg

const storedTheme = (page: Page) => page.evaluate(() => window.localStorage.getItem("auto-hwp:theme"));
const bodyBg = (page: Page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);

async function toggle(page: Page) {
  await page.locator('[data-testid="theme-toggle"]').first().click();
}

test("OS 가 다크여도 첫 방문은 라이트고, 토글한 다크는 새로고침·다른 페이지까지 유지된다", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  await expect(page.locator('[data-testid="theme-toggle"]').first()).toBeVisible({ timeout: 60_000 });

  // ① 저장된 선택 없음 → OS(다크)를 무시하고 라이트
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(await bodyBg(page)).toBe(LIGHT_BODY_BG);
  expect(await storedTheme(page)).toBeNull();

  // ② 토글 → 다크 (속성 + 실제 팔레트)
  await toggle(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(await bodyBg(page)).toBe(DARK_BODY_BG);
  expect(await storedTheme(page)).toBe("dark");

  // ③ 새로고침 — 기본값은 라이트지만 명시 선택이 이긴다
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(await bodyBg(page)).toBe(DARK_BODY_BG);

  // 같은 오리진의 다른 페이지도 같은 선택을 쓴다(첫 페인트 전 부트 스크립트)
  await page.goto("/bulk");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.goto("/bench");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(await bodyBg(page)).toBe(DARK_BODY_BG);

  // 다시 라이트로 되돌리면 그 선택도 남는다(토글은 두 값 사이만 오간다)
  await toggle(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(await storedTheme(page)).toBe("light");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(await bodyBg(page)).toBe(LIGHT_BODY_BG);
});

test("OS 가 라이트여도 결과는 같다 — 저장된 선택 없이 라이트", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(await storedTheme(page)).toBeNull();
  expect(await bodyBg(page)).toBe(LIGHT_BODY_BG);
});

test("저장된 다크는 OS 가 라이트여도 첫 페인트부터 유지된다", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.addInitScript(() => window.localStorage.setItem("auto-hwp:theme", "dark"));
  await page.goto("/bulk");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(await bodyBg(page)).toBe(DARK_BODY_BG);
});
