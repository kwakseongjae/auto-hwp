import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Demo app (issue 016 step 5). Roots at demo/, imports the package from ../src (dev) and the engine
// from @tf-hwp/engine. The wasm is a big asset resolved by the engine's `new URL(..., import.meta.url)`
// — excluded from dep pre-bundling so Vite emits it as an asset rather than trying to transform it.
export default defineConfig({
  // Relative to the cwd the demo scripts run from (packages/react) → packages/react/demo.
  root: "demo",
  base: "./",
  plugins: [react()],
  optimizeDeps: { exclude: ["@tf-hwp/engine"] },
  build: { outDir: "dist", emptyOutDir: true },
});
