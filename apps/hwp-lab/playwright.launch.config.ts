import { defineConfig, devices } from "@playwright/test";

// 공식 런칭 표면 전용. 평소 제품 e2e와 분리되어 있으며 verify-launch --browser에서만 실행한다.
// 배포 후에는 LAUNCH_BASE_URL=https://autohwp.com 으로 같은 계약을 프로덕션에 다시 건다.
const LIVE = process.env.LAUNCH_BASE_URL?.replace(/\/$/, "");
const PORT = Number(process.env.LAUNCH_PORT ?? 3110);

export default defineConfig({
  testDir: "./e2e-launch",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: LIVE ?? `http://localhost:${PORT}`,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  ...(LIVE
    ? {}
    : {
        webServer: {
          command: `npm run dev -- -p ${PORT}`,
          url: `http://localhost:${PORT}`,
          reuseExistingServer: !process.env.CI,
          timeout: 180_000,
          env: { OPENROUTER_API_KEY: "", ANTHROPIC_API_KEY: "" },
        },
      }),
});
