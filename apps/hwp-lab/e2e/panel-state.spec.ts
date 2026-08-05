import { expect, test, type Page } from "@playwright/test";

// U1 — 우측 패널(바이브/디자인)의 상태 보존.
//
// 사용자 피드백: "탭을 옮기거나 패널을 접었다 펴면 채팅이 초기화된다." 원인은 접기(collapse)가 패널
// children 을 통째로 언마운트하던 것이었다. 이제 접기/펼치기·탭 전환은 **표시만** 바꾼다.
//
// 잠그는 계약: 작성 중이던 프롬프트 초안이
//   ① 바이브 → 디자인 → 바이브 왕복 후에도 살아 있다.
//   ② 패널 접기(›) → 펼치기(‹) 후에도 살아 있다.
// (AI 왕복 없이 검증한다 — 초안 텍스트가 곧 "패널이 같은 인스턴스로 살아 있는가"의 증거다.)
const SAMPLE = "sample-8p.hwp";
const DRAFT = "표 채워줘 — 초안보존081";

async function openSample(page: Page) {
  await page.goto("/");
  await page.locator(`[data-testid="sample-${SAMPLE}"]`).click();
  await expect(page.locator(".hw-sheet svg").first()).toBeVisible({ timeout: 60_000 });
}

const composer = (page: Page) => page.locator(".hw-sidepanel .hw-textarea");

test("탭 왕복(바이브↔디자인) 후에도 작성 중이던 초안이 남는다", async ({ page }) => {
  await openSample(page);
  await composer(page).fill(DRAFT);

  await page.locator('[data-testid="hw-design-tab"]').click();
  await expect(page.locator('[data-testid="hw-design-panel"]')).toBeVisible();
  await page.getByRole("tab", { name: "바이브 편집", exact: true }).click();

  await expect(composer(page)).toHaveValue(DRAFT);
});

test("패널 접기 → 펼치기 후에도 초안이 남는다 (언마운트 금지)", async ({ page }) => {
  await openSample(page);
  await composer(page).fill(DRAFT);

  await page.locator(".hw-sidepanel-collapse").click();
  await expect(page.locator(".hw-sidepanel-collapsed")).toBeVisible();
  // 접힌 동안 본문은 보이지 않는다(표시만 끈 것 — DOM 은 살아 있다).
  await expect(composer(page)).toBeHidden();

  await page.locator(".hw-sidepanel-expand").click();
  await expect(composer(page)).toBeVisible();
  await expect(composer(page)).toHaveValue(DRAFT);
});
