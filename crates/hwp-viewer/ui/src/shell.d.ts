// Issue 044 — build-time shell flag, folded to a literal boolean by the vite.config `define`. `true` only
// under `VITE_SHELL=workspace vite build`; `false` (and dead-code-eliminated) in the default build.
declare const __WORKSPACE_SHELL__: boolean;
