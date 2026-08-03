import { expect, test, type Page } from "@playwright/test";
import { placeCellCaret } from "./cell-gesture";

// 새로고침 자동 재개(052 자동저장 위의 재개 규칙 레이어) e2e.
//
// 잠그는 계약:
//  ① 같은 탭 새로고침 → **배너 없이** 에디터 복귀 + 편집 내용 존재 + 재개 토스트(자동저장 시각).
//  ② 명시적 닫기 → 마커 제거 → 새로고침해도 자동 재개 없음(랜딩). 스냅샷은 남으므로 배너로 제안된다.
//  ③ 고아 스냅샷(마커만 삭제) → 자동 재개 없이 현행 배너 — 052 동작 무변경.
//
// 샘플 문서로 돈다(랜딩 원클릭 — 업로드 파일과 동일 경로: openBytes → 자동저장 세션).
const SAMPLE = "sample-8p.hwp";
const MARKER = "auto-hwp:live-doc";

async function openSample(page: Page) {
  await page.goto("/");
  await page.locator(`[data-testid="sample-${SAMPLE}"]`).click();
  await expect(page.locator(".hw-sheet svg").first()).toBeVisible({ timeout: 60_000 });
}

/** 엔진 캐럿 paste 로 고유 마커를 한 op 로 심고 자동저장(배지)을 기다린다. */
async function editCellAndAutosave(page: Page, marker: string) {
  await placeCellCaret(page);
  await page.evaluate((text) => {
    const clipboard = new DataTransfer();
    clipboard.setData("text/plain", text);
    window.dispatchEvent(new ClipboardEvent("paste", { clipboardData: clipboard, bubbles: true, cancelable: true }));
  }, marker);
  await expect(page.locator(".hw-pages")).toContainText(marker, { timeout: 30_000 });
  await expect(page.locator('[data-testid="autosave-status"]')).toBeVisible({ timeout: 30_000 });
}

const liveMarker = (page: Page) => page.evaluate((k) => sessionStorage.getItem(k), MARKER);

test("새로고침 → 배너 없이 자동 재개 + 편집 내용 유지 + 자동저장 시각 토스트", async ({ page }) => {
  await openSample(page);
  expect(await liveMarker(page)).toContain(SAMPLE); // 열기 성공 = 마커 세팅

  const marker = "재개확인081";
  await editCellAndAutosave(page, marker);

  await page.reload();

  // 배너를 거치지 않고 에디터가 곧바로 돌아온다.
  await expect(page.locator(".hw-sheet svg").first()).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('[data-testid="recovery-banner"]')).toHaveCount(0);
  await expect(page.locator(".hw-pages")).toContainText(marker, { timeout: 30_000 });

  // 토스트는 "언제까지의 편집이 살아 있는지"를 시각으로 말한다(pagehide flush 는 보장이 아니므로).
  const toast = page.locator('[data-testid="resume-toast"]');
  await expect(toast).toBeVisible({ timeout: 30_000 });
  await expect(toast).toContainText("새로고침 전 상태로 복구했습니다");
  await expect(toast).toContainText(/마지막 자동저장 \d{1,2}:\d{2}/);

  // 재개 후에도 마커는 살아 있다(새 세션 키로 갱신) — 연속 새로고침도 재개된다.
  expect(await liveMarker(page)).not.toBeNull();
  await page.reload();
  await expect(page.locator(".hw-pages")).toContainText(marker, { timeout: 60_000 });
  await expect(page.locator('[data-testid="recovery-banner"]')).toHaveCount(0);
});

test("명시적 닫기 → 자동 재개 없음(랜딩) · 편집본은 배너로 남는다", async ({ page }) => {
  await openSample(page);
  await editCellAndAutosave(page, "닫기확인081");

  await page.locator('[data-testid="doc-close"]').click();
  await expect(page.locator(".lab-empty")).toBeVisible({ timeout: 30_000 });
  expect(await liveMarker(page)).toBeNull(); // 마커 제거 = 재개 안 함

  // 닫기가 세션을 망가뜨리지 않는다: 같은 페이지 수명에서 다시 열 수 있고 마커도 다시 세팅된다.
  await page.locator(`[data-testid="sample-${SAMPLE}"]`).click();
  await expect(page.locator(".hw-sheet svg").first()).toBeVisible({ timeout: 60_000 });
  expect(await liveMarker(page)).toContain(SAMPLE);
  await page.locator('[data-testid="doc-close"]').click();
  await expect(page.locator(".lab-empty")).toBeVisible({ timeout: 30_000 });

  await page.reload();
  await expect(page.locator(".lab-empty")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".hw-sheet svg")).toHaveCount(0); // 자동 재개 없음
  // 콘텐츠는 지우지 않았다 — 고아 스냅샷이 되어 현행 배너로 다시 제안된다.
  await expect(page.locator('[data-testid="recovery-banner"]')).toBeVisible({ timeout: 30_000 });
});

test("마커만 없으면(새 탭 재방문) 현행 배너 경로 — 052 동작 무변경", async ({ page }) => {
  await openSample(page);
  await editCellAndAutosave(page, "고아확인081");

  await page.evaluate((k) => sessionStorage.removeItem(k), MARKER);
  await page.reload();

  await expect(page.locator('[data-testid="recovery-banner"]')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-testid="resume-toast"]')).toHaveCount(0);
  await expect(page.locator(".hw-sheet svg")).toHaveCount(0);
});
