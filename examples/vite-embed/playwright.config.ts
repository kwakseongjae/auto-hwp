import { defineConfig, devices } from "@playwright/test";

// 이식 스모크(issue 063): published tarball 을 설치한 Vite 앱을 dev 서버로 띄우고, 뷰어 렌더 + 셀 편집을
// 검증한다. 포트 5180 고정. 로컬은 reuseExistingServer(이미 떠 있으면 재사용).
export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  fullyParallel: false,
  use: {
    baseURL: "http://localhost:5180",
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run dev",
    url: "http://localhost:5180",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
