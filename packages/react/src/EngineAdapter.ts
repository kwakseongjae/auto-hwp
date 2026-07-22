/// EngineAdapter DESCENDED to @auto-hwp/editor-core (issue 026): the backend seam is framework-agnostic,
/// so it lives in the headless core and @auto-hwp/react RE-EXPORTS it here for backward compatibility —
/// existing hosts keep `import { EngineAdapter } from "@auto-hwp/react"` working unchanged.
export type { EngineAdapter } from "@auto-hwp/editor-core";
