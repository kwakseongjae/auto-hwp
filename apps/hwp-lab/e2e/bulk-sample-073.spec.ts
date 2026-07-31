import { expect, test } from "@playwright/test";

// 073 후속 e2e: 파일 없는 방문자 진입로("샘플로 체험")와 명단 키 매칭 진단.
// 샘플 양식(public/samples — copy-samples.mjs가 배치)을 원클릭으로 열어 데모 규격+명단 3명까지
// 자동으로 채워지는지, 그리고 헤더 오타가 "조용한 빈칸" 대신 칩(✓/✕)으로 즉시 드러나는지 잠근다.
// 생성은 돌리지 않는다(플로우 전체는 bulk-fill-073.spec.ts가 잠근다).
//
// 퍼널 재설계 정렬(2026-07-31): 샘플은 ①→②→③을 **순서대로 밟아 보여준 뒤 ③에서 멈춘다**
// (생성은 사용자가 직접 누르게). 그래서 착지 화면은 ③ 명단이고, ②의 스튜디오는 스테퍼 칩
// (bulk-step-2)으로 되돌아가 확인한다 — 이후 단계 상태(명단)는 보존된다.
test("073: 샘플로 체험 원클릭 → 데모 규격·명단 프리필 + 키 매칭 진단", async ({ page }) => {
  await page.goto("/bulk");
  await page.locator('[data-testid="bulk-sample"]').click();

  // 같은 결정론 인스펙션 경로 → ③ 명단(“키: 값” 블록 3명) 착지
  const roster = page.locator('[data-testid="bulk-roster"]');
  await expect(roster).toHaveValue(/기업명: /, { timeout: 60_000 });
  await expect(page.locator('[data-testid="bulk-roster-preview"]')).toContainText("3명");
  await expect(page.locator('[data-testid="bulk-step-3"]')).toHaveAttribute("aria-current", "step");

  // 데모는 자기 진단에 걸리지 않는다 — 전 영역이 명단 열과 매칭(✓)
  const keys = page.locator('[data-testid="bulk-keys"]');
  await expect(keys.locator(".bulk-keychip.ok").first()).toBeVisible();
  await expect(keys.locator(".bulk-keychip.miss")).toHaveCount(0);
  await expect(keys.locator(".bulk-keychip.extra")).toHaveCount(0);

  // 헤더 오타 한 글자 → 양방향(명단 열 ✕ · 영역 ✕)으로 생성 전에 드러난다
  await roster.fill((await roster.inputValue()).replace(/^기업명:/gm, "기업멍:"));
  await expect(keys.locator(".bulk-keychip.extra")).toContainText("기업멍");
  await expect(keys.locator(".bulk-keychip.miss")).toContainText("기업명");

  // ② 칩으로 복귀 = 샘플이 지나온 스튜디오(유도 필드 카드 + 문서 렌더)를 그대로 확인할 수 있다
  await page.locator('[data-testid="bulk-step-2"]').click();
  await expect(page.locator('[data-testid="bulk-studio"]')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('[data-testid="bulk-field-card"]').first()).toBeVisible();
});
