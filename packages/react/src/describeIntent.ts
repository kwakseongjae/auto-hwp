/// describeIntent DESCENDED to @tf-hwp/editor-core (issue 026) — it's a pure Intent→card mapping (no DOM),
/// so it lives in the headless core; @tf-hwp/react RE-EXPORTS it here so existing imports (ChatPanel and
/// hosts) keep working unchanged.
export { describeIntent } from "@tf-hwp/editor-core";
