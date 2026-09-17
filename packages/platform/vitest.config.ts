import { defineConfig } from "vitest/config";

// node 환경 — 이 패키지의 코어(types/registry/capabilities)는 React 도 DOM 도 쓰지 않는다.
// 구현체(tauri.ts/web.ts)는 호스트가 있어야 의미가 있으므로 여기서 테스트하는 건 **계약**이다:
// 레지스트리가 능력을 정직하게 신고하는가, 없는 능력을 부르면 분명하게 실패하는가.
export default defineConfig({
  test: { globals: true, environment: "node", include: ["src/**/*.test.ts"] },
});
