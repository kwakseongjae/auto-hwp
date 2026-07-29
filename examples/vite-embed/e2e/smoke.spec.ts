import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

// 이식 증명(issue 063): published tarball(@auto-hwp/react·engine·editor-core·ai-protocol)을 설치한
// 비-Next Vite 앱에서 뷰어가 렌더되고 셀 편집이 왕복하는지 검증한다. 소스경로 import 0 — node_modules
// 의 발행본만 소비한다. 데모 픽스처: 레포 benchmarks/benchmark.hwp(8쪽).
const BENCHMARK = path.resolve(process.cwd(), "..", "..", "benchmarks", "benchmark.hwp");

async function selectFirstCell(page: Page): Promise<string> {
  const cell = page.locator(".hw-mark-cell").first();
  const label = page.locator(".hw-mark-label").first();
  const sheet = page.locator('.hw-sheet[data-page="0"]');
  const box = await sheet.boundingBox();
  if (!box) throw new Error("첫 페이지 시트 박스를 찾지 못함");

  for (let ry = 0.1; ry <= 0.9; ry += 0.04) {
    for (let rx = 0.1; rx <= 0.9; rx += 0.06) {
      const x = box.x + box.width * rx;
      const y = box.y + box.height * ry;
      await page.mouse.click(x, y);
      await page.waitForTimeout(150);
      if ((await cell.count()) > 0) return (await label.innerText()).trim();
      if ((await page.locator(".hw-mark-table").count()) === 0) continue;

      await page.waitForTimeout(500);
      await page.mouse.click(x, y);
      await page.waitForTimeout(100);
      await page.mouse.click(x, y);
      try {
        await expect(cell).toBeVisible({ timeout: 4_000 });
        return (await label.innerText()).trim();
      } catch {
        continue;
      }
    }
  }
  const status = await page.locator(".hw-status").allInnerTexts();
  throw new Error(
    `표 셀을 드릴하지 못함 (스캔 실패: table=${await page.locator(".hw-mark-table").count()}, cell=${await cell.count()}, status=${JSON.stringify(status)})`,
  );
}

test("published tarball → 뷰어 8쪽 렌더 → 셀 마킹 → mock 편집이 그 셀을 바꿈 → undo", async ({ page }) => {
  await page.goto("/");

  await page.locator('[data-testid="file-input"]').setInputFiles(BENCHMARK);

  // 뷰어 렌더 증명: 8쪽 SVG(엔진 wasm 은 public 정적 에셋에서 워커로 로드 — 넉넉한 타임아웃).
  await expect(page.locator(".hw-sheet")).toHaveCount(8, { timeout: 60_000 });
  await expect(page.locator(".hw-sheet svg").first()).toBeVisible({ timeout: 60_000 });

  // 셀 단위 마킹: 표 안을 클릭하면 셀 앵커("N행 M열")가 뜬다. 그리드로 스캔.
  const cellMark = page.locator(".hw-mark-cell");
  const pages = page.locator(".hw-pages");
  const cellLabel = await selectFirstCell(page);
  expect(cellLabel, '표 안 클릭 → 셀 마킹(라벨에 "행")이 떠야 한다').toContain("행");
  expect(await cellMark.count()).toBe(1);

  await expect(pages).not.toContainText("PoC");

  // 프롬프트 전송 → 로컬 mock 제안 카드 → 적용. mock 은 클릭한 셀에 "PoC ✔"를 쓴다(서버 없음).
  await page.locator(".hw-textarea").fill("이 칸을 채워줘");
  await page.locator(".hw-btn-send").click();
  await expect(page.locator(".hw-review .hw-btn-primary")).toBeVisible({ timeout: 30_000 });
  await page.locator(".hw-review .hw-btn-primary").click();
  await expect(page.locator(".hw-applied").first()).toBeVisible({ timeout: 30_000 });

  await expect(pages).toContainText("PoC", { timeout: 30_000 });
  await expect(page.locator(".hw-sheet")).toHaveCount(8, { timeout: 30_000 });

  // undo → "PoC" 제거 + 여전히 8쪽.
  await page.locator('.hw-tool[title="실행취소"]').click();
  await expect(pages).not.toContainText("PoC", { timeout: 30_000 });
  await expect(page.locator(".hw-sheet")).toHaveCount(8, { timeout: 30_000 });
});
