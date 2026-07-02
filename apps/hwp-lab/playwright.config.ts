import { defineConfig, devices } from "@playwright/test";

// Playwright 스모크 (issue 019 §6). dev 서버를 3100 포트로 띄워(예약 훅 predev가 wasm을
// public/hwp로 복사) 페이지 로드→업로드→렌더/편집/undo 를 검증한다. chromium 미설치 시
// `npx playwright install chromium` 필요.
const PORT = 3100;

export default defineConfig({
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
  },
});
