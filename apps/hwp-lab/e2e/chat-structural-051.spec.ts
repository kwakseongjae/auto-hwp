import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

// 이슈 051 챗 구조 편집 e2e: 챗 "표 삽입" → 프리뷰 카드(위치+크기) → 적용 → SVG 반영 → undo 1회 복원,
// 그리고 "블록 삭제" → 위험(원문 표시) 카드 → 명시 승인(✓ 적용(삭제 포함)) 게이트. mock 프로바이더
// (route.ts mockIntents)가 결정적 InsertTableAt/DeleteBlock 을 만들므로 키 없이 완주한다.
const BENCHMARK = path.resolve(process.cwd(), "..", "..", "benchmarks", "benchmark.hwp");

async function open(page: Page) {
  await page.goto("/");
  await page.locator('[data-testid="file-input"]').setInputFiles(BENCHMARK);
  await expect(page.locator(".hw-sheet svg").first()).toBeVisible({ timeout: 60_000 });
}

// 첫 페이지를 격자 스캔해 앵커를 만들 클릭 지점을 찾는다(헤드리스에서 정확한 좌표를 몰라도 됨).
// `cellOnly` 는 표/셀 앵커(라벨에 "행"/"표")만 받는다 — 삭제 테스트는 표 블록을 지워야 SVG 변화가
// 결정적이다(빈 문단 삭제는 시각 신호가 0 일 수 있음).
async function markAnchor(page: Page, cellOnly = false): Promise<void> {
  const sheet = page.locator('.hw-sheet[data-page="0"]');
  const box = await sheet.boundingBox();
  if (!box) throw new Error("첫 페이지 시트 박스를 찾지 못함");
  const anchor = page.locator(".hw-anchor");
  for (let ry = 0.12; ry <= 0.88; ry += 0.06) {
    for (let rx = 0.12; rx <= 0.88; rx += 0.1) {
      await sheet.click({ position: { x: box.width * rx, y: box.height * ry } });
      if ((await anchor.count()) > 0) {
        if (!cellOnly) return;
        const label = (await anchor.first().innerText()).trim();
        if (label.includes("행") || label.includes("표")) return;
      }
    }
  }
  throw new Error("첫 페이지에서 앵커를 만들 지점을 찾지 못함");
}

// 페이지 0 SVG 의 요소 수 — 구조 변화(표 삽입/블록 삭제)의 결정적·id-비의존 신호.
async function page0SvgElementCount(page: Page): Promise<number> {
  return page.locator('.hw-sheet[data-page="0"] svg *').count();
}

test("챗 표 삽입: 앵커 → '3×3 표 삽입' → 프리뷰 카드 → 적용 → SVG 반영 → undo 1회 복원", async ({ page }) => {
  await open(page);
  await markAnchor(page);
  const before = await page0SvgElementCount(page);

  // 프롬프트 → mock InsertTableAt(앵커 블록 위치) 제안.
  await page.locator(".hw-textarea").fill("여기에 3x3 표를 삽입해줘");
  await page.locator(".hw-btn-send").click();

  // 프리뷰 카드: 라벨 "표 삽입" + 크기/위치 요약. 카드가 뜬 시점엔 아직 문서 무변경(프리뷰 게이트).
  const card = page.locator(".hw-card").first();
  await expect(card).toBeVisible({ timeout: 30_000 });
  await expect(card.locator(".hw-card-label")).toHaveText("표 삽입");
  await expect(card.locator(".hw-card-summary")).toContainText("3×3 표 삽입");
  expect(await page0SvgElementCount(page)).toBe(before); // 프리뷰만으로는 무변경

  // 적용 → 페이지 0 SVG 에 표가 실제로 반영된다(요소 수 증가 — id 비의존 시각 신호).
  await page.locator(".hw-review .hw-btn-primary").click();
  await expect(page.locator(".hw-applied").first()).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => page0SvgElementCount(page), { timeout: 30_000 }).toBeGreaterThan(before);

  // undo 1회 = 1 undo 단위 전체 복원(요소 수가 원래대로).
  await page.locator('.hw-tool[title="실행취소"]').click();
  await expect(page.locator(".hw-status")).toContainText("실행취소", { timeout: 30_000 });
  await expect.poll(() => page0SvgElementCount(page), { timeout: 30_000 }).toBe(before);
});

test("챗 블록 삭제: 위험 카드(원문 표시) → 취소는 무변경 → 명시 승인 후에만 적용 → undo 복원", async ({ page }) => {
  await open(page);
  await markAnchor(page, true); // 표/셀 앵커 — 표 블록 삭제는 SVG 변화가 결정적
  const before = await page0SvgElementCount(page);

  // 1) 삭제 제안 → DESTRUCTIVE 카드: danger 스타일 + 대상 블록 원문(detail) + 승인 버튼이 삭제를 명명.
  await page.locator(".hw-textarea").fill("이 블록 삭제해줘");
  await page.locator(".hw-btn-send").click();
  await expect(page.locator(".hw-card-danger").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-testid="hw-card-detail"]').first()).not.toBeEmpty();
  const approve = page.locator(".hw-review .hw-btn-primary");
  await expect(approve).toHaveText("✓ 적용(삭제 포함)");

  // 2) 취소 → 아무 것도 적용되지 않는다(자동 적용 경로 금지의 관측 절반).
  await page.locator(".hw-review .hw-btn-ghost").click();
  await expect(page.locator(".hw-discarded").first()).toBeVisible();
  expect(await page0SvgElementCount(page)).toBe(before);

  // 3) 다시 제안 → 이번엔 명시 승인 → 블록이 실제로 삭제된다(SVG 요소 수 변화) → undo 복원.
  await markAnchor(page, true);
  await page.locator(".hw-textarea").fill("이 블록 삭제해줘");
  await page.locator(".hw-btn-send").click();
  await expect(page.locator(".hw-card-danger").first()).toBeVisible({ timeout: 30_000 });
  await page.locator(".hw-review .hw-btn-primary").click();
  await expect(page.locator(".hw-applied").first()).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => page0SvgElementCount(page), { timeout: 30_000 }).not.toBe(before);

  await page.locator('.hw-tool[title="실행취소"]').click();
  await expect(page.locator(".hw-status")).toContainText("실행취소", { timeout: 30_000 });
  await expect.poll(() => page0SvgElementCount(page), { timeout: 30_000 }).toBe(before);
});
