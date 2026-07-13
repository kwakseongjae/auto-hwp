/// @tf-hwp/ai-protocol — the vendor-neutral wire contract for chat-editing (SDK-LAYERS L2'). Types only
/// here; the transforms/validators live in context.ts / prompt.ts / validate.ts. NOTHING in this package
/// fetches, holds a key, or talks to any LLM vendor — a host wires its own model over these shapes.

/** The frozen Intent schema version (docs/INTENT-SCHEMA.md — "Intent 스키마 v0 (동결)"). */
export const INTENT_VERSION = "v0";

/** An Intent (schema v0) — an internally-tagged object discriminated by `intent`; remaining fields are
 *  flat at the same level (docs/INTENT-SCHEMA.md §1). Kept loose so a host model can return any op the
 *  engine's `deserialize_intent` accepts; `validateResponse` gates it to the allowed whitelist. */
export type Intent = { intent: string; [field: string]: unknown };

/** A marked edit anchor (structure indices, never pixels). Structurally compatible with
 *  @tf-hwp/editor-core's Anchor so a host can pass those directly; kept independent here so ai-protocol
 *  stands alone (a server proxy need not depend on editor-core). */
export interface Anchor {
  kind: string;
  section: number;
  block: number;
  rows?: [number, number];
  cols?: [number, number];
  label?: string;
  page?: number;
  text?: string;
}

/** One ACTIVE (uncovered) cell of a marked table's grid (issue 066) — its MODEL-GLOBAL `(row, col)`
 *  address + current plain text. Structurally compatible with @tf-hwp/editor-core's `GridCell`. */
export interface GridCell {
  row: number;
  col: number;
  text: string;
}

/** The cell GRID of a marked table (issue 066) — `rows`×`cols` plus every ACTIVE cell's address + text.
 *  Attached to the doc-context so the model sees each cell's structure (which are labels, which are
 *  blank) and can fill a table / target a label's value cell. Coordinates are the SAME `(row, col)`
 *  `SetTableCell` writes. Structurally compatible with @tf-hwp/editor-core's `TableGrid` so a host can
 *  pass those straight through; kept independent here so ai-protocol stands alone. */
export interface TableGrid {
  section: number;
  block: number;
  rows: number;
  cols: number;
  cells: GridCell[];
}

/** Read-only document metadata used to ground the doc-context string (no bytes, no key). */
export interface DocMeta {
  format: string;
  pages: number;
  editable: boolean;
  sections: number;
}

/** The request a host POSTs to its own LLM proxy: the user's instruction, the marked anchors, and the
 *  R5-fenceable doc-context STRING (built by `buildDocContext`). No key, no model choice — those are the
 *  host's. */
export interface EditRequest {
  instruction: string;
  anchors: Anchor[];
  docContext: string;
}

/** The proxy's response: the Intents to preview → apply (schema v0). `[]` = no change proposed. */
export interface EditResponse {
  intents: Intent[];
}

/** Length/count caps for input validation (defense-in-depth; the proxy enforces before calling a model). */
export interface RequestLimits {
  maxInstruction: number;
  maxDocContext: number;
  maxAnchors: number;
}

/** Default caps (verbatim from the apps/hwp-lab reference proxy). */
export const DEFAULT_LIMITS: RequestLimits = {
  maxInstruction: 4000,
  maxDocContext: 20000,
  maxAnchors: 32,
};
