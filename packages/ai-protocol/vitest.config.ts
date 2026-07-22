import { defineConfig } from "vitest/config";

// node environment — @auto-hwp/ai-protocol is ISOMORPHIC (must run identically server + browser) and pure
// (no fetch, no LLM client, no keys). The node run proves it has no browser-only assumptions; the same
// functions are imported by the browser client and the server route in apps/hwp-lab.
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
