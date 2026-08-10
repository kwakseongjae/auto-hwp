import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// jsdom so the SVG sanitizer's DOMParser/XMLSerializer path (the browser path, not the regex fallback)
// runs in tests, and React components mount + fire events under @testing-library/react.
export default defineConfig({
  plugins: [react()],
  // 환경 복구(선재 결함): editor-core 의 배포 dist 는 `moduleResolution: bundler` 산출물이라
  // 확장자 없는 상대 import(`./core`)를 담는다 — Next(transpilePackages)/번들러는 해석하지만
  // vitest 의 node ESM 해석은 못 한다("Cannot find module …/dist/core"). 여기서 소스로 별칭을
  // 걸어 테스트가 dist 대신 editor-core **소스**를 본다(공개 계약 동일, 빌드 산출물 무관).
  resolve: {
    alias: {
      "@auto-hwp/editor-core": fileURLToPath(new URL("../editor-core/src/index.ts", import.meta.url)),
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    // Polyfill PointerEvent / setPointerCapture (jsdom lacks both) so the selection model's pointer
    // handlers (issue 021) fire under test.
    setupFiles: ["src/test-setup.ts"],
  },
});
