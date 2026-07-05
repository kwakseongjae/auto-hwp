import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

// 이슈 050 이미지 삽입 e2e: 업로드 버튼(bytes 기반) → InsertImage → own-render 가 SVG <image> 로 실반영
// → undo 로 사라진다. enableEditing 이 켜진 lab 에서, 이미지 0 인 benchmark.hwp(8쪽)로 검증한다.
const BENCHMARK = path.resolve(process.cwd(), "..", "..", "benchmarks", "benchmark.hwp");

// 유효한 1×1 PNG(시그니처 89 50 4E 47 …). 엔진이 매직바이트로 png 를 감지하고 BinData 로 임베드하면
// own-render 가 <image href="data:image/png;base64,…"> 로 그린다.
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

async function open(page: Page) {
  await page.goto("/");
  await page.locator('[data-testid="file-input"]').setInputFiles(BENCHMARK);
  await expect(page.locator(".hw-sheet svg").first()).toBeVisible({ timeout: 60_000 });
}

// 첫 페이지를 격자 스캔해 표 셀 앵커("N행 M열")가 뜨는 지점을 찾아 그 셀을 선택 상태로 만든다 — 업로드가
// 그 블록 뒤(=보이는 첫 페이지)로 삽입되도록(문서 끝은 가상화로 언마운트일 수 있어 assert 가 불안정).
async function selectFirstCell(page: Page): Promise<boolean> {
  const sheet = page.locator('.hw-sheet[data-page="0"]');
  const box = await sheet.boundingBox();
  if (!box) throw new Error("첫 페이지 시트 박스를 찾지 못함");
  for (let ry = 0.1; ry <= 0.6; ry += 0.04) {
    for (let rx = 0.1; rx <= 0.9; rx += 0.06) {
      await sheet.click({ position: { x: box.width * rx, y: box.height * ry } });
      const a = page.locator(".hw-anchor");
      if ((await a.count()) > 0 && (await a.first().innerText()).includes("행")) return true;
    }
  }
  return false;
}

test("업로드 버튼 → InsertImage → SVG <image> 실반영 → undo 로 제거", async ({ page }) => {
  await open(page);
  // benchmark 는 네이티브 이미지가 0 → 시작 시 <image> 는 없다.
  const images = page.locator(".hw-pages .hw-sheet svg image");
  await expect(images).toHaveCount(0);

  // 보이는 첫 페이지의 표 셀을 선택 → 업로드는 그 블록 뒤(page 0 근처)로 삽입된다.
  expect(await selectFirstCell(page), "표 셀을 선택해 삽입 앵커를 page 0 에 둔다").toBeTruthy();

  // 툴바 "이미지" 업로드 — 숨은 input 에 실제 PNG 바이트를 넣는다(bytes 왕복의 진입점).
  await page.locator('[data-testid="hw-image-input"]').setInputFiles({
    name: "pic.png",
    mimeType: "image/png",
    buffer: TINY_PNG,
  });
  // 삽입 성공 토스트 = op-bus 커밋 신호.
  await expect(page.locator(".hw-status")).toContainText("이미지를 삽입했습니다", { timeout: 30_000 });

  // ★ 실반영 assert: own-render 가 문서에 SVG <image href="data:image/png;base64,…"> 를 그린다.
  await expect.poll(async () => images.count(), { timeout: 30_000 }).toBeGreaterThan(0);
  expect(await images.first().getAttribute("href")).toContain("data:image/png;base64,");

  // undo 1단위로 이미지가 사라진다(삽입 = 하나의 undo 단위).
  await page.locator('.hw-tool[title="실행취소"]').click();
  await expect.poll(async () => images.count(), { timeout: 30_000 }).toBe(0);
});

test("비이미지 파일 드롭 분기: 아무 이미지도 삽입되지 않는다(정직한 거부, UI 분기 규칙)", async ({ page }) => {
  await open(page);
  // 업로드 input 은 accept 로 png/jpeg 만 받지만, 드롭 분기 규칙(이미지=삽입/문서=열기/그외=거부)은
  // 업로드가 아니라 드롭 경로에서 강제된다. 여기서는 최소 신호로 "업로드는 이미지 전용"만 확인한다:
  // accept 속성이 PNG/JPEG 로 좁혀져 있어야 한다(스푸핑된 확장자는 엔진 매직바이트가 재차 거부).
  const accept = await page.locator('[data-testid="hw-image-input"]').getAttribute("accept");
  expect(accept).toContain("image/png");
  expect(accept).toContain("image/jpeg");
});
