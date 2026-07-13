import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// 비-Next(Vite) 임베드 (issue 063). 엔진 wasm/워커는 public 정적 에셋(/hwp/*)으로 서빙하므로 특별한
// 번들러 설정이 필요 없다 — WasmAdapter 가 런타임에 명시적 URL 로 로드한다(worker: {type:'module'}).
//
// @tf-hwp/engine 은 pre-bundle(optimizeDeps)에서 제외한다: 워커 진입(worker.js)과 wasm 글루는 esbuild
// 사전 번들 대상이 아니라 런타임 정적 에셋 로딩 대상이다. react 안에서 참조되는 engine 심볼
// (resetEngine/isTrapError 등)은 그대로 번들된다.
export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    exclude: ["@tf-hwp/engine"],
  },
  server: { port: 5180 },
  preview: { port: 5180 },
});
