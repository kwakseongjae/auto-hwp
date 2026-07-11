import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";

// 이슈 055 웹 하드닝 e2e: ① 엔진이 실제로 Web Worker 에서 돈다(FG-14) ② 64MiB 초과 업로드는
// 파싱 전에 정직하게 거부된다(한도 UX) ③ `?engineWorker=off` 롤백 스위치는 메인스레드 엔진으로
// 동작한다(계측/롤백 경로 보존). 기존 전 스위트(렌더/편집/복구/perf)는 워커 경유로 그대로 그린이어야
// 하며 — 그 자체가 어댑터 계약 유지의 증명이다(이 파일은 워커 사용 사실만 추가로 잠근다).
const BENCHMARK = path.resolve(process.cwd(), "..", "..", "benchmarks", "benchmark.hwp");

test("워커 모드(기본): 문서 열기 → 렌더가 되고, 엔진 워커가 실제로 살아 있다", async ({ page }) => {
  await page.goto("/");
  await page.locator('[data-testid="file-input"]').setInputFiles(BENCHMARK);
  await expect(page.locator(".hw-sheet svg").first()).toBeVisible({ timeout: 60_000 });

  // 엔진 워커가 존재한다 — /hwp/worker.js 모듈 워커(파싱/렌더가 메인스레드를 떠났다는 구조적 증거).
  const engineWorkers = page.workers().filter((w) => w.url().includes("/hwp/worker.js"));
  expect(engineWorkers.length).toBeGreaterThan(0);
});

test("한도 UX: 64MiB 초과 파일은 파싱 전에 정직한 사유로 거부된다", async ({ page }) => {
  await page.goto("/");
  // 65MiB 합성 파일(임시 디렉터리 — playwright 인메모리 버퍼는 50MB 상한이라 파일로 준다).
  // 확장자는 유효(.hwp)이므로 거부 사유는 오직 크기 한도여야 한다.
  const dir = mkdtempSync(path.join(os.tmpdir(), "tf-hwp-055-"));
  const huge = path.join(dir, "huge.hwp");
  writeFileSync(huge, Buffer.alloc(65 * 1024 * 1024, 0x41));
  try {
    await page.locator('[data-testid="file-input"]').setInputFiles(huge);

    const err = page.locator('[data-testid="lab-error"]');
    await expect(err).toBeVisible({ timeout: 30_000 });
    await expect(err).toContainText("파일이 너무 큽니다");
    await expect(err).toContainText("최대 64.0MB");
    // 파싱을 시작하지 않았으므로 엔진 워커도 뜨지 않는다(빈 화면 유지).
    await expect(page.locator(".lab-empty")).toBeVisible();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("롤백 스위치: ?engineWorker=off 는 메인스레드 엔진으로 열린다 (BEFORE 계측/롤백 경로)", async ({ page }) => {
  await page.goto("/?engineWorker=off");
  await page.locator('[data-testid="file-input"]').setInputFiles(BENCHMARK);
  await expect(page.locator(".hw-sheet svg").first()).toBeVisible({ timeout: 60_000 });
  const engineWorkers = page.workers().filter((w) => w.url().includes("/hwp/worker.js"));
  expect(engineWorkers.length).toBe(0);
});
