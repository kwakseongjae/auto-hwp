import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Issue 044 — the desktop shell (VITE_SHELL=workspace) consumes the built @auto-hwp/react DIST. These
// aliases point the workspace-scoped specifiers at the sibling package outputs (built in the order
// editor-core → react before this ui build; the vite cache re-reads them each build). They are inert for
// the legacy build: App.tsx imports none of them, so the default (flag-off) bundle is unaffected.
//   • @auto-hwp/react/styles.css must precede @auto-hwp/react (prefix match order).
//   • @auto-hwp/engine → a local stub: the wasm backend is web-only + its pkg/ output is gitignored/absent,
//     and the desktop shell never instantiates WasmAdapter, so the static import resolves without wasm.
const P = (rel: string) => resolve(import.meta.dirname, rel);
const workspaceAlias = [
  { find: "@auto-hwp/react/styles.css", replacement: P("../../../packages/react/dist/styles.css") },
  // Subpath first: `@auto-hwp/engine` would otherwise prefix-rewrite
  // `@auto-hwp/engine/worker-client` to `engineStub.ts/worker-client` (missing).
  { find: "@auto-hwp/engine/worker-client", replacement: P("src/engineStub.ts") },
  { find: "@auto-hwp/engine", replacement: P("src/engineStub.ts") },
  { find: "@auto-hwp/react", replacement: P("../../../packages/react/dist/index.js") },
];

// Tauri expects a fixed dev port and a static build in `dist/` (see tauri.conf.json). Issue 069 uses
// the explicit Vite mode from tauri.workspace.conf.json so the selected shell is part of the child
// process command instead of an implicit inherited-env contract. A cargo-tauri 2.11.2 probe DOES inherit
// VITE_SHELL today; keep the env check as a direct-Vite compatibility path without relying on it for QA.
// With the default config both inputs are absent and the legacy shell stays on.
export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  // Fold to a literal so the DEFAULT build tree-shakes the workspace branch entirely (main.tsx
  // `if (__WORKSPACE_SHELL__)`). `vite --mode workspace` is the reliable Tauri QA path.
  define: { __WORKSPACE_SHELL__: JSON.stringify(mode === "workspace" || process.env.VITE_SHELL === "workspace") },
  resolve: { alias: workspaceAlias },
  server: { port: 1420, strictPort: true },
  build: { target: "safari15", outDir: "dist", emptyOutDir: true },
}));
