import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

// Issue 044 — build-time shell swap. `VITE_SHELL=workspace vite build` sets `__WORKSPACE_SHELL__` to a
// literal `true` (via the vite.config `define`), mounting the @tf-hwp/react HwpWorkspace desktop shell.
// With the flag unset the constant is a literal `false`, so esbuild/rollup DEAD-CODE-ELIMINATE the whole
// `if` block (incl. the dynamic `import("./WorkspaceShell")` → no extra chunk), leaving ONLY the `else`.
// The `else` is written byte-for-byte as the legacy bootstrap — `createRoot(...).render(<App/>)` — so the
// flag-off bundle is IDENTICAL to the pre-044 build (verified: same JS/CSS/html sha256). Rollback = drop
// the flag. `createRoot` is called inside each branch (not hoisted) precisely to keep that byte-identity.
if (__WORKSPACE_SHELL__) {
  const root = createRoot(document.getElementById("root")!);
  void import("./WorkspaceShell").then(({ mountWorkspaceShell }) => mountWorkspaceShell(root));
} else {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
