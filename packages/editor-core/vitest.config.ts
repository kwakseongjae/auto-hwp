import { defineConfig } from "vitest/config";

// node environment ONLY — @auto-hwp/editor-core is framework-agnostic and must be unit-testable without
// jsdom. If any test needs the DOM, the dependency belongs in @auto-hwp/react, not here (SDK-LAYERS
// boundary: L2 has zero React/DOM). Pure inputs (pointerDown({page,x,y,mod}) etc.) drive the model.
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts", "examples/**/*.test.ts"],
  },
});
