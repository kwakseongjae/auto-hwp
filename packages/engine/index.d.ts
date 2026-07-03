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

/** A table CELL hit for cell-level marking (own-render px space; issue 023); null on a miss. `row`/`col`
 *  are MODEL-GLOBAL — already global on a split-table fragment (do NOT re-add first_row). `text` is the
 *  cell's current plain text (multi-paragraph cells joined by "\n"), used for the chip snippet label. */
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
  | { kind: 'edited'; pages: number };

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
  hitTest(page: number, x: number, y: number): BlockHit | null;
  tableAt(page: number, x: number, y: number): TableBox | null;
  /** Table CELL under (x,y) in own-render px for cell-level marking (issue 023); null on a miss. */
  tableCellAt(page: number, x: number, y: number): CellHit | null;
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
};
export default _default;
