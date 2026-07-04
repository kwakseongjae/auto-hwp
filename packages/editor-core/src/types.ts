/// Shared, framework-agnostic types for @tf-hwp/editor-core (SDK-LAYERS L2). These were previously in
/// @tf-hwp/react/src/types.ts; they are DOM-free model/geometry/edit shapes, so they DESCEND here and
/// @tf-hwp/react re-exports them verbatim (public API is unchanged for existing consumers).
///
/// Geometry types (BlockHit/TableBox/CellHit/Box) live in own-render PX space (= HWPUNIT/75). Edit types
/// (Intent/Anchor) address the MODEL in structure indices (section/block/row/col), NEVER pixels.

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

/** A table CELL hit for cell-level marking in own-render px space (mirrors @tf-hwp/engine CellHit; issue
 *  023). `row`/`col` are MODEL-GLOBAL — already global on a split-table fragment, so NEVER re-add
 *  `first_row` (§좌표계). `text` is the cell's current plain text, used for the chip snippet label. */
export interface CellHit {
  section: number;
  block: number;
  row: number;
  col: number;
  rows: number;
  cols: number;
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** An Intent (schema v0) — an internally-tagged object discriminated by `intent`. Kept loose here so
 *  the host AI callback can return any op the engine's `deserialize_intent` accepts (SetTableCell,
 *  ApplyContent, Replace, …). The adapter forwards it to the engine verbatim. */
export type Intent = { intent: string; [field: string]: unknown };

/** A STYLED text run (Intent schema v0 `RunSpec`, INTENT-SCHEMA §6.7) — the read shape `blockRuns`
 *  returns AND the write shape `SetTableCellRuns`/`SetParagraphRuns` accept, so a text edit round-trips
 *  through the SAME type (run-format preservation, issue 027 §함정). A multi-paragraph cell's paragraphs
 *  are joined by a bare `{ text: "\n" }` run. All style fields are optional (unset = inherit). */
export interface RunSpec {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  size_pt?: number;
  color?: string;
  highlight?: string;
  font?: string;
}

/** Page geometry in own-render PAGE px (= HWPUNIT/75) — the page box + printable-area margins, for the
 *  ruler (issue 027). Mirrors @tf-hwp/engine's `pageGeometry` / hwp-session `PageGeom`. */
export interface PageGeom {
  /** Page width (px). */ w: number;
  /** Page height (px). */ h: number;
  /** Left / top / right / bottom printable-area margins (px). */ ml: number;
  mt: number;
  mr: number;
  mb: number;
}

/** WYSIWYG GLYPH caret — the editable model target a click resolves to (engine `HitTest` intent, the
 *  rhwp glyph-box path). This is the CHARACTER-precise caret hit, DISTINCT from the own-render `BlockHit`
 *  (which is a block box with no char offset). `node`/`block` are `null` for a TABLE-CELL run OR a
 *  paragraph that carries no NodeId (an unedited binary `.hwp`): the caret GEOMETRY is available
 *  (`offset`/`section`/`para_ord`), but there is no editable text target in v1 — see docs/CARET-GAP.md
 *  for the measured extent of that gap on the benchmark corpus. `offset` is the caret position in
 *  PARAGRAPH chars (Unicode scalars); `section`/`para_ord` index the GEOMETRY side. Field names mirror
 *  the engine's wasm JSON verbatim (snake_case) so `WasmAdapter` forwards it untouched — `TauriAdapter`
 *  remaps the desktop command's camelCase into this shape. */
export interface HitResult {
  node: number | null;
  block: number | null;
  offset: number;
  section: number;
  para_ord: number;
  in_cell: boolean;
  /** Editable char length of the resolved paragraph (0 when unaddressed). The caller CLAMPS caret moves
   *  to `[0, para_len]`; `caretRect` clamps a PAST-END offset to the paragraph end and returns a rect
   *  (NOT null), so the UI must NEVER infer end-of-paragraph from a null rect (018 null policy). */
  para_len: number;
}

/** WYSIWYG GLYPH caret — a caret rectangle in own-render PAGE px (= HWPUNIT/75), the GEOMETRY half of
 *  the caret (engine `CaretRect` intent). If the view zooms the SVG, scale these by the same factor.
 *  A `caretRect` query resolves to `null` only when the target paragraph does NOT render on the queried
 *  page (query the page it does) — a valid-but-past-end offset is CLAMPED, never null. */
export interface CaretRect {
  x: number;
  top: number;
  height: number;
}

/** A resolved TEXT caret position in the MODEL — the editable half of a glyph caret, derived from a
 *  `HitResult` via `hitResultToTextAnchor`. Unlike the pixel-space `HitResult`, this addresses the doc
 *  in STRUCTURE indices so an edit op (InsertText / DeleteBack) can target it. Only constructible when
 *  the hit resolved to an editable `node` (a body paragraph). CELL text is NOT addressable in v1 — the
 *  `cell` field is a RESERVED shape for the 042 follow-up (a cell-addressed CaretRect variant); v1
 *  always leaves it undefined. See docs/CARET-GAP.md for why. */
export interface TextAnchor {
  section: number;
  block: number;
  node: number;
  offset: number;
  /** The paragraph's editable char length — the clamp bound for caret moves (`0..paraLen`). */
  paraLen: number;
  /** RESERVED (042): the `(row, col)` of a cell-addressed anchor. Always undefined in v1. */
  cell?: { row: number; col: number };
}

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

/** The host-supplied AI bridge (R6): the SDK NEVER calls an LLM or holds a key. Given the user's
 *  instruction, the marked anchors, and the doc context, the host (its own server) returns the Intents
 *  to preview → apply. Returning `[]` means "no change proposed". */
export type OnAiRequest = (instruction: string, anchors: Anchor[], docContext: DocContext) => Promise<Intent[]>;

/** Per-op-kind metadata for the proposal preview CARD (010식). A pure Intent→card mapping used by the
 *  UI layer to render a human summary + target chip. */
export interface IntentCard {
  kind: string;
  icon: string;
  label: string;
  summary: string;
  section: number | null;
  block: number | null;
}

/** A rectangle in own-render PAGE px (the space the adapter's hit-test/table queries speak). */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A visible MARK over a selected cell/range/table/paragraph on ONE page — the visual view of a
 *  selection item. `box` is own-render PAGE px; the UI scales it to screen px. */
export interface SelMark {
  page: number;
  box: Box;
  label: string;
  kind: "cell" | "range" | "paragraph" | "table" | "image" | string;
}

/** The in-progress marquee (rubber-band) rectangle, own-render PAGE px, on `page`. v1 clips a marquee to
 *  the page it started on. */
export interface SelMarquee {
  page: number;
  box: Box;
}

/** One selected block = its structural Anchor (rides to the chat) + its visual Mark (drawn on the page).
 *  The selection array is the SINGLE source of truth (issue 021); anchors/marks are views of it. */
export interface Selection {
  anchor: Anchor;
  mark: SelMark;
}

/** A page-local pointer input to the SelectionModel — the DOM-FREE contract (SDK-LAYERS §함정). `x`/`y`
 *  are own-render PAGE px (the UI layer does the client-px → page-px conversion); `mod` folds ⌘/Ctrl.
 *  `client` (optional) carries the raw screen point so the drag threshold is measured zoom-independently
 *  — when omitted (pure node tests), the threshold falls back to page px. */
export interface PointerInput {
  page: number;
  x: number;
  y: number;
  mod: boolean;
  client?: { x: number; y: number };
}
