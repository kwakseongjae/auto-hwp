import path from "node:path";
import { expect, test } from "@playwright/test";

// 이슈 073 e2e: /bulk 벌크 채움 — 업로드→결정론 인스펙션(필드 스튜디오)→명단→생성+검증→검수
// 캐러셀→zip 의 전 플로우가 LLM 0콜·클라이언트 온리로 돈다. 규격(fillmap JSON) 저장 다운로드까지.
// 픽스처는 커밋된 benchmark.hwp(직위 라벨 1필드 유도 — 커버리지보다 플로우 잠금이 목적).
//
// 퍼널 재설계 정렬(2026-07-31): 화면이 5단계 퍼널이라 **한 번에 한 단계만** 펼쳐진다.
//  · ②(스튜디오) → ③(명단) 이동은 `bulk-next` 클릭이 필요하다(예전엔 한 화면에 다 있었다).
//  · AI 프롬프트 버튼은 ③의 접이식 보조 경로 안으로 들어갔다 — 여기서는 진입점(bulk-ai-toggle)만
//    확인하고, 위저드 3단계 합류는 bulk-funnel.spec.ts 가 잠근다.
//  · zip 클릭은 ⑤(내려받기)로 넘어간다 — 부수 표기 확인은 클릭 전에 한다.
const BENCHMARK = path.resolve(process.cwd(), "..", "..", "benchmarks", "benchmark.hwp");

test("073: 업로드→스튜디오(필드·규격 저장)→명단→생성→캐러셀→zip", async ({ page }) => {
  await page.goto("/bulk");
  await page.locator('[data-testid="bulk-template"]').setInputFiles(BENCHMARK);

  // 스튜디오: 자동 유도 필드 카드 + 문서 페이지 렌더
  await expect(page.locator('[data-testid="bulk-studio"]')).toBeVisible({ timeout: 60_000 });
  const cards = page.locator('[data-testid="bulk-field-card"]');
  await expect(cards.first()).toBeVisible();
  const key = await cards.first().locator(".key").inputValue();
  expect(key.length).toBeGreaterThan(0);

  // 규격 저장 = fillmap JSON 실다운로드
  const specDl = page.waitForEvent("download");
  await page.locator('[data-testid="bulk-spec-save"]').click();
  expect((await specDl).suggestedFilename()).toContain(".fillmap.json");

  // ③ 명단 단계로
  await page.locator('[data-testid="bulk-next"]').click();

  // 명단 온보딩: "형식 예시 넣기" → 사용자가 정의한 키로 스켈레톤이 들어간다
  await page.locator('[data-testid="bulk-roster-template"]').click();
  await expect(page.locator('[data-testid="bulk-roster"]')).toHaveValue(new RegExp(`${key}:`));
  await expect(page.locator('[data-testid="bulk-ai-toggle"]')).toBeVisible();

  // 명단(CSV, 헤더=필드 키) → 생성 → 캐러셀 2명
  await page.locator('[data-testid="bulk-roster"]').fill(`${key}\n선임연구원\n책임연구원`);
  await page.locator('[data-testid="bulk-generate"]').click();
  await expect(page.locator('[data-testid="bulk-idx"]')).toContainText("1 / 2", { timeout: 120_000 });
  await expect(page.locator('[data-testid="bulk-values"]')).toContainText("선임연구원");
  await page.getByRole("button", { name: "다음", exact: true }).click(); // 캐러셀 "다음 ›" → "다음 <ChevronRight/>"
  await expect(page.locator('[data-testid="bulk-idx"]')).toContainText("2 / 2");

  // zip 다운로드(개별 hwpx + report.json)
  const zipDl = page.waitForEvent("download");
  await page.locator('[data-testid="bulk-zip"]').click();
  expect((await zipDl).suggestedFilename()).toBe("벌크채움_결과.zip");
});
