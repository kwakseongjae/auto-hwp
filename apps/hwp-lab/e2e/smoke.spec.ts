import path from "node:path";
import { expect, test } from "@playwright/test";
import { selectFirstCell, showVibePanel } from "./cell-gesture";

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

  // 셀 단위 마킹(06x Figma 드릴): 단일 클릭은 이제 표 '전체'를 마킹한다. 셀을 앵커로 만들려면 그 지점을
  // 더블클릭해 셀로 드릴 인해야 한다("N행 M열" 라벨). 헤드리스에서 정확한 셀 좌표를 몰라도, 표 위 지점을
  // 단일 클릭으로 찾고(.hw-mark-table) → Escape 로 드릴 초기화 → raw 좌표 더블클릭(행 그립 가로채기 우회)
  // 으로 그 셀을 드릴한다. 선택 모델(021): 클릭 = 교체 → 선택은 하나로 갈아끼워진다.
  const anchor = page.locator(".hw-anchor");
  const pages = page.locator(".hw-pages");
  await selectFirstCell(page);
  const cellLabel = (await anchor.first().innerText()).trim();
  // 표 안 클릭이 셀 앵커("N행 M열")를 만들어야 한다(데스크톱 패리티 — 이 이슈의 본체).
  expect(cellLabel, '표 안 클릭 → 셀 앵커(라벨에 "행" 포함)가 떠야 한다').toBeTruthy();
  // 교체 모델 검증: 여러 번 클릭했어도 선택은 정확히 하나여야 한다(누적 금지).
  expect(await anchor.count()).toBe(1);
  await showVibePanel(page);

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

// issue 022 + inspector 모드: 열기 직후 기본 폰트(NanumGothic)가 자동 등록되어 화면 @font-face 가
// 주입되고 PDF 버튼이 즉시 활성화된다. 전역 FontPicker는 선택 디자인과 혼동되지 않도록 노출하지 않는다.
test("기본 폰트 자동 적용 → 전역 FontPicker 없음 + @font-face 주입 + PDF 다운로드", async ({ page }) => {
  await page.goto("/");
  await page.locator('[data-testid="file-input"]').setInputFiles(BENCHMARK);
  await expect(page.locator(".hw-sheet svg").first()).toBeVisible({ timeout: 60_000 });

  // inspector 모드에서는 전역 글꼴 UI를 숨긴다. 선택한 요소의 글꼴은 디자인 패널에서 다룬다.
  await expect(page.locator('[data-testid="font-picker"]')).toHaveCount(0);

  // 화면 @font-face/별칭 스타일이 주입되어 있다(화면·PDF 폰트 일치의 근거).
  const fontFace = page.locator('style[data-testid="hw-fontface"]');
  await expect(fontFace).toHaveCount(1);
  expect(await fontFace.textContent()).toContain("Nanum Gothic");

  // PDF 버튼 활성 + 클릭 시 **미리보기 모달**(이슈 6) → 그 안의 "다운로드"가 실제 파일을 준다.
  // (기본 폰트가 등록되어 font_missing 없이 성공한다.)
  const pdfBtn = page.locator('.hw-tool[title="PDF 다운로드"]');
  await expect(pdfBtn).toBeEnabled();
  await pdfBtn.click();
  const preview = page.getByTestId("pdf-preview");
  await expect(preview).toBeVisible({ timeout: 90_000 });
  // 미리보기 프레임이 생성된 blob 을 가리킨다(브라우저 PDF 뷰어가 그린다).
  await expect(page.getByTestId("pdf-preview-frame")).toHaveAttribute("src", /^blob:/);
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 90_000 }),
    page.getByTestId("pdf-preview-download").click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/\.pdf$/i);
  // 닫기 → 모달이 사라진다.
  await page.getByTestId("pdf-preview-close").click();
  await expect(preview).toHaveCount(0);
});
