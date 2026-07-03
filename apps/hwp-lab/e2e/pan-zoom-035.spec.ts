import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

// 이슈 035 팬/줌 e2e: ⌘/Ctrl+휠 = 커서 중심 줌(커서 아래 문서 지점 고정 ±2px) · Space+드래그 = 팬(scroll 변화).
// 데모 픽스처는 benchmark.hwp(8쪽). 좁은 뷰포트로 가로 스크롤까지 활성화해 두 축을 함께 검증한다.
const BENCHMARK = path.resolve(process.cwd(), "..", "..", "benchmarks", "benchmark.hwp");

async function open(page: Page) {
  await page.goto("/");
  await page.locator('[data-testid="file-input"]').setInputFiles(BENCHMARK);
  await expect(page.locator(".hw-sheet svg").first()).toBeVisible({ timeout: 60_000 });
}

// ⌘/Ctrl+휠을 헤드리스에서 결정적으로 재현: 커서 지점의 요소에 ctrlKey 휠 이벤트를 직접 디스패치한다
// (bubbles → .hw-canvas 리스너 도달). Playwright 의 mouse.wheel 은 modifier 를 싣기 애매하므로 합성한다.
async function ctrlWheelAt(page: Page, x: number, y: number, deltaY: number) {
  await page.evaluate(
    ({ x, y, deltaY }) => {
      const el = document.elementFromPoint(x, y) ?? document.body;
      el.dispatchEvent(new WheelEvent("wheel", { clientX: x, clientY: y, deltaY, ctrlKey: true, bubbles: true, cancelable: true }));
    },
    { x, y, deltaY },
  );
}

test("⌘/Ctrl+휠 줌: 커서 아래 문서 지점이 고정된다 (커서 중심 줌, ±2px)", async ({ page }) => {
  // 좁은 뷰포트 → A4 시트가 캔버스보다 넓어 가로 스크롤도 활성(두 축 모두 고정점 검증 가능).
  await page.setViewportSize({ width: 820, height: 720 });
  await open(page);
  const readout = page.locator(".hw-zoom");
  const zoomBefore = (await readout.innerText()).trim(); // "90%"

  const sheet = page.locator('.hw-sheet[data-page="0"]');
  const b0 = await sheet.boundingBox();
  if (!b0) throw new Error("첫 페이지 시트 박스를 찾지 못함");
  // 커서 P = 페이지 0 내부의 한 지점(상단 가장자리 회피 → 클램프 없이 두 축 모두 양(+) 스크롤로 이동).
  const P = { x: b0.x + b0.width * 0.5, y: b0.y + b0.height * 0.4 };
  // P 가 가리키는 문서 지점을 "시트 내 비율"로 고정(시트가 균일 스케일되므로 이 비율은 줌 불변).
  const fracX = (P.x - b0.x) / b0.width;
  const fracY = (P.y - b0.y) / b0.height;

  // 커서 P 에서 확대(⌘휠 up = deltaY<0). 한 번의 제스처 → 150ms 디바운스 후 실 스케일 커밋.
  await ctrlWheelAt(page, P.x, P.y, -260);
  await expect(readout).not.toHaveText(zoomBefore, { timeout: 15_000 }); // 실 줌 커밋 완료

  const b1 = await sheet.boundingBox();
  if (!b1) throw new Error("줌 후 시트 박스를 찾지 못함");
  // 실제로 확대됐는지(시트 폭 성장) — 무변화면 고정점 검증이 무의미하다.
  expect(b1.width).toBeGreaterThan(b0.width + 10);
  // ★ 고정점 assert: 같은 문서 지점(시트 내 fracX/fracY)의 줌 후 화면 좌표가 커서 P 에서 ±2px 이내.
  const docScreenX = b1.x + fracX * b1.width;
  const docScreenY = b1.y + fracY * b1.height;
  expect(Math.abs(docScreenX - P.x), "커서 아래 문서 지점 X 고정(±2px)").toBeLessThanOrEqual(2);
  expect(Math.abs(docScreenY - P.y), "커서 아래 문서 지점 Y 고정(±2px)").toBeLessThanOrEqual(2);
});

test("⌘/Ctrl+휠 줌: 25%~400% 로 클램프된다", async ({ page }) => {
  await open(page);
  const readout = page.locator(".hw-zoom");
  const box = await page.locator(".hw-canvas").boundingBox();
  if (!box) throw new Error("캔버스 박스를 찾지 못함");
  const P = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  // 강하게 여러 번 확대 → 400% 에서 멈춘다.
  for (let i = 0; i < 12; i++) await ctrlWheelAt(page, P.x, P.y, -600);
  await expect.poll(async () => parseInt((await readout.innerText()).replace("%", ""), 10), { timeout: 15_000 }).toBe(400);
  // 강하게 여러 번 축소 → 25% 에서 멈춘다.
  for (let i = 0; i < 20; i++) await ctrlWheelAt(page, P.x, P.y, 600);
  await expect.poll(async () => parseInt((await readout.innerText()).replace("%", ""), 10), { timeout: 15_000 }).toBe(25);
});

test("Space+드래그 팬: grab 커서 + scroll 이 변한다 (선택/마퀴 없음)", async ({ page }) => {
  await open(page);
  const canvas = page.locator(".hw-canvas");
  const box = await canvas.boundingBox();
  if (!box) throw new Error("캔버스 박스를 찾지 못함");
  // 포커스를 텍스트 입력 밖으로: 캔버스 여백(회색)을 클릭 → 포커스 body, 선택 해제.
  await page.mouse.click(box.x + 4, box.y + 4);

  // Space 홀드 → 팬 모드(grab 커서 클래스).
  await page.keyboard.down("Space");
  await expect(canvas).toHaveClass(/hw-pan/, { timeout: 15_000 });

  const scrollTopBefore = await canvas.evaluate((el) => el.scrollTop);
  // 캔버스 위에서 위로 드래그(dy<0) → 콘텐츠가 손가락을 따라 위로 → scrollTop 증가.
  const start = { x: box.x + box.width / 2, y: box.y + box.height * 0.7 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x, start.y - 220, { steps: 10 });
  await page.mouse.up();
  await page.keyboard.up("Space");

  const scrollTopAfter = await canvas.evaluate((el) => el.scrollTop);
  expect(scrollTopAfter, "위로 드래그 → scrollTop 증가(팬)").toBeGreaterThan(scrollTopBefore + 40);
  // 팬은 선택을 만들지 않는다(마퀴/셀 선택 억제) — 앵커 칩 0.
  expect(await page.locator(".hw-anchor").count()).toBe(0);
  // Space 해제 후 grab 커서도 해제.
  await expect(canvas).not.toHaveClass(/hw-pan/, { timeout: 15_000 });
});
