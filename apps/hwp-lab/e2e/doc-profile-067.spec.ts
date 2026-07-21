import path from "node:path";
import { expect, test } from "@playwright/test";

// 이슈 067 e2e: 아무것도 마킹하지 않아도 클라가 엔진의 결정론 문서 프로필(제목 후보·구성 카운트·표
// 목록·본문 발췌)을 doc-context 에 상시 첨부한다 — "이 문서가 뭔지"를 사용자가 설명하지 않아도 모델이
// 문서를 인지하는 경로(진단 U1·U2). LLM 은 전혀 안 부른다: 프로필은 wasm 엔진의 순수 모델 read 이고,
// 이 스펙은 mock 프로바이더로 요청 본문만 검사한다.
const BENCHMARK = path.resolve(process.cwd(), "..", "..", "benchmarks", "benchmark.hwp");

test("마킹 0 + 전송: doc-context 에 문서 프로필(구성·표 목록 [s/b] 주소·본문 발췌) 상시 첨부", async ({ page }) => {
  await page.goto("/");
  await page.locator('[data-testid="file-input"]').setInputFiles(BENCHMARK);
  await expect(page.locator(".hw-sheet svg").first()).toBeVisible({ timeout: 60_000 });

  // 앵커를 만들지 않고 바로 전송 — 전송 직전 /api/hwp-edit POST 를 가로채 요청 본문을 검사한다.
  const reqPromise = page.waitForRequest((r) => r.url().includes("/api/hwp-edit") && r.method() === "POST");
  await page.locator(".hw-textarea").fill("이 문서의 첫 표를 채워줘");
  await page.locator(".hw-btn-send").click();

  const req = await reqPromise;
  const body = JSON.parse(req.postData() ?? "{}") as { docContext?: string; anchors?: unknown[] };
  expect(body.anchors ?? []).toHaveLength(0); // 진짜 "마킹 0" 경로였음을 고정
  const ctx = body.docContext ?? "";
  expect(ctx).toContain("문서 프로필"); // 프로필 블록이 상시 첨부됐다(067 의 결정적 신호)
  expect(ctx).toContain("구성: 구역"); // 구조 카운트
  expect(ctx).toContain("표 목록: [s"); // 표 인벤토리 + [s/b] 편집 주소
  expect(ctx).toContain("본문 발췌"); // to_markdown 발췌
});
