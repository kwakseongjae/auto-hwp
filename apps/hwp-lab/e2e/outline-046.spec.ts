import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

// 이슈 046 아웃라인 패널 + 상태바 승격 e2e: 열기 → 아웃라인 항목 클릭 → 해당 페이지로 스크롤 이동 +
// 상태바의 현재 페이지 갱신. 데모 픽스처는 benchmarks/benchmark.hwp(8쪽). 실제 WasmAdapter(엔진
// outline() 바인딩) 경유로, 웹이 데스크톱 doc_outline 과 동형 파리티임을 라이브로 확인한다.
const BENCHMARK = path.resolve(process.cwd(), "..", "..", "benchmarks", "benchmark.hwp");

async function open(page: Page) {
  await page.goto("/");
  await page.locator('[data-testid="file-input"]').setInputFiles(BENCHMARK);
  await expect(page.locator(".hw-sheet svg").first()).toBeVisible({ timeout: 60_000 });
}

test("아웃라인 패널: 열림 → 항목 클릭 → 스크롤 이동 + 상태바 페이지 갱신", async ({ page }) => {
  await open(page);

  // 아웃라인 패널이 뜨고 항목(엔진 제목 또는 페이지목록 폴백)이 하나 이상 있어야 한다(빈 패널 금지).
  const panel = page.locator('[data-testid="hw-outline"]');
  await expect(panel).toBeVisible();
  const items = panel.locator('[data-testid="hw-outline-item"]');
  await expect(items.first()).toBeVisible({ timeout: 30_000 });
  const count = await items.count();
  expect(count, "아웃라인 항목이 하나 이상이어야 한다").toBeGreaterThan(0);

  // 상태바가 뜨고 "N / M쪽" 형태로 표시(줌 %는 상단 툴바 소유 — 상태바엔 % 없음).
  const statusPage = page.locator('[data-testid="hw-statusbar-page"]');
  await expect(statusPage).toContainText("쪽");
  await expect(page.locator('[data-testid="hw-statusbar"]')).not.toContainText("%");

  // 가장 뒤쪽 페이지를 가리키는 항목을 고른다(data-page 최대값) — 클릭하면 그 페이지로 스크롤한다.
  const target = await items.evaluateAll((els) => {
    let best = els[0];
    let bestPage = -1;
    for (const el of els) {
      const p = Number(el.getAttribute("data-page"));
      if (p > bestPage) {
        bestPage = p;
        best = el;
      }
    }
    return { page: bestPage, testid: best.getAttribute("data-page") };
  });
  expect(target.page, "뒤쪽 페이지를 가리키는 항목이 있어야 한다").toBeGreaterThan(0);

  const canvas = page.locator(".hw-canvas");
  const before = await canvas.evaluate((el) => el.scrollTop);
  await panel.locator(`[data-testid="hw-outline-item"][data-page="${target.page}"]`).first().click();

  // ★ 스크롤 이동 assert: 클릭 후 캔버스가 실제로 아래로 스크롤(해당 페이지가 위로 온다).
  await expect
    .poll(async () => canvas.evaluate((el) => el.scrollTop), { timeout: 15_000 })
    .toBeGreaterThan(before + 50);

  // ★ 상태바 페이지 갱신 assert(스크롤 위치 기반 독립 계산): 더 이상 1쪽이 아니다.
  await expect
    .poll(async () => statusPage.innerText(), { timeout: 15_000 })
    .not.toMatch(/^1 \//);
});

test("아웃라인 패널: 접기 토글 → 항목 숨김(접기 상태 기억)", async ({ page }) => {
  await open(page);
  const panel = page.locator('[data-testid="hw-outline"]');
  await expect(panel.locator('[data-testid="hw-outline-item"]').first()).toBeVisible({ timeout: 30_000 });
  // 접기 → 항목이 사라지고 펼치기 어포던스만 남는다.
  await panel.locator('[data-testid="hw-outline-toggle"]').click();
  await expect(panel.locator('[data-testid="hw-outline-item"]')).toHaveCount(0);
  // 상태가 localStorage 에 기억된다(다시 펼치면 항목이 돌아온다).
  await panel.locator('[data-testid="hw-outline-toggle"]').click();
  await expect(panel.locator('[data-testid="hw-outline-item"]').first()).toBeVisible({ timeout: 15_000 });
});
