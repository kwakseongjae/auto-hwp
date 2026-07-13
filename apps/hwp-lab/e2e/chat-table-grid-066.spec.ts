import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

// 이슈 066 e2e: 표(셀) 앵커를 마킹하고 "채워줘" 하면 (1) 클라가 엔진에서 그 표의 셀 그리드를 조회해
// doc-context 에 첨부하고(요청 본문에 "표 그리드"·(rNcM) 주소가 실림 — 066 수정의 결정적 신호),
// (2) 그리드를 본 mock 프로바이더가 빈 값칸을 겨냥한 SetTableCell 제안을 만들어(얇은 컨텍스트에선
// "제안된 편집이 없습니다" 였음) 프리뷰 카드가 뜨고, (3) 적용까지 완주한다. 키 없이 mock 으로 완주.
const BENCHMARK = path.resolve(process.cwd(), "..", "..", "benchmarks", "benchmark.hwp");

async function open(page: Page) {
  await page.goto("/");
  await page.locator('[data-testid="file-input"]').setInputFiles(BENCHMARK);
  await expect(page.locator(".hw-sheet svg").first()).toBeVisible({ timeout: 60_000 });
}

// 첫 페이지를 격자 스캔해 표/셀 앵커(라벨에 "행"/"표")를 만들 클릭 지점을 찾는다 — 그리드는 표/셀
// 앵커에서만 조회되므로 문단 앵커는 받지 않는다.
async function markTableAnchor(page: Page): Promise<void> {
  const sheet = page.locator('.hw-sheet[data-page="0"]');
  const box = await sheet.boundingBox();
  if (!box) throw new Error("첫 페이지 시트 박스를 찾지 못함");
  const anchor = page.locator(".hw-anchor");
  for (let ry = 0.12; ry <= 0.88; ry += 0.06) {
    for (let rx = 0.12; rx <= 0.88; rx += 0.1) {
      await sheet.click({ position: { x: box.width * rx, y: box.height * ry } });
      if ((await anchor.count()) > 0) {
        const label = (await anchor.first().innerText()).trim();
        if (label.includes("행") || label.includes("표")) return;
      }
    }
  }
  throw new Error("첫 페이지에서 표/셀 앵커를 만들 지점을 찾지 못함");
}

test("표 마킹 → '채워줘': doc-context 에 셀 그리드 첨부 → 그리드 기반 편집 제안 → 적용", async ({ page }) => {
  await open(page);
  await markTableAnchor(page);

  // 전송 직전 /api/hwp-edit POST 를 가로채 요청 본문을 검사한다.
  const reqPromise = page.waitForRequest((r) => r.url().includes("/api/hwp-edit") && r.method() === "POST");
  await page.locator(".hw-textarea").fill("이 표를 채워줘");
  await page.locator(".hw-btn-send").click();

  // (1) 066 수정의 핵심 신호: 요청 doc-context 에 그 표의 셀 그리드가 실렸다(헤더 + (rNcM) 셀 주소).
  const req = await reqPromise;
  const body = JSON.parse(req.postData() ?? "{}") as { docContext?: string };
  expect(body.docContext ?? "").toContain("표 그리드");
  expect(body.docContext ?? "").toMatch(/\(r\d+c\d+\)/);

  // (2) 그리드를 본 mock 이 편집을 제안한다 → 프리뷰 카드가 뜬다("제안된 편집이 없습니다" 아님).
  await expect(page.locator(".hw-card").first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("제안된 편집이 없습니다.")).toHaveCount(0);

  // (3) 적용 → 반영 완주(applied 배지). 이후 undo 로 되돌 수 있다.
  await page.locator(".hw-review .hw-btn-primary").click();
  await expect(page.locator(".hw-applied").first()).toBeVisible({ timeout: 30_000 });

  await page.locator('.hw-tool[title="실행취소"]').click();
  await expect(page.locator(".hw-status")).toContainText("실행취소", { timeout: 30_000 });
});
