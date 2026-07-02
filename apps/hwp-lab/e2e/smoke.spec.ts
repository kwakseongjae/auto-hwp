import path from "node:path";
import { expect, test } from "@playwright/test";

// 데모 픽스처: 레포 루트의 benchmark.hwp(8쪽). test:e2e 는 apps/hwp-lab 에서 실행되므로 cwd 기준
// ../../benchmark.hwp.
const BENCHMARK = path.resolve(process.cwd(), "..", "..", "benchmark.hwp");

test("업로드 → 8페이지 SVG → mock 편집 적용 → undo", async ({ page }) => {
  await page.goto("/");

  // 파일 열기 (hidden input) → benchmark.hwp 업로드.
  await page.locator('[data-testid="file-input"]').setInputFiles(BENCHMARK);

  // 8페이지 SVG 렌더 확인(엔진 wasm fetch + 페이지별 SVG는 비동기 → 넉넉한 타임아웃).
  await expect(page.locator(".hw-sheet")).toHaveCount(8, { timeout: 60_000 });
  await expect(page.locator(".hw-sheet svg").first()).toBeVisible({ timeout: 60_000 });
  const svgCount = await page.locator(".hw-sheet svg").count();
  expect(svgCount).toBe(8);

  // 표를 마킹할 클릭 지점을 그리드로 스캔(헤드리스에서 정확한 표 좌표를 몰라도 앵커 칩이 뜰 때까지).
  // 선택 모델 v2(이슈 021): 클릭 = 교체 → 각 클릭은 앵커를 누적하지 않고 하나로 갈아끼운다. 스캔은
  // 표 앵커(라벨 "표…")가 뜨는 즉시 멈추므로, 마지막 클릭 = 표 하나면 성립한다(SetTableCell mock 유발).
  const anchor = page.locator(".hw-anchor");
  const firstSheet = page.locator('.hw-sheet[data-page="0"]');
  const box = await firstSheet.boundingBox();
  if (!box) throw new Error("첫 페이지 시트 박스를 찾지 못함");

  let anchored = false;
  outer: for (let ry = 0.15; ry <= 0.85 && !anchored; ry += 0.1) {
    for (let rx = 0.15; rx <= 0.85; rx += 0.15) {
      await firstSheet.click({ position: { x: box.width * rx, y: box.height * ry } });
      if ((await anchor.count()) > 0) {
        const label = (await anchor.first().innerText()).trim();
        if (label.includes("표")) {
          anchored = true;
          break outer;
        }
      }
    }
  }
  // 표를 못 찾았으면 마지막에 잡힌 아무 앵커라도 사용(문단 등).
  if (!anchored) {
    await expect(anchor.first()).toBeVisible({ timeout: 10_000 });
  }
  // 교체 모델 검증: 여러 번 클릭했어도 선택은 정확히 하나여야 한다(누적 금지).
  expect(await anchor.count()).toBe(1);

  // 프롬프트 전송 → mock 제안 카드 → 적용.
  await page.locator(".hw-textarea").fill("이 칸을 채워줘");
  await page.locator(".hw-btn-send").click();
  await expect(page.locator(".hw-review .hw-btn-primary")).toBeVisible({ timeout: 30_000 });
  await page.locator(".hw-review .hw-btn-primary").click();
  await expect(page.locator(".hw-applied").first()).toBeVisible({ timeout: 30_000 });

  // 페이지 수는 편집 후에도 유지되어야 한다.
  await expect(page.locator(".hw-sheet")).toHaveCount(8, { timeout: 30_000 });

  // undo → 원상복구(툴바 ↶). 여전히 8페이지.
  await page.locator('.hw-tool[title="실행취소"]').click();
  await expect(page.locator(".hw-sheet")).toHaveCount(8, { timeout: 30_000 });
});
