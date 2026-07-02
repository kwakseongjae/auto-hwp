/// Shared types for @tf-hwp/react. The geometry types mirror @tf-hwp/engine's BlockHit/TableBox (own-
/// render PX space); the edit types (Intent/Anchor/Proposal) are the schema-v0 surface the chat panel
/// speaks to the host AI callback and the engine adapter.

/** A structural block hit in own-render px space (mirrors @tf-hwp/engine BlockHit). null on a miss. */
export interface BlockHit {
  section: number;
  block: number;
  kind: "paragraph" | "table" | "image" | string;
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  editable: boolean;
}

/** A placed table box for marking in own-render px space (mirrors @tf-hwp/engine TableBox). */
export interface TableBox {
  section: number;
  block: number;
  x: number;
  y: number;
  w: number;
  h: number;
  rows: number;
  cols: number;
  first_row: number;
}

/** An Intent (schema v0) — an internally-tagged object discriminated by `intent`. Kept loose here so
 *  the host AI callback can return any op the engine's `deserialize_intent` accepts (SetTableCell,
 *  ApplyContent, Replace, …). The adapter forwards it to the engine verbatim. */
export type Intent = { intent: string; [field: string]: unknown };

/** The tagged result of applyIntent (mirrors @tf-hwp/engine Outcome). */
export type Outcome = { kind: string; [field: string]: unknown };

/** Metadata for an open document (mirrors @tf-hwp/engine's `opened` Outcome + a page count). */
export interface OpenResult {
  format: string;
  editable: boolean;
  sections: number;
  pages: number;
}

/** A structural edit ANCHOR the user marked (issue #009: cell/range/paragraph/table) that rides along
 *  with a chat prompt so the AI edits exactly that spot. Coordinates are STRUCTURE indices — NEVER
 *  pixels. `section`/`block` are the model anchor; `rows`/`cols` are inclusive GLOBAL bounds; `label`
 *  is the human-readable Korean chip text; `page` is the 0-based page for context; `text` is the
 *  marked cell/block's current text (fed to the AI callback as context). */
export interface Anchor {
  kind: "cell" | "range" | "paragraph" | "table";
  section: number;
  block: number;
  rows?: [number, number];
  cols?: [number, number];
  label: string;
  page: number;
  text?: string;
}

/** The read-only document context handed to the host AI callback alongside the instruction + anchors,
 *  so a server-side model can ground its Intents without the package ever seeing the doc bytes or a
 *  key. `anchors` is the same array passed as the 2nd arg (duplicated for convenience). */
export interface DocContext {
  format: string;
  editable: boolean;
  sections: number;
  pages: number;
  anchors: Anchor[];
}

/** The host-supplied AI bridge (R6): the package NEVER calls an LLM or holds a key. Given the user's
 *  instruction, the marked anchors, and the doc context, the host (its own server) returns the Intents
 *  to preview → apply. Returning `[]` means "no change proposed". */
export type OnAiRequest = (instruction: string, anchors: Anchor[], docContext: DocContext) => Promise<Intent[]>;

/** Per-op-kind metadata for the proposal preview CARD (010식). `describeIntent` maps an Intent to a
 *  human summary + target chip for the card. */
export interface IntentCard {
  kind: string;
  icon: string;
  label: string;
  summary: string;
  section: number | null;
  block: number | null;
}
