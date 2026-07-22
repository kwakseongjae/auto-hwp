/// @auto-hwp/ai-protocol — the vendor-neutral wire contract for chat-editing (SDK-LAYERS L2'). Types only
/// here; the transforms/validators live in context.ts / prompt.ts / validate.ts. NOTHING in this package
/// fetches, holds a key, or talks to any LLM vendor — a host wires its own model over these shapes.

/** The frozen Intent schema version (docs/INTENT-SCHEMA.md — "Intent 스키마 v0 (동결)"). */
export const INTENT_VERSION = "v0";

/** An Intent (schema v0) — an internally-tagged object discriminated by `intent`; remaining fields are
 *  flat at the same level (docs/INTENT-SCHEMA.md §1). Kept loose so a host model can return any op the
 *  engine's `deserialize_intent` accepts; `validateResponse` gates it to the allowed whitelist. */
export type Intent = { intent: string; [field: string]: unknown };

/** A marked edit anchor (structure indices, never pixels). Structurally compatible with
 *  @auto-hwp/editor-core's Anchor so a host can pass those directly; kept independent here so ai-protocol
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
 *  address + current plain text. Structurally compatible with @auto-hwp/editor-core's `GridCell`. */
export interface GridCell {
  row: number;
  col: number;
  text: string;
}

/** The cell GRID of a marked table (issue 066) — `rows`×`cols` plus every ACTIVE cell's address + text.
 *  Attached to the doc-context so the model sees each cell's structure (which are labels, which are
 *  blank) and can fill a table / target a label's value cell. Coordinates are the SAME `(row, col)`
 *  `SetTableCell` writes. Structurally compatible with @auto-hwp/editor-core's `TableGrid` so a host can
 *  pass those straight through; kept independent here so ai-protocol stands alone. */
export interface TableGrid {
  section: number;
  block: number;
  rows: number;
  cols: number;
  cells: GridCell[];
}

/** One detected heading of the document profile (issue 067). Structurally compatible with
 *  @auto-hwp/editor-core's `ProfileHeading` so a host passes the adapter's value straight through. */
export interface ProfileHeading {
  section: number;
  block: number;
  level: number;
  text: string;
}

/** One table's inventory line of the document profile (issue 067): model address + shape + first-row
 *  (header) cell texts. `(section, block)` are the SAME addresses `SetTableCell` targets. */
export interface ProfileTable {
  section: number;
  block: number;
  rows: number;
  cols: number;
  header: string[];
}

/** The deterministic document profile (issue 067): title candidate + structure counts + headings +
 *  table inventory + a structure-preserving body excerpt. Engine-computed by pure model walks (ZERO
 *  LLM calls) — the "what IS this document" grounding that ends the user re-explaining the document
 *  every session (U1). Document-derived, hence UNTRUSTED — it rides INSIDE the R5-fenced
 *  `<document-content>` block (DATA, never instructions). Structurally compatible with
 *  @auto-hwp/editor-core's `DocProfile` (a host passes the adapter's value straight through). */
export interface DocProfile {
  title: string | null;
  sections: number;
  paragraph_count: number;
  table_count: number;
  image_count: number;
  chart_count: number;
  equation_count: number;
  headings: ProfileHeading[];
  tables: ProfileTable[];
  excerpt: string;
}

/** Read-only document metadata used to ground the doc-context string (no bytes, no key). */
export interface DocMeta {
  format: string;
  pages: number;
  editable: boolean;
  sections: number;
  /** OPTIONAL (issue 067, additive) — the engine's deterministic document profile. When present,
   *  `buildDocContext` renders it right after the header line (within the anchors-first budget);
   *  absent ⇒ the output is byte-identical to the pre-067 builder (regression-safe). */
  profile?: DocProfile;
}

/** One chat ATTACHMENT (multimodal input) — the user pastes/picks an IMAGE (a photo/screenshot of a table,
 *  a reference figure) or a reference DOCUMENT. An `image` carries a base64 `dataUrl` (sent to a vision
 *  model as an OpenAI-style `image_url` content part); a `doc` carries extracted `text` (folded into the
 *  R5 fence as untrusted reference DATA — never instructions). Both are CONTEXT, never a new Intent: the
 *  Intent lane/whitelist is untouched. Additive + unknown-field-safe per invariant 7. Structurally
 *  compatible with @auto-hwp/editor-core's `Attachment` so a host passes these straight through. */
export interface Attachment {
  id: string;
  kind: "image" | "doc";
  name: string;
  mime: string;
  /** IMAGE only: a base64 `data:` URL (e.g. `data:image/png;base64,…`) sent as an `image_url` part. */
  dataUrl?: string;
  /** DOC only: the extracted plain text, R5-fenced as reference DATA. Absent when extraction is unsupported. */
  text?: string;
}

/** One OpenAI-compatible USER content PART (multimodal) — either a text segment or an inline image URL.
 *  `buildUserMessageParts` returns these when a request carries image attachments so a vision model
 *  (e.g. OpenRouter's grok-4.5, whose input_modalities include "image") sees the picture; the string
 *  `buildUserMessage` stays the back-compat path when there are no images. */
export type UserContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

/** The request a host POSTs to its own LLM proxy: the user's instruction, the marked anchors, and the
 *  R5-fenceable doc-context STRING (built by `buildDocContext`). No key, no model choice — those are the
 *  host's. `attachments` (additive, optional) carries multimodal chat input — images for a vision model +
 *  reference-doc text folded into the R5 fence. Absent → byte-identical to the pre-multimodal request. */
export interface EditRequest {
  instruction: string;
  anchors: Anchor[];
  docContext: string;
  attachments?: Attachment[];
}

/** One web-search source CITATION (web grounding) — a display-only `{title, url}` pair the proxy parses
 *  from the model's `url_citation` annotations (OpenRouter web plugin) so the host can show WHERE a
 *  grounded answer came from. Transparency data only — never fed back into an Intent (R5/R6 preserved).
 *  Structurally compatible with @auto-hwp/editor-core's `Citation` so a host passes these straight through. */
export interface Citation {
  url: string;
  title: string;
}

/** The proxy's response: the Intents to preview → apply (schema v0). `[]` = no change proposed. The
 *  OPTIONAL `citations` (additive) carries web-search sources when the request enabled web grounding —
 *  absent/`[]` on ordinary edits (the field only appears when the web plugin ran). */
export interface EditResponse {
  intents: Intent[];
  citations?: Citation[];
}

/** One prior CHAT turn passed back to the model as CONVERSATION MEMORY (agentic streaming). The chat
 *  surface accumulates a BOUNDED window of prior user requests + a compact digest of what the assistant
 *  proposed, so a follow-up ("이제 그 표에 행 하나 더") is understood in context (today each request is
 *  stateless). `role` mirrors the OpenAI chat roles; `text` is plain (an assistant turn is a compact
 *  summary of its proposed edits, NOT raw Intent JSON — that lane stays the emit_intents tool). Untrusted
 *  as far as the Intent whitelist is concerned; it only grounds the model, never bypasses validation. */
export interface ChatTurn {
  role: "user" | "assistant";
  text: string;
}

/** A single wire EVENT streamed from the agentic runner to the chat, one per NDJSON line (THINKING
 *  TRANSPARENCY). A discriminated union on `type`:
 *   - `status`         — a phase change the UI shows as a step ("검색 중…", "작성 중…").
 *   - `thinking_delta` — an incremental chunk of the model's reasoning/prose (streamed live).
 *   - `tool_call`      — the model invoked a tool (e.g. `web_search` with `{query}`); `args` is the
 *                        parsed tool arguments (UNTRUSTED — display only, never executed as instructions).
 *   - `tool_result`    — a tool finished; for `web_search` it carries the source `citations` (R5 DATA).
 *   - `intents`        — the TERMINAL event: the validated Intent[] to preview → apply.
 *   - `error`          — the runner failed; `message` is a human-readable reason (never leaks the key).
 *  Additive + unknown-field-safe (invariant 7). Structurally mirrored by @auto-hwp/editor-core's AgentEvent
 *  so the SDK forwards these straight through without depending on this package. */
export type AgentEvent =
  | { type: "status"; phase: "thinking" | "searching" | "composing" }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_call"; tool: string; args: unknown }
  | { type: "tool_result"; tool: string; citations?: Citation[] }
  | { type: "intents"; intents: Intent[] }
  | { type: "error"; message: string };

/** Length/count caps for input validation (defense-in-depth; the proxy enforces before calling a model).
 *  The attachment caps (additive, optional so a custom `RequestLimits` need not set them) bound the
 *  multimodal channel — count, per-doc extracted-text length, and per-image `dataUrl` size. */
export interface RequestLimits {
  maxInstruction: number;
  maxDocContext: number;
  maxAnchors: number;
  maxAttachments?: number;
  maxAttachmentText?: number;
  maxImageDataUrl?: number;
}

/** Default caps (verbatim from the apps/hwp-lab reference proxy; attachment caps added for multimodal). */
export const DEFAULT_LIMITS: RequestLimits = {
  maxInstruction: 4000,
  maxDocContext: 20000,
  maxAnchors: 32,
  maxAttachments: 8,
  maxAttachmentText: 20000,
  maxImageDataUrl: 8_000_000, // ~6 MB of base64 image bytes
};
