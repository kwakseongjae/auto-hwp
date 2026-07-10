import { defineConfig } from "vitest/config";

// issue 052 — hwp-lab 단위 테스트 (자동저장/복구 영속 계층). node 환경: AutosaveController 는
// 헤드리스(React/DOM 无)이고, 스토어 정책 테스트는 MemorySnapshotStore(IndexedDB mock)로 돈다.
// goldenRecovery.test.ts 는 실엔진(wasm) 테스트라 packages/engine/pkg(015 레시피 산출물)가 필요하다.
// 배너/IndexedDB 실구현은 Playwright e2e(autosave-recovery-052.spec.ts)가 실브라우저로 검증한다.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
