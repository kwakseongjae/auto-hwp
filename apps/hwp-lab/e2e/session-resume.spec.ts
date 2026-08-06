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

  // 토스트는 "언제까지의 편집이 살아 있는지"를 시각으로 말한다(pagehide flush 는 보장이 아니므로).
  // ⚠️ 이제 **자동 소멸하는 플로팅 토스트**라 먼저 확인한다(전폭 배너였을 때는 레이아웃을 밀어냈다).
  const toast = page.locator('[data-testid="resume-toast"]');
  await expect(toast).toBeVisible({ timeout: 30_000 });
  await expect(toast).toContainText("새로고침 전 상태로 복구했습니다");
  await expect(toast).toContainText(/마지막 자동저장 \d{1,2}:\d{2}/);

  await expect(page.locator(".hw-pages")).toContainText(marker, { timeout: 30_000 });

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

  // 새 탭 재방문 = 마커 없음 + **홈 주소로 진입**. (문서 주소 `/d/<키>` 를 그대로 새로고침하면 그건
  // "이 문서를 다시 열어라"는 명시적 요청이라 재개가 맞다 — doc-url.spec.ts 가 그쪽을 잠근다.)
  await page.evaluate((k) => sessionStorage.removeItem(k), MARKER);
  await page.goto("/");

  await expect(page.locator('[data-testid="recovery-banner"]')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-testid="resume-toast"]')).toHaveCount(0);
  await expect(page.locator(".hw-sheet svg")).toHaveCount(0);
});

// ── U2: 편집 전 새로고침도 재개 + "처음부터" 초기화 ─────────────────────────────────────────────
test("샘플을 열고 아무것도 고치지 않은 채 새로고침해도 그 문서로 돌아온다 (열기 직후 시드 스냅샷)", async ({ page }) => {
  await openSample(page);
  expect(await liveMarker(page)).toContain(SAMPLE);

  // 편집 0회. 이전에는 마커만 있고 스냅샷이 없어 랜딩(=문서가 사라진 것처럼 보임)으로 떨어졌다.
  await page.reload();

  await expect(page.locator(".hw-sheet svg").first()).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('[data-testid="recovery-banner"]')).toHaveCount(0);

  // 토스트는 정직하게 "편집한 내용은 없다"고 말한다 — 복구할 편집이 애초에 없었으므로.
  const toast = page.locator('[data-testid="resume-toast"]');
  await expect(toast).toBeVisible({ timeout: 30_000 });
  await expect(toast).toContainText("아직 편집한 내용은 없습니다");
  // 사용자가 할 일이 없는 알림이므로 스스로 사라진다(레이아웃을 밀어내는 전폭 배너였던 것을 교정).
  await expect(toast).toHaveCount(0, { timeout: 30_000 });

  // 시드는 자동 재개 전용이다: 새 탭(마커 없음 + 홈 진입)에서는 "편집본이 있습니다" 배너를 띄우지 않는다.
  await page.evaluate((k) => sessionStorage.removeItem(k), MARKER);
  await page.goto("/");
  await expect(page.locator(".lab-empty")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-testid="recovery-banner"]')).toHaveCount(0);
});

test("처음부터 → 확인 후 스냅샷까지 정리하고 랜딩 복귀 (재개도 배너도 없음)", async ({ page }) => {
  await openSample(page);
  await editCellAndAutosave(page, "초기화확인081");

  // 확인 1회 — 사용자 콘텐츠를 지우므로 조용히 실행하지 않는다.
  page.once("dialog", (d) => void d.accept());
  await page.locator('[data-testid="doc-reset"]').click();

  await expect(page.locator(".lab-empty")).toBeVisible({ timeout: 30_000 });
  expect(await liveMarker(page)).toBeNull();
  await expect(page.locator('[data-testid="recovery-banner"]')).toHaveCount(0);

  // 새로고침해도 되살아나지 않는다(스냅샷 자체가 없다).
  await page.reload();
  await expect(page.locator(".lab-empty")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".hw-sheet svg")).toHaveCount(0);
  await expect(page.locator('[data-testid="recovery-banner"]')).toHaveCount(0);
});

test("처음부터 취소 → 아무것도 지우지 않는다", async ({ page }) => {
  await openSample(page);
  await editCellAndAutosave(page, "취소확인081");

  page.once("dialog", (d) => void d.dismiss());
  await page.locator('[data-testid="doc-reset"]').click();

  // 문서도 마커도 그대로.
  await expect(page.locator(".hw-sheet svg").first()).toBeVisible();
  expect(await liveMarker(page)).toContain(SAMPLE);
  await expect(page.locator(".hw-pages")).toContainText("취소확인081");
});
