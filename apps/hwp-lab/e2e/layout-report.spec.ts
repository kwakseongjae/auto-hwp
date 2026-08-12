import path from "node:path";
import { expect, test } from "@playwright/test";

const BENCHMARK = path.resolve(process.cwd(), "..", "..", "benchmarks", "benchmark.hwp");

test("문서를 연 뒤 레이아웃 제보 초안은 형식만 싣고 파일명·본문은 싣지 않는다", async ({ page }) => {
  await page.goto("/");
  await page.locator('[data-testid="file-input"]').setInputFiles(BENCHMARK);
  await expect(page.locator(".hw-sheet svg").first()).toBeVisible({ timeout: 60_000 });

  const report = page.getByTestId("layout-report");
  await expect(report).toBeVisible();
  await expect(report).toHaveAttribute("target", "_blank");

  const href = await report.getAttribute("href");
  expect(href).toBeTruthy();
  const url = new URL(href!);
  const body = url.searchParams.get("body") ?? "";

  expect(url.origin + url.pathname).toBe("https://github.com/kwakseongjae/auto-hwp/issues/new");
  expect(body).toContain("원본 형식: .hwp");
  expect(body).toContain("공개 이슈 내용은 GitHub에 저장됩니다");
  expect(body).not.toContain("benchmark.hwp");
});
