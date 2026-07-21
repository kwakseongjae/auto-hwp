import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

// 이슈 052 자동저장+세션 복구 e2e: 편집 → (2s 유휴) 자동저장 → 강제 reload → 복구 배너 →
// 복구 → 편집 내용 유지. 무시(=스냅샷 삭제) 분기도 잠근다. 실브라우저 IndexedDB 경유 —
// IdbSnapshotStore 실구현은 이 스펙이 검증한다(단위 테스트는 MemorySnapshotStore mock).
const BENCHMARK = path.resolve(process.cwd(), "..", "..", "benchmarks", "benchmark.hwp");

async function open(page: Page) {
  await page.goto("/");
  await page.locator('[data-testid="file-input"]').setInputFiles(BENCHMARK);
  await expect(page.locator(".hw-sheet svg").first()).toBeVisible({ timeout: 60_000 });
}

// 표 셀 앵커("N행 M열" 라벨)가 뜨는 지점을 찾는다. 드릴 모델(QA2 #4, 59fef4f) 정렬: 단일클릭 =
// 부모 표 마킹 → 같은 지점 더블클릭 = 셀 드릴(069). 표 마킹과 함께 뜨는 행/열 그립(031)이 시트
// 클릭을 가로채 액셔너빌리티 대기에 걸리는 것을 피해 절대좌표 page.mouse 로 클릭한다.
async function scanForCell(page: Page): Promise<{ x: number; y: number } | null> {
  const sheet = page.locator('.hw-sheet[data-page="0"]');
  const box = await sheet.boundingBox();
  if (!box) throw new Error("첫 페이지 시트 박스를 찾지 못함");
  const anchor = page.locator(".hw-anchor");
  const label = async () => ((await anchor.count()) > 0 ? (await anchor.first().innerText()).trim() : "");
  for (let ry = 0.1; ry <= 0.9; ry += 0.04) {
    for (let rx = 0.1; rx <= 0.9; rx += 0.06) {
      const x = box.x + box.width * rx;
      const y = box.y + box.height * ry;
      await page.mouse.click(x, y);
      const l = await label();
      if (l.includes("행")) return { x, y };
      if (!l.includes("표")) continue;
      await page.waitForTimeout(500); // 앱 더블클릭 감지 윈도 밖으로
      await page.mouse.click(x, y);
      await page.mouse.click(x, y); // 빠른 두 번 = 셀 드릴
      if ((await label()).includes("행")) return { x, y };
    }
  }
  return null;
}

// 셀 텍스트를 편집해 문서에 고유 마커를 심는다(027 텍스트 수정 경로 재사용) → 자동저장을 기다린다.
async function editCellAndAutosave(page: Page, marker: string) {
  const found = await scanForCell(page);
  expect(found, "표 셀을 클릭해 셀 앵커가 떠야 한다").toBeTruthy();
  const markBox = await page.locator(".hw-mark-cell").first().boundingBox();
  if (!markBox) throw new Error("셀 마킹 박스를 찾지 못함");
  const cx = markBox.x + markBox.width / 2;
  const cy = markBox.y + markBox.height / 2;
  await page.mouse.click(cx, cy);
  await page.mouse.click(cx, cy); // 더블클릭 감지(포인터 캡처로 DOM dblclick 억제됨)
  const ta = page.locator('[data-testid="hw-inplace-editor"]');
  await expect(ta).toBeVisible({ timeout: 15_000 });
  await ta.fill(marker);
  await ta.press("Enter");
  await expect(page.locator(".hw-pages")).toContainText(marker, { timeout: 30_000 });
  // 2s 유휴 디바운스 → toHwpx → IndexedDB put 성공의 화면 신호(자동저장 배지).
  await expect(page.locator('[data-testid="autosave-status"]')).toBeVisible({ timeout: 30_000 });
}

test("편집 → 자동저장 → 강제 reload → 복구 배너 → 복구 → 편집 내용 유지", async ({ page }) => {
  await open(page);
  const marker = "복구확인052";
  await editCellAndAutosave(page, marker);

  // 강제 reload = 탭 종료/트랩 후 재방문 시나리오. 문서 상태는 통째로 날아간다.
  await page.reload();

  // 열기 화면에 복구 배너: 파일명 + "편집된 HWPX본" 명시(원본 .hwp와 혼동 금지).
  const banner = page.locator('[data-testid="recovery-banner"]');
  await expect(banner).toBeVisible({ timeout: 30_000 });
  await expect(banner).toContainText("benchmark.hwp");
  await expect(banner).toContainText("HWPX본");

  // 복구 → 복구본이 열리고 편집 내용이 살아 있다.
  await page.locator('[data-testid="recovery-restore"]').click();
  await expect(page.locator(".hw-sheet svg").first()).toBeVisible({ timeout: 60_000 });
  await expect(page.locator(".hw-pages")).toContainText(marker, { timeout: 30_000 });
});

test("무시 = 스냅샷 삭제: 배너가 내려가고 재방문에도 다시 뜨지 않는다", async ({ page }) => {
  await open(page);
  await editCellAndAutosave(page, "무시확인052");

  await page.reload();
  const banner = page.locator('[data-testid="recovery-banner"]');
  await expect(banner).toBeVisible({ timeout: 30_000 });
  await page.locator('[data-testid="recovery-dismiss"]').click();
  await expect(banner).toHaveCount(0, { timeout: 15_000 });

  // 스냅샷이 지워졌으므로 재방문에도 배너가 없다.
  await page.reload();
  await expect(page.locator(".lab-empty")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-testid="recovery-banner"]')).toHaveCount(0);
});
