// Issue 044 — `@auto-hwp/engine` is the WEB (wasm) backend. The desktop shell mounts `HwpWorkspace` with a
// `TauriAdapter` and NEVER instantiates `WasmAdapter`, so the wasm engine is dead code here. `@auto-hwp/react`
// (which we consume as a bundled dist) still carries a static `import { HwpDoc, initEngine, resetEngine }
// from "@auto-hwp/engine"` at the top of its `WasmAdapter` code — evaluated at module load but never called.
//
// The engine's wasm build output (`packages/engine/pkg/`) is gitignored and absent in this checkout, so
// bundling the real module would fail to resolve `./pkg/hwp_wasm.js`. Vite aliases `@auto-hwp/engine` to
// THIS stub for the desktop build: the import binds, nothing runs, and no wasm is pulled into the Tauri
// bundle. (tsc still typechecks against the REAL `@auto-hwp/engine` declarations via tsconfig `paths`.)
const webOnly = (): never => {
  throw new Error("@auto-hwp/engine (wasm) is web-only — the desktop shell uses TauriAdapter, not WasmAdapter");
};

/** Placeholder for the wasm document handle — never constructed in the desktop shell. */
export class HwpDoc {}
export const initEngine = webOnly;
export const resetEngine = webOnly;
export const initEngineSync = webOnly;
export const sanitizeSvg = (svg: string): string => svg;
