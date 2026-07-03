import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

// 이슈 038 호버 프리하이라이트(FG-09) + 커서 상태 체계(FG-06) e2e. 데모 픽스처는 benchmark.hwp(8쪽, 표 +
// 본문 문단). enableEditing 이 켜진 lab 에서 검증한다: (1) 커서 아래 블록에 얇은 파란 외곽선(.hw-hover)이
// 뜨고 그 박스가 커서를 감싼다(위치 근사) — 클릭이 아니므로 선택 앵커는 만들지 않는다. (2) 본문 문단 위에서
// text I-beam 커서(.hw-canvas[data-hover-cursor="text"])가 켜진다.
const BENCHMARK = path.resolve(process.cwd(), "..", "..", "benchmarks", "benchmark.hwp");

async function open(page: Page) {
  await page.goto("/");
  await page.locator('[data-testid="file-input"]').setInputFiles(BENCHMARK);
  await expect(page.locator(".hw-sheet svg").first()).toBeVisible({ timeout: 60_000 });
}

// 한 페이지를 격자로 호버 스캔해 `predicate` 가 true 를 반환하는 첫 지점을 돌려준다(정확한 블록 좌표를 몰라도 됨).
async function scanHoverOnPage(page: Page, dp: number, predicate: () => Promise<boolean>): Promise<{ x: number; y: number } | null> {
  const sheet = page.locator(`.hw-sheet[data-page="${dp}"]`);
  if ((await sheet.count()) === 0) return null;
  await sheet.scrollIntoViewIfNeeded();
  const box = await sheet.boundingBox();
  if (!box) return null;
  for (let ry = 0.06; ry <= 0.94; ry += 0.05) {
    for (let rx = 0.1; rx <= 0.9; rx += 0.08) {
      const pos = { x: box.x + box.width * rx, y: box.y + box.height * ry };
      await page.mouse.move(pos.x, pos.y);
      await page.waitForTimeout(55); // rAF + 어댑터 hit-test 정착
      if (await predicate()) return pos;
    }
  }
  return null;
}

test("호버 프리하이라이트: 커서 아래 블록에 외곽선이 뜨고 커서를 감싼다 (위치 근사, 선택 아님)", async ({ page }) => {
  await open(page);
  const found = await scanHoverOnPage(page, 0, async () => (await page.locator(".hw-hover").count()) > 0);
  expect(found, "커서 아래 블록에 프리하이라이트가 떠야 한다").toBeTruthy();

  const hb = await page.locator(".hw-hover").first().boundingBox();
  if (!hb || !found) throw new Error("호버 박스를 찾지 못함");
  // ★ 위치 근사: 프리하이라이트 박스가 커서 지점을 감싼다(±6px 여유) — 커서 아래 블록을 정확히 가리킨다는 증거.
  expect(found.x, "커서 X 가 호버 박스 안").toBeGreaterThanOrEqual(hb.x - 6);
  expect(found.x).toBeLessThanOrEqual(hb.x + hb.width + 6);
  expect(found.y, "커서 Y 가 호버 박스 안").toBeGreaterThanOrEqual(hb.y - 6);
  expect(found.y).toBeLessThanOrEqual(hb.y + hb.height + 6);
  // 호버는 클릭이 아니다 → 선택 앵커 0(프리하이라이트는 "무엇이 선택될지" 힌트일 뿐, 선택 마킹이 아니다).
  expect(await page.locator(".hw-anchor").count()).toBe(0);
});

test("커서 상태: 본문 문단 위 호버 = text I-beam (data-hover-cursor=text)", async ({ page }) => {
  await open(page);
  const canvas = page.locator(".hw-canvas");
  // 본문 문단(.hw-hover-paragraph)이 뜨고 그때 호스트가 text 커서를 켜는 페이지를 앞에서부터 찾는다(표만 있는
  // 페이지는 건너뛰고 본문 문단이 있는 페이지에서 성립 — 페이지 순회로 픽스처 레이아웃에 견고).
  let found: { x: number; y: number } | null = null;
  for (let dp = 0; dp < 8 && !found; dp++) {
    found = await scanHoverOnPage(page, dp, async () => {
      if ((await page.locator(".hw-hover.hw-hover-paragraph").count()) === 0) return false;
      return (await canvas.getAttribute("data-hover-cursor")) === "text";
    });
  }
  expect(found, "본문 문단 위 호버 시 text I-beam 커서가 켜져야 한다").toBeTruthy();
  await expect(canvas).toHaveAttribute("data-hover-cursor", "text");
});
