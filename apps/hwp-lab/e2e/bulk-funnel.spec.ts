import path from "node:path";
import { expect, test } from "@playwright/test";

// /bulk UX 재설계 e2e — **5단계 퍼널**(① 양식 → ② 채울 칸 → ③ 명단 → ④ 생성·검수 → ⑤ 내려받기).
// 잠그는 것:
//  ① 한 번에 한 단계만 펼쳐진다(지나온 단계는 스테퍼의 요약 칩으로 접힌다) + 칩 클릭 복귀 시
//     이후 단계 상태가 살아 있다.
//  ② ③의 이중 경로: 기본(붙여넣기)은 미리보기 표로 즉시 되비추고, 보조(AI 미니 위저드 3단계)는
//     ⑶ "결과 붙여넣기"에서 **기본 경로로 합류**한다(형식이 깨지면 정직하게 거부).
//  ③ ④→⑤ 단방향: 생성 → 자동 검수 캐러셀 + 상시 zip CTA → zip 클릭이 ⑤(리포트 설명)로 넘긴다.
const BENCHMARK = path.resolve(process.cwd(), "..", "..", "benchmarks", "benchmark.hwp");

test("퍼널: ①양식→②채울 칸→③명단→④생성·검수→⑤zip + AI 미니 위저드 합류", async ({ page }) => {
  await page.goto("/bulk");

  // ① 양식 — 스테퍼는 처음부터 5단계 지도를 보여주고, 아직 못 가는 단계는 잠겨 있다
  await expect(page.locator('[data-testid="bulk-stepper"] button')).toHaveCount(5);
  await expect(page.locator('[data-testid="bulk-step-1"]')).toHaveAttribute("aria-current", "step");
  await expect(page.locator('[data-testid="bulk-step-3"]')).toBeDisabled();
  await page.locator('[data-testid="bulk-template"]').setInputFiles(BENCHMARK);

  // ② 채울 칸 — 업로드가 끝나면 자동 전이. ①은 파일명 요약으로 접히고 드롭존은 화면에서 빠진다.
  await expect(page.locator('[data-testid="bulk-studio"]')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('[data-testid="bulk-step-1"]')).toContainText("benchmark.hwp");
  await expect(page.locator('[data-testid="bulk-step-2"]')).toHaveAttribute("aria-current", "step");
  await expect(page.locator('[data-testid="bulk-dropzone"]')).toHaveCount(0);
  const key = await page.locator('[data-testid="bulk-field-card"]').first().locator(".key").inputValue();
  expect(key.length).toBeGreaterThan(0);
  await expect(page.locator('[data-testid="bulk-step-2"]')).toContainText("필드");
  await page.locator('[data-testid="bulk-next"]').click();

  // ③ 명단(기본 경로) — 스튜디오는 접히고, 붙여넣은 명단이 미리보기 표로 즉시 되비친다
  const roster = page.locator('[data-testid="bulk-roster"]');
  await expect(roster).toBeVisible();
  await expect(page.locator('[data-testid="bulk-studio"]')).toHaveCount(0);
  await roster.fill(`${key}\n선임연구원\n책임연구원`);
  const rosterPreview = page.locator('[data-testid="bulk-roster-preview"]');
  await expect(rosterPreview).toContainText("2명");
  await expect(rosterPreview).toContainText("선임연구원");
  await expect(page.locator('[data-testid="bulk-keys"] .bulk-keychip.ok').first()).toBeVisible();

  // ③ 보조 경로 — 접혀 있다가 열면 번호 붙은 3단계(프롬프트 복사 + PII 고지 / 외부 AI / 결과 붙여넣기)
  await expect(page.locator('[data-testid="bulk-ai-wizard"]')).toHaveCount(0);
  await page.locator('[data-testid="bulk-ai-toggle"]').click();
  const wizard = page.locator('[data-testid="bulk-ai-wizard"]');
  await expect(wizard).toBeVisible();
  await expect(wizard.locator('[data-testid="bulk-ai-prompt"]')).toBeVisible();
  await expect(wizard.locator('[data-testid="bulk-pii-note"]')).toContainText("외부 AI 서비스");

  // ⑶ 형식이 깨진 결과는 조용히 삼키지 않고 사유를 말한다
  await page.locator('[data-testid="bulk-ai-result"]').fill(`${key},비고\n김하나`);
  await page.locator('[data-testid="bulk-ai-apply"]').click();
  await expect(page.locator('[data-testid="bulk-ai-error"]')).toContainText("열 수");
  await expect(roster).toHaveValue(new RegExp(`${key}\n선임연구원`)); // 기본 경로는 훼손되지 않는다

  // ⑶ 형식이 맞으면 위저드가 닫히고 기본 경로(명단 + 미리보기)로 합류한다
  await page.locator('[data-testid="bulk-ai-result"]').fill(`${key}: 선임연구원\n\n${key}: 책임연구원\n\n${key}: 수석연구원`);
  await page.locator('[data-testid="bulk-ai-apply"]').click();
  await expect(page.locator('[data-testid="bulk-ai-wizard"]')).toHaveCount(0);
  await expect(roster).toHaveValue(new RegExp(`${key}: 수석연구원`));
  await expect(rosterPreview).toContainText("3명");

  // ④ 생성·검수 — 생성이 끝나면 자동으로 검수 캐러셀 + 요약 배지 + 상시 zip CTA
  await page.locator('[data-testid="bulk-generate"]').click();
  await expect(page.locator('[data-testid="bulk-idx"]')).toContainText("1 / 3", { timeout: 120_000 });
  await expect(page.locator('[data-testid="bulk-roster"]')).toHaveCount(0);
  const badges = page.locator('[data-testid="bulk-badges"]').first();
  await expect(badges).toContainText("생성 3부");
  await expect(badges).toContainText("실패 0건");
  await expect(page.locator('[data-testid="bulk-zip"]')).toContainText("3부");

  // ⑤ 내려받기 — zip 클릭 = 실다운로드 + 마지막 단계(report 설명·다시 받기·처음부터)
  const zipDl = page.waitForEvent("download");
  await page.locator('[data-testid="bulk-zip"]').click();
  expect((await zipDl).suggestedFilename()).toBe("벌크채움_결과.zip");
  await expect(page.locator('[data-testid="bulk-done"]')).toBeVisible();
  await expect(page.locator('[data-testid="bulk-zip-again"]')).toContainText("3부");
  await expect(page.locator('[data-testid="bulk-reset"]')).toBeVisible();

  // 요약 칩으로 복귀해도 이후 단계 상태는 보존된다(③ 명단 → ④ 검수 그대로)
  await page.locator('[data-testid="bulk-step-3"]').click();
  await expect(page.locator('[data-testid="bulk-roster"]')).toHaveValue(new RegExp(`${key}: 수석연구원`));
  await page.locator('[data-testid="bulk-step-4"]').click();
  await expect(page.locator('[data-testid="bulk-idx"]')).toContainText("1 / 3");

  // "처음부터"는 ⑤에서만 — 누르면 ①로 돌아가고 뒤 단계가 다시 잠긴다
  await page.locator('[data-testid="bulk-step-5"]').click();
  await page.locator('[data-testid="bulk-reset"]').click();
  await expect(page.locator('[data-testid="bulk-dropzone"]')).toBeVisible();
  await expect(page.locator('[data-testid="bulk-step-3"]')).toBeDisabled();
});
