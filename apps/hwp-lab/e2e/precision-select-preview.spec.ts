import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { showVibePanel } from "./cell-gesture";

// 이슈 2(행/칸 정밀 선택) + 이슈 3(적용 전 고스트 프리뷰) e2e — 실 엔진(wasm) + mock 프로바이더.
//
// 재현된 문제(이 스펙 이전): 표 위 클릭은 "표 (p.N)" 하나뿐이고, 셀은 숨은 더블클릭 드릴에만 있었으며
// 행 앵커는 **생산 경로 자체가 없었다**. 제안 카드도 텍스트 + "위치 보기"뿐이라 적용 전 결과를 볼 수
// 없었다. 여기서 실측하는 것:
//   ① 표를 고르면 행 머리(hw-row-head-*)가 실제로 뜬다 — 어포던스
//   ② 행 머리 클릭 → 앵커 칩이 "표 N행 전체"
//   ③ Shift+행 머리 → "표 a~b행 전체"
//   ④ 요청 본문 anchors 에 kind:"range" + rows/cols 가 실린다(모델이 좁은 대상을 안다)
//   ⑤ 제안 카드 hover → 문서 위 고스트 오버레이, 떠나면 사라짐 / "미리 보기" 토글로 고정·해제

const SAMPLE = path.resolve(process.cwd(), "public", "samples", "sample-8p.hwp");
const SHOTS = process.env.PRECISION_SHOT_DIR ?? "";

async function open(page: Page) {
  await page.goto("/");
  await page.locator('[data-testid="file-input"]').setInputFiles(SAMPLE);
  await expect(page.locator(".hw-sheet svg").first()).toBeVisible({ timeout: 60_000 });
}

/** 첫 페이지를 훑어 **여러 행짜리** 표를 클릭한다(행 머리는 표 선택 뒤에 뜬다. 1행짜리 안내 표에서는
 *  행 범위를 시험할 수 없으므로 최소 `minRows` 행을 요구한다). */
async function markTable(page: Page, minRows = 3): Promise<void> {
  const sheet = page.locator('.hw-sheet[data-page="0"]');
  const box = await sheet.boundingBox();
  if (!box) throw new Error("첫 페이지 시트 박스를 찾지 못함");
  for (let ry = 0.1; ry <= 0.9; ry += 0.04) {
    for (let rx = 0.2; rx <= 0.8; rx += 0.1) {
      await page.mouse.click(box.x + box.width * rx, box.y + box.height * ry);
      await page.waitForTimeout(150);
      if ((await page.locator('[data-testid^="hw-row-head-"]').count()) >= minRows) return;
    }
  }
  throw new Error(`첫 페이지에서 ${minRows}행 이상인 표를 찾지 못함`);
}

test("행 머리 → '표 N행 전체' 앵커 · Shift 로 행 범위 · 요청에 range 앵커가 실린다", async ({ page }) => {
  await open(page);
  await markTable(page);

  // ① 어포던스: 행 머리가 보인다(종전엔 행을 가리킬 수단 자체가 없었다).
  const heads = page.locator('[data-testid^="hw-row-head-"]');
  expect(await heads.count()).toBeGreaterThan(1);

  // ② 행 머리 클릭 → 행 전체 앵커.
  await heads.nth(1).click();
  const anchor = page.locator(".hw-anchor").first();
  await expect(anchor).toContainText("행 전체", { timeout: 15_000 });
  await expect(page.locator(".hw-mark-range")).toHaveCount(1);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/e2e-row-anchor.png` });

  // ③ Shift+행 머리 → 행 범위.
  await heads.nth(3).click({ modifiers: ["Shift"] });
  await expect(anchor).toContainText("~", { timeout: 15_000 });

  // ④ 요청 본문에 kind:"range" + rows/cols 가 실린다.
  await showVibePanel(page);
  const reqPromise = page.waitForRequest((r) => r.url().includes("/api/hwp-edit") && r.method() === "POST");
  await page.locator(".hw-textarea").fill("이 행만 채워줘");
  await page.locator(".hw-btn-send").click();
  const req = await reqPromise;
  const body = JSON.parse(req.postData() ?? "{}") as { anchors?: { kind?: string; rows?: number[]; cols?: number[] }[]; docContext?: string };
  const range = (body.anchors ?? []).find((a) => a.kind === "range");
  expect(range, "range 앵커가 요청에 실려야 한다").toBeTruthy();
  expect(range!.rows).toHaveLength(2);
  expect(range!.cols).toHaveLength(2);
  // 좁은 앵커여도 표 그리드 문맥은 유지된다(앵커만 좁힌다).
  expect(body.docContext ?? "").toContain("표 그리드");
});

test("제안 카드 hover/토글 → 적용 전 고스트 프리뷰가 문서 위에 뜨고 해제된다", async ({ page }) => {
  await open(page);
  await markTable(page);
  // 셀 하나를 앵커로 두면 mock 프로바이더가 그 칸을 겨냥한 SetTableCell 을 낸다.
  await page.locator('[data-testid^="hw-row-head-"]').nth(1).click();
  await showVibePanel(page);

  await page.locator(".hw-textarea").fill("이 표를 채워줘");
  await page.locator(".hw-btn-send").click();
  await expect(page.locator(".hw-card").first()).toBeVisible({ timeout: 30_000 });

  // 프리뷰 어포던스: 그릴 수 있으면 토글, 못 그리면 정직한 안내 — 둘 중 하나는 반드시 있다.
  const toggle = page.locator('[data-testid="hw-ghost-toggle"]');
  const none = page.locator('[data-testid="hw-ghost-none"]');
  await expect(toggle.or(none).first()).toBeVisible({ timeout: 15_000 });
  if ((await toggle.count()) === 0) {
    test.info().annotations.push({ type: "note", description: "이 제안은 삽입/삭제 전용이라 프리뷰 대상이 없다(정직한 안내 경로 확인)" });
    return;
  }

  // hover → 고스트가 뜬다.
  await page.locator(".hw-card").first().hover();
  await expect(page.locator(".hw-ghost").first()).toBeVisible({ timeout: 15_000 });
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/e2e-ghost-hover.png` });

  // 토글로 고정 → 떠나도 남는다.
  await toggle.click();
  await page.mouse.move(10, 10);
  await expect(page.locator(".hw-ghost").first()).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/e2e-ghost-pinned.png` });

  // 다시 눌러 해제 → 사라진다(적용은 일어나지 않았다).
  await toggle.click();
  await expect(page.locator(".hw-ghosts")).toHaveCount(0, { timeout: 15_000 });
  await expect(page.locator(".hw-applied")).toHaveCount(0);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/e2e-ghost-off.png` });
});
