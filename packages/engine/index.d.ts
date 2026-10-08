// Type definitions for @auto-hwp/engine (the safety-wrapped surface in index.js).
// The raw wasm-bindgen types live in ./pkg/hwp_wasm.d.ts.

import type { EngineLoadOptions } from "./cdn";

export type { EngineLoadOptions, EngineLoadProgress, EngineProgressHandler } from "./cdn";
/** W6.1 — default asset locations (this package's own version on jsDelivr; never `@latest`). */
export { ENGINE_VERSION, WASM_BYTES, cdnBase, defaultWasmUrl, defaultWorkerUrl, fetchWasmResponse } from "./cdn";

/** Instantiate the wasm engine once. OMIT `input` to load this package's own version from jsDelivr
 *  (W6.1); pass a URL/Response/bytes to self-host. `options.onProgress` reports download ticks.
 *  Idempotent. Await this before HwpDoc.open. */
export function initEngine(
  input?: string | URL | Request | BufferSource | WebAssembly.Module,
  options?: EngineLoadOptions,
): Promise<unknown>;

/** Re-instantiate after a wasm trap. Every previously-opened HwpDoc becomes dead; re-open documents. */
export function resetEngine(
  input?: string | URL | Request | BufferSource | WebAssembly.Module,
  options?: EngineLoadOptions,
): Promise<unknown>;

/** Synchronous init from an already-fetched module/bytes (advanced/bundler use). */
export function initEngineSync(moduleOrBytes: WebAssembly.Module | BufferSource): unknown;

/** Strip <script>/on*/<foreignObject>/javascript: from an untrusted SVG string (R7). Minimal — see 016. */
export function sanitizeSvg(svg: string): string;

/** issue 055 사후 — THE single trap classifier (no host-side copies). A structured error carrying
 *  `code` is judged by that code alone (`wasm_trap` → true, any other code → false); otherwise a
 *  WebAssembly.RuntimeError instance or a trap-shaped message means the instance is poisoned. */
export function isTrapError(e: unknown): boolean;

/** A structural block hit (own-render px space); null on a miss. */
export interface BlockHit {
  section: number;
  block: number;
  kind: 'paragraph' | 'table' | 'image';
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
  editable: boolean;
}

/** A placed table box for marking (own-render px space); null on a miss. */
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
  /** Descending path to a nested table's parent cell. Empty for a top-level table. */
  path: CellAddr[];
  /** This table's block index inside that parent cell (equals `block` at top level). */
  self_block: number;
}

/** An anchored image's placed box (own-render px space; issue 049); null on a miss. `x/y/w/h` is the
 *  image's OWN rectangle (for the 8-handle overlay), `(section, block)` the model anchor SetImageSize /
 *  MoveImage target. Mirrors hwp-session `ImageBoxDto`. */
export interface ImageBox {
  x: number;
  y: number;
  w: number;
  h: number;
  section: number;
  block: number;
}

/** A table CELL hit for cell-level marking (own-render px space; issue 023); null on a miss. `row`/`col`
 *  are MODEL-GLOBAL — already global on a split-table fragment (do NOT re-add first_row). `text` is the
 *  cell's current plain text (multi-paragraph cells joined by "\n"), used for the chip snippet label. */
/** One step of a descending CellPath (issue 064 Tier-2) — mirrors hwp-session `CellAddrDto`. */
export interface CellAddr {
  block: number;
  row: number;
  col: number;
}

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
  /** True when the resolved LEAF cell holds a FURTHER nested table (issue 064). With Tier-2 a nested cell
   *  is editable (via `path`), so this no longer gates the editor. */
  nested: boolean;
  /** The DESCENDING CellPath to this (possibly nested) cell (issue 064 Tier-2). Length-1 = the flat
   *  `(section, block, row, col)` leaf → back-compat for a non-nested doc. */
  path: CellAddr[];
}

/** Cell-addressed caret rect (issue 053) — own-render px + the 0-based page the owning table fragment
 *  landed on. Mirrors hwp-session `CellCaretDto`. */
export interface CellCaretRect {
  page: number;
  x: number;
  top: number;
  height: number;
}

/** A click resolved to a TABLE-CELL text caret target (issue 053) — the cell-addressed twin of the
 *  NodeId caret. `row`/`col` are MODEL-GLOBAL; `para`/`offset` live in the editor "\n"-split space
 *  (the same space `blockRuns` joins and `SetTableCellRuns` splits). Mirrors hwp-session
 *  `CellTextHitDto`. */
export interface CellTextHit {
  section: number;
  block: number;
  /** Flat leaf coords for a depth-1 hit. Omitted on a nested hit (issue #48 R2). */
  row?: number;
  col?: number;
  para: number;
  offset: number;
  para_len: number;
  caret: CellCaretRect;
  /** Descending CellPath for a nested leaf. Omitted on depth-1 (issue #48 A2). */
  path?: CellAddr[];
}

/** Body-paragraph caret rect — own-render px. `w` is always 0 (a document insertion boundary); the
 *  host chooses the visible device-pixel stroke. `page` disambiguates a paragraph split across pages.
 *  Mirrors hwp-session `BodyCaretDto`. */
export interface BodyCaretRect {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A click resolved to an editable top-level BODY paragraph. `offset`/`para_len` are Unicode-scalar
 *  counts in the same model text space `SetParagraphRuns` edits. `caret` has PAGE-LOCAL visual
 *  affinity, so a wrapped line-end click stays on the clicked upstream line; `bodyCaretRect` uses
 *  canonical downstream affinity for that same address boundary. */
export interface BodyTextHit {
  section: number;
  block: number;
  offset: number;
  para_len: number;
  caret: BodyCaretRect;
}

/** One heading in the document outline (issue 046): where it lives in the model (`section`/`block`), its
 *  `level` (1 = □/■ section label, 2 = numbered section-band table), the heading `text`, and the 0-based
 *  `page` it starts on. Mirrors hwp-session `OutlineItem`. */
export interface OutlineItem {
  section: number;
  block: number;
  level: number;
  text: string;
  page: number;
}

/** One detected heading for the document profile (issue 067) — `outline` WITHOUT the page number
 *  (the profile is a pure model read; `[s/b]` anchors are the edit currency). Mirrors hwp-session
 *  `ProfileHeading`. */
export interface ProfileHeading {
  section: number;
  block: number;
  level: number;
  text: string;
}

/** One table's inventory line for the document profile (issue 067): model address + shape + first-row
 *  (header) cell texts. `(section, block)` are the SAME addresses `tableGrid`/`SetTableCell` target.
 *  Mirrors hwp-session `ProfileTable`. */
export interface ProfileTable {
  section: number;
  block: number;
  rows: number;
  cols: number;
  header: string[];
}

/** The deterministic document profile (issue 067): title candidate + structure counts + headings +
 *  table inventory + a structure-preserving body excerpt — the chat doc-context's "what IS this
 *  document" grounding, computed by pure model walks (no typeset, ZERO LLM calls). Counts include
 *  NESTED content (cell blocks). Mirrors hwp-session `DocProfileDto`. */
export interface DocProfile {
  title: string | null;
  sections: number;
  paragraph_count: number;
  table_count: number;
  image_count: number;
  chart_count: number;
  equation_count: number;
  headings: ProfileHeading[];
  /** The first 20 top-level tables (AI context budget). */
  tables: ProfileTable[];
  /** #441 — more top-level tables exist than `tables` lists; `tableBlocks()` lists them all. */
  tables_truncated: boolean;
  excerpt: string;
}

/** #441 — one top-level table block: address + shape (`tableBlocks()`). */
export interface TableBlock {
  section: number;
  block: number;
  rows: number;
  cols: number;
}

/** One ACTIVE (uncovered) cell of a table's grid (issue 066): its MODEL-GLOBAL `(row, col)` + current
 *  plain text. Mirrors hwp-session `GridCellDto`. */
export interface GridCell {
  row: number;
  col: number;
  text: string;
  /** #441 — merge extent (1 = not merged). */
  row_span: number;
  col_span: number;
  /** #441 — cell background `#RRGGBB`, `null` when none. */
  fill: string | null;
  /** #441 — stored cell width in HWPUNIT, `null` when unknown. */
  width: number | null;
}

/** The cell grid of a table block (issue 066) — its `rows`×`cols` plus every ACTIVE cell's address +
 *  text, the doc-context source for vibe table editing. Coordinates are the SAME `(row, col)`
 *  `SetTableCell` writes (`edit_target` inner table). Mirrors hwp-session `TableGridDto`. */
export interface TableGrid {
  section: number;
  block: number;
  rows: number;
  cols: number;
  cells: GridCell[];
  /** #441 — per-column widths in HWPUNIT (`cols` entries), empty when unknown. */
  col_widths: number[];
}

/** Per-cell fit / overflow report (#347). Lengths are own-render px (HWPUNIT ÷ 75). */
export interface CellFit {
  row: number;
  col: number;
  row_span: number;
  col_span: number;
  /** 0-based page of the fragment that draws the cell's text. */
  page: number;
  /** Drawn cell box. */
  width: number;
  height: number;
  /** Box width minus the cell's horizontal inner margins (the text wrap width). */
  text_width: number;
  /** Height the content may use (`height` − the vertical cell inset). */
  available_height: number;
  /** Laid-out height of the current content. */
  content_height: number;
  /** Laid-out lines of the current content. */
  lines: number;
  /** One line's advance in the cell's first-paragraph style. */
  line_advance: number;
  /** Lines of that style that fit in `available_height`. */
  line_capacity: number;
  /** Full-width (한글) characters per line in that style at `text_width` (real line breaker). */
  chars_per_line: number;
  /** Fixed-height rows (HWPX `noAdjust="1"`): the row never grows; overflow is clipped. */
  fixed: boolean;
  /** `content_height > available_height`. */
  overflow: boolean;
}

/** Per-page body usage (#347), own-render px. */
export interface PageUsage {
  page: number;
  /** Page height minus top/bottom margins. */
  body_height: number;
  /** Body top → lowest placed block on the page (0 when the page has none). */
  used_height: number;
}

/** Page geometry in own-render px (= HWPUNIT/75): page box + printable-area margins, for the ruler
 *  (issue 027). Mirrors hwp-session `PageGeom`. */
export interface PageGeom {
  w: number;
  h: number;
  ml: number;
  mt: number;
  mr: number;
  mb: number;
}

/** A STYLED text run (Intent schema v0 `RunSpec`) — the shape `blockRuns` returns AND
 *  `SetTableCellRuns`/`SetParagraphRuns` accept (run-format preservation, issue 027). Style fields are
 *  optional (unset = inherit); a multi-paragraph cell joins its paragraphs with a `{text:"\n"}` run. */
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

/** `toHwpx` options. `hwpRowHeights` (tables that came from a binary `.hwp` only — HWPX-input tables
 *  always keep their own `noAdjust`):
 *  - `"exact"` (default, 0.0.6+): `noAdjust="1"` — rows keep the `.hwp`'s saved heights, so the page
 *    count round-trips; text filled beyond a row's height is clipped in Hancom.
 *  - `"auto"`: `noAdjust="0"` — rows grow with their content in Hancom (pre-0.0.6 behaviour). Use when
 *    filling a `.hwp` form with generated content. */
export interface HwpxExportOptions {
  hwpRowHeights?: 'exact' | 'auto';
}

/** Result of `applyIntents` (#350). `pages` is the page count after the single reflow. With options
 *  (#371) the result also says whether the document `changed` and whether the batch `joined` (extended)
 *  the previous undo unit. */
export interface BatchOutcome {
  kind: 'Batch';
  applied: number;
  pages: number;
  changed?: boolean;
  joined?: boolean;
}

/** `applyIntents` options (#371 · #369). Unknown keys are refused. */
export interface BatchOptions {
  /** All-or-nothing + ONE undo unit. On failure the document and undo/redo stacks are unchanged. */
  atomic?: boolean;
  /** Atomic only: recorded on the batch's undo unit; a later batch with the same key extends it. */
  coalesceKey?: string;
  /** Allow extending the previous unit with the same `coalesceKey` (default true when a key is given). */
  coalesce?: boolean;
}

/** What the undo stack holds (#372). `bytes` is an estimate. */
export interface UndoStats {
  snapshots: number;
  bytes: number;
}

/** Tagged result of applyIntent (Intent schema v0). `kind` discriminates the payload. */
export type Outcome =
  | { kind: 'opened'; format: string; editable: boolean; sections: number }
  | { kind: 'pageCount'; pages: number }
  | { kind: 'rendered'; svg: string }
  | { kind: 'applied'; blocks: number; ops: number }
  | { kind: 'exported'; bytes: number; openSafe: boolean }
  | { kind: 'undone'; changed: boolean }
  | { kind: 'redone'; changed: boolean }
  | { kind: 'text'; text: string }
  | { kind: 'proposed'; rationale: string; preview: string }
  | { kind: 'committed'; ops: number }
  | { kind: 'discarded'; discarded: boolean }
  | { kind: 'found'; matches: unknown[] }
  | { kind: 'replaced'; replaced: number; pages: number }
  | { kind: 'hit'; hit: BlockHit | null }
  | { kind: 'caret'; caret: unknown | null }
  | { kind: 'edited'; pages: number }
  | { kind: 'hitCell'; hit: CellTextHit | null }
  | { kind: 'caretCell'; caret: CellCaretRect | null }
  | { kind: 'hitBody'; hit: BodyTextHit | null }
  | { kind: 'caretBody'; caret: BodyCaretRect | null };

/** An engine error carries a machine-readable `code` alongside the message. */
export interface EngineError extends Error {
  code:
    | 'no_document'
    | 'bad_intent'
    | 'bad_intent_version'
    | 'bad_json'
    | 'needs_rhwp'
    | 'out_of_range'
    | 'font_missing'
    | 'ttc_unsupported'
    | 'serialize'
    | 'engine'
    | 'wasm_trap'
    | 'dead_handle';
}

/** A safe handle to one open document. Every method is trap-guarded (see resetEngine). */
export class HwpDoc {
  private constructor();
  /** Open a `.hwp` (needs the hwp5/rhwp build) or `.hwpx` from bytes. `name` seeds the title. */
  static open(bytes: Uint8Array | ArrayBuffer, name?: string): HwpDoc;
  pageCount(): number;
  /** Layout-cache diagnostics (issue 025): number of real re-typesets vs cache hits since open. */
  placedStats(): { placeBuilds: number; placeHits: number; revision: number; fonts: number };
  /** UNTRUSTED SVG string — never innerHTML raw; prefer renderPageSvgSanitized / sanitizeSvg (R7). */
  renderPageSvg(n: number): string;
  renderPageSvgSanitized(n: number): string;
  /** Toggle "레이아웃 정리" (layout normalization). Default OFF = FAITHFUL render. ON recovers a lossy
   *  hwp→hwpx conversion's inflated line-spacing (Hancom "save as .hwpx" collapses body paragraphs onto
   *  the 160% default; this pulls them back to ~130%). RENDER-IR only — round-trip bytes untouched.
   *  ⚠️ Re-paginates — re-query `pageCount()` and re-render every page after calling. Returns a JSON
   *  report string `{on,applied,loosePct,targetPct,paragraphsTouched,total}`. */
  setNormalize(on: boolean): string;
  /** Whether "레이아웃 정리" is currently ON. */
  normalizeActive(): boolean;
  hitTest(page: number, x: number, y: number): BlockHit | null;
  tableAt(page: number, x: number, y: number): TableBox | null;
  /** ANCHORED IMAGE under (x,y) in own-render px for click-select + the 8-handle overlay (issue 049) — the
   *  topmost image's own box + `(section, block)` anchor; null on a miss. Distinct from `hitTest` (which
   *  returns the paragraph band that holds the image). */
  imageAt(page: number, x: number, y: number): ImageBox | null;
  /** Placed box of the image anchored at `(section, block)` on `page` (issue 049) — for re-placing the
   *  overlay + apply-verifying a move/resize commit; null when that image isn't on the page. */
  imageBbox(page: number, section: number, block: number): ImageBox | null;
  /** Table CELL under (x,y) in own-render px for cell-level marking (issue 023); null on a miss. */
  tableCellAt(page: number, x: number, y: number): CellHit | null;
  /** Cell-addressed caret, hit half (issue 053): the TABLE-CELL text caret target under (x,y) in
   *  own-render px, or `null` off any cell text (018). Geometry = the cached own-render placement (the
   *  same the visible SVG drew), so it answers on binary .hwp too and never drifts from the screen. */
  cellTextHit(page: number, x: number, y: number): CellTextHit | null;
  /** Cell-addressed caret, geometry half (issue 053): the caret rect at char `offset` of the `para`-th
   *  editor paragraph of cell `(row, col)` of the table block at `(section, block)` — own-render px +
   *  the OWNING page, or `null` when the address doesn't resolve (018). A PAST-END `offset` CLAMPS to
   *  the paragraph end (a rect, never null). */
  cellCaretRect(section: number, block: number, row: number, col: number, para: number, offset: number): CellCaretRect | null;
  /** Path-addressed twin of `cellCaretRect` (issue #48). Length-1 is the flat 053 lane. */
  cellCaretRectPath(section: number, path: CellAddr[], para: number, offset: number): CellCaretRect | null;
  /** Body-paragraph caret, hit half: resolves a page-local own-render px click to the editable
   *  `(section, block, offset)` target, or `null` outside a body paragraph (018). Geometry consumes the
   *  cached PlacedGlyph stream directly; it does not parse SVG markup or use rhwp coordinates. */
  bodyTextHit(page: number, x: number, y: number): BodyTextHit | null;
  /** Body-paragraph caret, geometry half: zero-width own-render px rect for `offset` in
   *  `(section, block)` on `page`. Past-end clamps; a split paragraph queried on the wrong page is
   *  `null` (018). */
  bodyCaretRect(page: number, section: number, block: number, offset: number): BodyCaretRect | null;
  /** Marquee select: every top-level block whose band intersects the own-render px rect
   *  `(x0,y0)-(x1,y1)` (corners in any order). Empty array on a miss (never null). */
  blocksInRect(page: number, x0: number, y0: number, x1: number, y1: number): BlockHit[];
  /** Column-boundary x-positions (own-render px) of the table at `(section, block)` on `page` — a
   *  `number[]` of `cols + 1` absolute px for the column-resize handles (issue 027); `null` off-page. */
  tableColBoundaries(page: number, section: number, block: number): number[] | null;
  /** Row-boundary y-positions (own-render px) of the table at `(section, block)` on `page` — a
   *  `number[]` of `rows + 1` absolute px for the ROW-height resize handles (issue 031); `null` off-page.
   *  A SPLIT table returns the per-page FRAGMENT's boundaries (rebased to the fragment top — 023 규칙). */
  tableRowBoundaries(page: number, section: number, block: number): number[] | null;
  /** Per-cell fit / overflow report (#347) of the table at `(section, block)`, or `null` when the block
   *  is not a placed table. On a `fixed` table an `overflow` cell is clipped (as in Hancom) — re-write it
   *  to at most `line_capacity` lines × `chars_per_line` 한글. */
  tableCellFits(section: number, block: number): CellFit[] | null;
  /** Per-page body usage (#347): how full each page's body is. */
  pageUsage(): PageUsage[];
  /** Page geometry (own-render px) for the ruler (issue 027); `null` when the page is out of range. */
  pageGeometry(page: number): PageGeom | null;
  /** The CURRENT styled runs of the `(row,col)` cell of the table at `(section,block)`, or of the
   *  paragraph at `(section,block)` when `row`/`col` are omitted — read to PRESERVE run styling on a
   *  plain-text edit (issue 027). Multi-paragraph cells join with a `{text:"\n"}` run. */
  blockRuns(section: number, block: number, row?: number | null, col?: number | null): RunSpec[];
  /** The CURRENT styled runs of a (possibly NESTED) cell by its descending CellPath (issue 064 Tier-2) —
   *  the nested-cell twin of `blockRuns`, so the inline editor prefills a nested LEAF cell. */
  blockRunsPath(section: number, path: CellAddr[]): RunSpec[];
  /** The cell GRID of the table block at `(section, block)` (issue 066) — `{rows, cols, cells}` with
   *  every ACTIVE cell's MODEL `(row, col)` + current text, or `null` when the block isn't a table.
   *  The vibe-editing doc-context source; coordinates are the SAME `(row, col)` `SetTableCell` writes. */
  tableGrid(section: number, block: number): TableGrid | null;
  /** Document outline (issue 046) — the top-level headings each with `{section, block, level, text,
   *  page}`. Returns an EMPTY ARRAY when the document has no detected heading (caller falls back to a
   *  page list). The SAME heading source the desktop `doc_outline` command uses. */
  outline(): OutlineItem[];
  /** The deterministic document profile (issue 067) — title candidate + structure counts + headings +
   *  table inventory + body excerpt, for the chat doc-context. Pure model read (no typeset, no LLM). */
  docProfile(): DocProfile;
  /** #441 — every top-level table block, no cap (see `DocProfile.tables_truncated`). */
  tableBlocks(): TableBlock[];
  applyIntent(intent: object | string): Outcome;
  /** Apply MANY intents with ONE reflow (#350): same op-bus, one undo unit per intent, but the
   *  whole-document re-typeset `applyIntent` does per edit runs once. Not atomic — throws
   *  `{code:"batch_failed", message:"intent[i]: …"}` at the first failure; earlier edits stay applied.
   *  With `{ atomic: true }` (#371) the batch is all-or-nothing and ONE undo unit; `coalesceKey` (#369)
   *  lets consecutive atomic batches share one undo unit. */
  applyIntents(intents: Array<object | string>, options?: BatchOptions): BatchOutcome;
  /** Undo depth (snapshots) + byte budget of this document (#372). `0` = unbounded. Defaults 50 · 128 MiB. */
  setUndoLimits(depth: number, budgetBytes?: number): void;
  /** What the undo stack holds now (#372). */
  undoStats(): UndoStats;
  undo(): boolean;
  redo(): boolean;
  /** Inject a single-face TTF/OTF font (R8 — fonts are never bundled). Used for BOTH the layout
   *  metrics AND the PDF embed (issue 022): the SAME bytes drive screen SVG, pagination and PDF.
   *  ⚠️ Registering (or replacing) a font RE-LAYOUTS the document — `renderPageSvg` output and the
   *  page count can change — so re-query `pageCount()` and re-render every page after calling this.
   *  Throws `{code:"ttc_unsupported"}` for a TTC collection (single TTF/OTF only). */
  registerFont(family: string, bytes: Uint8Array | ArrayBuffer): void;
  /** Throws {code:"font_missing"} if no font registered. See README for the wasm glyph-embedding note. */
  exportPdf(): Uint8Array;
  exportHtml(): string;
  /** HWPX bytes. `hwpRowHeights` only affects tables from a binary `.hwp` (see `HwpxExportOptions`). */
  toHwpx(options?: HwpxExportOptions): Uint8Array;
  /** Free the wasm allocation on document swap (R13). Idempotent. */
  free(): void;
}

declare const _default: {
  initEngine: typeof initEngine;
  resetEngine: typeof resetEngine;
  initEngineSync: typeof initEngineSync;
  HwpDoc: typeof HwpDoc;
  sanitizeSvg: typeof sanitizeSvg;
  isTrapError: typeof isTrapError;
};
export default _default;
