import { expect, test } from "@playwright/test";

// 073 2단계 e2e — 벌크 생성 워커화 + 검수 SVG lazy 생성.
// 잠그는 것: ① 배치가 도는 동안 진행률(bulk-progress)이 실제로 갱신된다(메인스레드가 살아 있다는 증거 —
// 워커가 아니면 이 갱신이 행 단위로 뭉개진다) ② 검수 프리뷰는 캐러셀에 들어온 부만 렌더되고, 다음 부로
// 넘기면 그 부가 새로 렌더된다(N장 SVG 상주 없음) ③ 기존 계약(검증·zip)은 그대로.
// 명단은 데모 규격(기업명/사업자등록번호/대표자/연락처)에 맞춰 형식 검증을 통과하는 값으로 만든다.
const N = 60;
const roster = Array.from({ length: N }, (_, i) => {
  const n = i + 1;
  const p = String(n).padStart(3, "0");
  return [`기업명: 테스트기업${p}`, `사업자등록번호: ${100 + (n % 900)}-81-${String(10000 + n)}`, `대표자: 대표${p}`, `연락처: 010-${String(1000 + n)}-${String(2000 + n)}`].join("\n");
}).join("\n\n");

test("073: 워커 경유 배치 — 진행률 갱신 + 검수 프리뷰 lazy 렌더", async ({ page }) => {
  await page.goto("/bulk");
  await page.locator('[data-testid="bulk-sample"]').click();
  await expect(page.locator('[data-testid="bulk-studio"]')).toBeVisible({ timeout: 60_000 });
  await page.locator('[data-testid="bulk-roster"]').fill(roster);
  // 데모 규격 그대로라 미매칭 0 — 진단 배너가 뜨면 명단/규격이 어긋난 것이다.
  await expect(page.locator('[data-testid="bulk-keys"] .bulk-keychip.miss')).toHaveCount(0);

  await page.locator('[data-testid="bulk-generate"]').click();
  // 배치가 도는 동안 진행률이 보이고 실제로 숫자가 올라간다(생성 중에도 화면이 살아 있다).
  const progress = page.locator('[data-testid="bulk-progress"]');
  await expect(progress).toBeVisible({ timeout: 30_000 });
  await expect(progress).toContainText(`/ ${N}부`);

  await expect(page.locator('[data-testid="bulk-idx"]')).toContainText(`1 / ${N}`, { timeout: 180_000 });
  await expect(progress).toHaveCount(0); // 끝나면 사라진다
  await expect(page.locator('[data-testid="bulk-values"]')).toContainText("테스트기업001");

  // 검수 프리뷰는 캐러셀 진입 시 lazy 생성 — 첫 부가 렌더될 때까지 기다린다.
  const pageSvg = page.locator(".bulk-review .bulk-page svg");
  await expect(pageSvg.first()).toBeVisible({ timeout: 60_000 });
  await expect(page.locator(".bulk-review .bulk-hl").first()).toBeVisible();

  // 다음 부로 넘기면 그 부가 새로 렌더된다(N장 상주가 아니라 보고 있는 부만).
  await page.getByText("다음 ›").click();
  await expect(page.locator('[data-testid="bulk-idx"]')).toContainText(`2 / ${N}`);
  await expect(page.locator('[data-testid="bulk-values"]')).toContainText("테스트기업002");
  await expect(pageSvg.first()).toBeVisible({ timeout: 60_000 });

  // 계약 유지: 전부 생성 + zip 다운로드
  const zipDl = page.waitForEvent("download");
  await page.locator('[data-testid="bulk-zip"]').click();
  expect((await zipDl).suggestedFilename()).toBe("벌크채움_결과.zip");
  await expect(page.locator('[data-testid="bulk-zip"]')).toContainText(`${N}부`);
});
