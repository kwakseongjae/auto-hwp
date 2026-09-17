import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { setPlatform } from "@auto-hwp/platform";
import { tauriPlatform } from "@auto-hwp/platform/tauri";
import "./styles.css";

/// 호스트를 먼저 정한다 (이슈 268).
///
/// 두 셸 **모두** 같은 계약 위에서 돈다 — 호스트 능력을 셸마다 따로 구현하던 것이 #260 의 원인이었다.
/// 마운트보다 앞에 두는 이유는 `api.ts` 같은 순수 모듈이 렌더 도중 곧바로 RPC 를 하기 때문이다.
///
/// (#044 의 바이트동일 규율은 `createRoot` 를 각 분기 안에서 부르는 것에 관한 것이고, 이 등록은 두
/// 분기 공통이라 그 규율과 충돌하지 않는다. 다만 이 줄이 늘었으므로 플래그-off 번들은 더 이상 pre-044
/// 와 바이트동일하지 않다 — 롤백 기준은 플래그가 아니라 이 커밋이다.)
setPlatform(tauriPlatform);

// Issue 044 — build-time shell swap. `VITE_SHELL=workspace vite build` sets `__WORKSPACE_SHELL__` to a
// literal `true` (via the vite.config `define`), mounting the @auto-hwp/react HwpWorkspace desktop shell.
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
