import path from "node:path";
import { expect, test } from "@playwright/test";

// 데모 픽스처: 레포 benchmarks/benchmark.hwp(8쪽). test:e2e 는 apps/hwp-lab 에서 실행되므로 cwd 기준
// ../../benchmarks/benchmark.hwp.
const BENCHMARK = path.resolve(process.cwd(), "..", "..", "benchmarks", "benchmark.hwp");

test("업로드 → 8페이지 SVG → 셀 클릭 마킹 → mock 편집이 그 셀을 바꿈 → undo", async ({ page }) => {
  await page.goto("/");

  // 파일 열기 (hidden input) → benchmark.hwp 업로드.
  await page.locator('[data-testid="file-input"]').setInputFiles(BENCHMARK);

  // 8페이지 SVG 렌더 확인(엔진 wasm fetch + 페이지별 SVG는 비동기 → 넉넉한 타임아웃).
  await expect(page.locator(".hw-sheet")).toHaveCount(8, { timeout: 60_000 });
  await expect(page.locator(".hw-sheet svg").first()).toBeVisible({ timeout: 60_000 });
  const svgCount = await page.locator(".hw-sheet svg").count();
  expect(svgCount).toBe(8);

  // 셀 단위 마킹(이슈 023): 표 안을 클릭하면 그 셀이 앵커가 되고 칩 라벨에 "N행 M열"이 들어간다.
  // 헤드리스에서 정확한 셀 좌표를 몰라도, 그리드로 스캔해 셀 앵커("행" 포함)가 뜰 때까지 클릭한다.
  // 선택 모델(021): 클릭 = 교체 → 여러 번 클릭해도 선택은 하나로 갈아끼워진다.
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
  // 표 안 클릭이 셀 앵커("N행 M열")를 만들어야 한다(데스크톱 패리티 — 이 이슈의 본체).
  expect(cellLabel, '표 안 클릭 → 셀 앵커(라벨에 "행" 포함)가 떠야 한다').toBeTruthy();
  // 교체 모델 검증: 여러 번 클릭했어도 선택은 정확히 하나여야 한다(누적 금지).
  expect(await anchor.count()).toBe(1);

  // 편집 전에는 mock 표식("PoC")이 문서에 없다.
  await expect(pages).not.toContainText("PoC");

  // 프롬프트 전송 → mock 제안 카드 → 적용. mock 은 앵커의 rows/cols(클릭한 그 셀)에 "PoC ✔"를 쓴다.
  await page.locator(".hw-textarea").fill("이 칸을 채워줘");
  await page.locator(".hw-btn-send").click();
  await expect(page.locator(".hw-review .hw-btn-primary")).toBeVisible({ timeout: 30_000 });
  await page.locator(".hw-review .hw-btn-primary").click();
  await expect(page.locator(".hw-applied").first()).toBeVisible({ timeout: 30_000 });

  // 클릭한 그 셀이 바뀐다: 편집 후 문서에 "PoC" 가 나타난다(mock 이 그 셀에 써 넣은 텍스트).
  await expect(pages).toContainText("PoC", { timeout: 30_000 });

  // 페이지 수는 편집 후에도 유지되어야 한다.
  await expect(page.locator(".hw-sheet")).toHaveCount(8, { timeout: 30_000 });

  // undo → "PoC" 제거 + 여전히 8페이지(툴바 ↶).
  await page.locator('.hw-tool[title="실행취소"]').click();
  await expect(pages).not.toContainText("PoC", { timeout: 30_000 });
  await expect(page.locator(".hw-sheet")).toHaveCount(8, { timeout: 30_000 });
});

// issue 022: 열기 직후 기본 폰트(NanumGothic)가 자동 등록되어 화면 @font-face 가 주입되고,
// FontPicker 가 현재 글꼴을 표시하며, PDF 버튼이 즉시 활성화되어 실제 PDF 가 내려받아진다.
test("기본 폰트 자동 적용 → FontPicker 표시 + @font-face 주입 + PDF 다운로드", async ({ page }) => {
  await page.goto("/");
  await page.locator('[data-testid="file-input"]').setInputFiles(BENCHMARK);
  await expect(page.locator(".hw-sheet svg").first()).toBeVisible({ timeout: 60_000 });

  // FontPicker 가 보이고 기본 폰트(Nanum Gothic)가 현재 글꼴로 표시된다(자동 registerFont 성공).
  await expect(page.locator('[data-testid="font-picker"]')).toBeVisible();
  await expect(page.locator(".hw-fontpicker-current")).toContainText("Nanum Gothic", { timeout: 30_000 });

  // 화면 @font-face/별칭 스타일이 주입되어 있다(화면·PDF 폰트 일치의 근거).
  await expect(page.locator('style[data-testid="hw-fontface"]')).toHaveCount(1);

  // PDF 버튼 활성 + 클릭 시 실제 다운로드(기본 폰트가 등록되어 font_missing 없이 성공).
  const pdfBtn = page.locator('.hw-tool[title="PDF 다운로드"]');
  await expect(pdfBtn).toBeEnabled();
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 90_000 }),
    pdfBtn.click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.pdf$/i);
});
