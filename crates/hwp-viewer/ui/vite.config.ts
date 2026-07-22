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
  { find: "@auto-hwp/engine", replacement: P("src/engineStub.ts") },
  { find: "@auto-hwp/react", replacement: P("../../../packages/react/dist/index.js") },
];

// Tauri expects a fixed dev port and a static build in `dist/` (see tauri.conf.json).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  // Build-time shell flag folded to a literal boolean so the DEFAULT build tree-shakes the workspace
  // branch entirely (main.tsx `if (__WORKSPACE_SHELL__)`). `VITE_SHELL=workspace vite build` → true.
  define: { __WORKSPACE_SHELL__: JSON.stringify(process.env.VITE_SHELL === "workspace") },
  resolve: { alias: workspaceAlias },
  server: { port: 1420, strictPort: true },
  build: { target: "safari15", outDir: "dist", emptyOutDir: true },
});
