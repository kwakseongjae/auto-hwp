/// EngineAdapter DESCENDED to @tf-hwp/editor-core (issue 026): the backend seam is framework-agnostic,
/// so it lives in the headless core and @tf-hwp/react RE-EXPORTS it here for backward compatibility —
/// existing hosts keep `import { EngineAdapter } from "@tf-hwp/react"` working unchanged.
export type { EngineAdapter } from "@tf-hwp/editor-core";
