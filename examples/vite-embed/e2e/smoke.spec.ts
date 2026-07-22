import path from "node:path";
import { expect, test } from "@playwright/test";

// 이식 증명(issue 063): published tarball(@auto-hwp/react·engine·editor-core·ai-protocol)을 설치한
// 비-Next Vite 앱에서 뷰어가 렌더되고 셀 편집이 왕복하는지 검증한다. 소스경로 import 0 — node_modules
// 의 발행본만 소비한다. 데모 픽스처: 레포 benchmarks/benchmark.hwp(8쪽).
const BENCHMARK = path.resolve(process.cwd(), "..", "..", "benchmarks", "benchmark.hwp");

test("published tarball → 뷰어 8쪽 렌더 → 셀 마킹 → mock 편집이 그 셀을 바꿈 → undo", async ({ page }) => {
  await page.goto("/");

  await page.locator('[data-testid="file-input"]').setInputFiles(BENCHMARK);

  // 뷰어 렌더 증명: 8쪽 SVG(엔진 wasm 은 public 정적 에셋에서 워커로 로드 — 넉넉한 타임아웃).
  await expect(page.locator(".hw-sheet")).toHaveCount(8, { timeout: 60_000 });
  await expect(page.locator(".hw-sheet svg").first()).toBeVisible({ timeout: 60_000 });

  // 셀 단위 마킹: 표 안을 클릭하면 셀 앵커("N행 M열")가 뜬다. 그리드로 스캔.
  const anchor = page.locator(".hw-anchor");
  const pages = page.locator(".hw-pages");
  const firstSheet = page.locator('.hw-sheet[data-page="0"]');
  const box = await firstSheet.boundingBox();
  if (!box) throw new Error("첫 페이지 시트 박스를 찾지 못함");

  let cellLabel: string | null = null;
  outer: for (let ry = 0.12; ry <= 0.88 && !cellLabel; ry += 0.06) {
    for (let rx = 0.12; rx <= 0.88; rx += 0.1) {
      await firstSheet.click({ position: { x: box.width * rx, y: box.height * ry } });
      if ((await anchor.count()) > 0) {
        const label = (await anchor.first().innerText()).trim();
        if (label.includes("행")) {
          cellLabel = label;
          break outer;
        }
      }
    }
  }
  expect(cellLabel, '표 안 클릭 → 셀 앵커(라벨에 "행")가 떠야 한다').toBeTruthy();
  expect(await anchor.count()).toBe(1);

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
