// Type definitions for @tf-hwp/engine (the safety-wrapped surface in index.js).
// The raw wasm-bindgen types live in ./pkg/hwp_wasm.d.ts.

/** Instantiate the wasm engine once. `input` is an optional wasm URL/Response/bytes (defaults to the
 *  co-located hwp_wasm_bg.wasm). Idempotent. Await this before HwpDoc.open. */
export function initEngine(input?: string | URL | Request | BufferSource | WebAssembly.Module): Promise<unknown>;

/** Re-instantiate after a wasm trap. Every previously-opened HwpDoc becomes dead; re-open documents. */
export function resetEngine(input?: string | URL | Request | BufferSource | WebAssembly.Module): Promise<unknown>;

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
  row: number;
  col: number;
  para: number;
  offset: number;
  para_len: number;
  caret: CellCaretRect;
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

/** One ACTIVE (uncovered) cell of a table's grid (issue 066): its MODEL-GLOBAL `(row, col)` + current
 *  plain text. Mirrors hwp-session `GridCellDto`. */
export interface GridCell {
  row: number;
  col: number;
  text: string;
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
  | { kind: 'caretCell'; caret: CellCaretRect | null };

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
  applyIntent(intent: object | string): Outcome;
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
  toHwpx(): Uint8Array;
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
