import { expect, test, type Page } from "@playwright/test";

// 데모 전역 테마(라이트/다크) e2e.
//
// 잠그는 것 세 가지:
//   ① 기본값은 **OS 설정**이다(저장된 선택이 없을 때). 저장소를 건드리지 않았는데 임의의 테마가
//      박히면 안 된다.
//   ② 토글은 `<html data-theme>` 를 바꾸고 **팔레트가 실제로 적용**된다(속성만 바뀌고 색이 그대로면
//      토큰 배선이 끊긴 것 — 계산된 배경색까지 확인한다).
//   ③ 선택은 localStorage 에 남아 **새로고침·다른 페이지(/bulk·/bench)** 에서도 유지되고,
//      OS 설정을 이긴다.
const LIGHT_BODY_BG = "rgb(245, 246, 251)"; // globals.css :root[data-theme="light"] --ah-bg

const themeAttr = (page: Page) => page.evaluate(() => document.documentElement.dataset.theme ?? null);
const storedTheme = (page: Page) => page.evaluate(() => window.localStorage.getItem("auto-hwp:theme"));
const bodyBg = (page: Page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);

async function toggle(page: Page) {
  await page.locator('[data-testid="theme-toggle"]').first().click();
}

test("OS 설정이 기본값이고, 토글한 라이트는 새로고침·다른 페이지까지 유지된다", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto("/");
  await expect(page.locator('[data-testid="theme-toggle"]').first()).toBeVisible({ timeout: 60_000 });

  // ① 저장된 선택 없음 → OS(다크)
  expect(await themeAttr(page)).toBe("dark");
  expect(await storedTheme(page)).toBeNull();

  // ② 토글 → 라이트 (속성 + 실제 팔레트)
  await toggle(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(await bodyBg(page)).toBe(LIGHT_BODY_BG);
  expect(await storedTheme(page)).toBe("light");

  // ③ 새로고침 — OS 는 여전히 다크지만 명시 선택이 이긴다
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(await bodyBg(page)).toBe(LIGHT_BODY_BG);

  // 같은 오리진의 다른 페이지도 같은 선택을 쓴다(첫 페인트 전 부트 스크립트)
  await page.goto("/bulk");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.goto("/bench");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(await bodyBg(page)).toBe(LIGHT_BODY_BG);

  // 다시 다크로 되돌리면 그 선택도 남는다(토글은 두 값 사이만 오간다)
  await toggle(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(await storedTheme(page)).toBe("dark");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});

test("OS 가 라이트면 저장된 선택 없이도 라이트로 뜬다", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  expect(await storedTheme(page)).toBeNull();
  expect(await bodyBg(page)).toBe(LIGHT_BODY_BG);
});
