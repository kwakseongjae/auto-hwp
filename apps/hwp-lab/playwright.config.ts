import { defineConfig, devices } from "@playwright/test";

// Playwright 스모크 (issue 019 §6). dev 서버를 3100 포트로 띄워(예약 훅 predev가 wasm을
// public/hwp로 복사) 페이지 로드→업로드→렌더/편집/undo 를 검증한다. chromium 미설치 시
// `npx playwright install chromium` 필요.
const PORT = 3100;

export default defineConfig({
  // 알려진 순서/타이밍 플레이키(039·048 계열 — 격리 실행은 항상 그린, CURRENT_STATE §알려진 flaky)의
  // 풀스위트 노이즈 완화: 1회 재시도. 일관 회귀는 여전히 실패하고, 플레이키는 리포트에 "flaky"로
  // 표시되어 은폐되지 않는다(추적 유지).
  retries: 1,
  testDir: "./e2e",
  timeout: 120_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npm run dev -- -p ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    // e2e 결정성: provider 키를 비워 hwp-edit 라우트를 mock 으로 고정한다. Next(@next/env)는 이미
    // 정의된 process.env 키를 .env.local 로 덮어쓰지 않으므로 빈 문자열이 이겨 activeProvider()→mock.
    // (개발자 로컬 .env.local 에 OPENROUTER_API_KEY 가 있으면 e2e 가 실 Grok 을 쳐서 비결정적으로
    // 깨지던 것을 차단 — 라이브 프로바이더 검증은 수동 QA 몫. 066 스테일-dist 회귀 조사에서 발견.)
    env: { OPENROUTER_API_KEY: "", ANTHROPIC_API_KEY: "" },
  },
});
