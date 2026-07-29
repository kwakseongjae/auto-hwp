import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { placeCellCaret } from "./cell-gesture";

// 이슈 052 자동저장+세션 복구 e2e: 편집 → (2s 유휴) 자동저장 → 강제 reload → 복구 배너 →
// 복구 → 편집 내용 유지. 무시(=스냅샷 삭제) 분기도 잠근다. 실브라우저 IndexedDB 경유 —
// IdbSnapshotStore 실구현은 이 스펙이 검증한다(단위 테스트는 MemorySnapshotStore mock).
const BENCHMARK = path.resolve(process.cwd(), "..", "..", "benchmarks", "benchmark.hwp");

async function open(page: Page) {
  await page.goto("/");
  await page.locator('[data-testid="file-input"]').setInputFiles(BENCHMARK);
  await expect(page.locator(".hw-sheet svg").first()).toBeVisible({ timeout: 60_000 });
}

// 엔진 캐럿 paste로 고유 마커를 한 op로 심고 자동저장을 기다린다.
async function editCellAndAutosave(page: Page, marker: string) {
  await placeCellCaret(page);
  await page.evaluate((text) => {
    const clipboard = new DataTransfer();
    clipboard.setData("text/plain", text);
    window.dispatchEvent(new ClipboardEvent("paste", { clipboardData: clipboard, bubbles: true, cancelable: true }));
  }, marker);
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
