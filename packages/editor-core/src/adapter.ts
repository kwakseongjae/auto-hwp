import type { BlockHit, CaretRect, CellAddr, CellCaretRect, CellHit, CellTextHit, FindMatch, FindOptions, FindReplaceOptions, HitResult, ImageBox, Intent, NormalizeReport, OpenResult, Outcome, OutlineItem, PageGeom, ReplaceResult, RunSpec, TableBox, TableGrid } from "./types";

/// EngineAdapter — the backend seam (SDK-LAYERS L1↔L2). It abstracts the ACTUAL surface a backend
/// exposes (open / page SVG / hit-test·tableAt / applyIntent / undo·redo / export) so the SAME
/// editor-core (and any UI over it) runs against two backends: `WasmAdapter` (wraps @tf-hwp/engine, in
/// @tf-hwp/react) and a host `TauriAdapter` (reference impl). Every method is async so a Promise-based
/// Tauri `invoke` backend and the synchronous wasm backend both satisfy one interface.
///
/// This interface DESCENDED from @tf-hwp/react (issue 026) so editor-core depends only on the adapter,
/// not on React. @tf-hwp/react re-exports the type (hosts keep importing it from there).
///
/// R7 boundary: `pageSvg` returns a document-derived string that the ADAPTER may or may not have
/// sanitized. It is UNTRUSTED regardless — the UI layer ALWAYS routes it through `sanitizeSvg` before
/// injection. There is deliberately no method that injects an SVG string bypassing that gate.
///
/// Coordinate contract: `hitTest`/`tableAt`/`tableCellAt`/`blocksInRect` take PAGE-LOCAL px (own-render
/// px = HWPUNIT/75) and return boxes in the same space; the UI does the client-px ↔ page-px conversion.
export interface EngineAdapter {
  /** Open a document from bytes; resolves to page count + capability + format. */
  open(bytes: Uint8Array, name?: string): Promise<OpenResult>;

  /** Page count of the live document. */
  pageCount(): Promise<number>;

  /** UNTRUSTED, document-derived SVG markup for page `n`. The UI sanitizes before injecting. */
  pageSvg(page: number): Promise<string>;

  /** OPTIONAL — toggle "레이아웃 정리" (layout normalization). Default OFF = faithful render (exactly as
   *  the file specifies, how Hancom renders it). ON recovers a LOSSY hwp→hwpx conversion's inflated
   *  line-spacing (a Hancom "save as .hwpx" collapses body paragraphs onto the 160% default; this pulls
   *  them back to ~130%, approximating the original .hwp). RENDER-IR only — the round-trip bytes are
   *  untouched, so a save is verbatim either way. Resolves to a report so the UI can tell the user
   *  whether this document actually looked degraded. Backends that can't answer OMIT this (toggle
   *  hidden). Reference impl: `WasmAdapter` via the engine `setNormalize` binding. */
  setNormalize?(on: boolean): Promise<NormalizeReport>;

  /** Structural block under a PAGE-LOCAL px point, or null on a miss. */
  hitTest(page: number, x: number, y: number): Promise<BlockHit | null>;

  /** Placed table box under a PAGE-LOCAL px point (for marking), or null on a miss. */
  tableAt(page: number, x: number, y: number): Promise<TableBox | null>;

  /** OPTIONAL — the ANCHORED IMAGE under a PAGE-LOCAL px point (issue 049), or null on a miss. Returns the
   *  TOPMOST image's own placed box `{x,y,w,h}` + its `(section, block)` model anchor (own-render px), so
   *  the UI can draw the 8-handle move/resize overlay over exactly the image. Distinct from `hitTest` (which
   *  returns the paragraph BAND that holds the image, not the image's own rect). Backends that can't answer
   *  OMIT this — the caller then simply has no image overlay (018 null policy: a miss is null, never throw).
   *  Reference impls: `WasmAdapter` via the engine `imageAt` binding; `TauriAdapter` via `image_at`. */
  imageAt?(page: number, x: number, y: number): Promise<ImageBox | null>;

  /** OPTIONAL — the placed box of the image anchored at `(section, block)` on `page` (issue 049), or null
   *  when that image doesn't fall on the queried page. The overlay re-queries this AFTER a move/resize commit
   *  to RE-PLACE the handles on the moved image AND to APPLY-VERIFY the edit (적용-확인: the box must actually
   *  reflect the change). Own-render px. Backends that can't answer OMIT this (image overlay disabled). */
  imageBbox?(page: number, section: number, block: number): Promise<ImageBox | null>;

  /** OPTIONAL — the table CELL under a PAGE-LOCAL px point for cell-level marking (issue 023), or null
   *  on a miss (table border / merged-cell boundary → null; the caller falls back to the whole-table
   *  anchor). `row`/`col` are MODEL-GLOBAL. Backends that can't answer a cell query (e.g. the reference
   *  `TauriAdapter`) OMIT this method — the caller then marks at whole-table granularity (021 parity). */
  tableCellAt?(page: number, x: number, y: number): Promise<CellHit | null>;

  /** OPTIONAL — marquee (rubber-band) select: every top-level block whose band intersects the
   *  PAGE-LOCAL px rectangle `(x0,y0)-(x1,y1)` (corners in any order). Resolves to an EMPTY ARRAY on a
   *  miss (never null). Backends that can't answer (e.g. the reference `TauriAdapter`) OMIT this method;
   *  the caller then simply disables marquee selection (click/⌘-click still work). */
  blocksInRect?(page: number, x0: number, y0: number, x1: number, y1: number): Promise<BlockHit[]>;

  /** OPTIONAL — column-boundary x-positions (own-render PAGE px) of the table at `(section, block)` on
   *  `page`: `cols + 1` absolute px from the table's left to its right, for the column-resize handles
   *  (issue 027). Resolves to `null` when the table isn't on the page. Backends that can't answer (e.g.
   *  the reference `TauriAdapter`) OMIT this method — the caller then hides the column-resize handles. */
  tableColBoundaries?(page: number, section: number, block: number): Promise<number[] | null>;

  /** OPTIONAL — row-boundary y-positions (own-render PAGE px) of the table at `(section, block)` on
   *  `page`: `rows + 1` absolute px from the table's top to its bottom, for the ROW-height resize handles
   *  (issue 031). A SPLIT table returns the per-page FRAGMENT's boundaries (rebased to the fragment top —
   *  023). Resolves to `null` when the table isn't on the page. Backends that can't answer (e.g. the
   *  reference `TauriAdapter`) OMIT this method — the caller then hides the row-resize handles. */
  tableRowBoundaries?(page: number, section: number, block: number): Promise<number[] | null>;

  /** OPTIONAL — page geometry (own-render PAGE px): the page box + printable-area margins of `page`, for
   *  the ruler (issue 027). Resolves to `null` when the page is out of range. Backends that omit it →
   *  the caller hides the ruler's margin handles. */
  pageGeometry?(page: number): Promise<PageGeom | null>;

  /** OPTIONAL — the CURRENT styled runs of the `(row, col)` cell of the table at `(section, block)`, or
   *  of the paragraph at `(section, block)` when `row`/`col` are omitted (issue 027 §함정: run 서식 보존).
   *  The text-edit popover reads these so a plain-text edit INHERITS the existing run styling instead of
   *  flattening it. Resolves to `[]` when the target has no runs. Backends that omit it → the caller
   *  falls back to a single unstyled run (no preservation), never the plain-text `SetTableCell` variant. */
  blockRuns?(section: number, block: number, row?: number, col?: number): Promise<RunSpec[]>;

  /** OPTIONAL — the CURRENT styled runs of a (possibly NESTED) cell addressed by its descending CellPath
   *  (issue 064 Tier-2) — the nested-cell twin of `blockRuns`, so the inline editor prefills a nested LEAF
   *  cell's runs. `path` is the `CellHit.path` the engine returned (a length-1 path is the flat cell).
   *  Backends that omit it fall back to `blockRuns` for a length-1 path (no nested prefill). Reference
   *  impl: `WasmAdapter` via the engine `blockRunsPath` binding. */
  blockRunsPath?(section: number, path: CellAddr[]): Promise<RunSpec[]>;

  /** OPTIONAL — the cell GRID of the table block at `(section, block)` (issue 066): every ACTIVE cell's
   *  MODEL `(row, col)` + current text, so the chat doc-context can show the model a table's structure
   *  (which cells are labels, which are blank) — the fix for "표 채워줘 → intents 0" / 라벨 옆이 아닌 라벨
   *  칸을 겨냥하던 버그. Resolves to `null` when the block isn't a table (018 null policy — the caller then
   *  attaches no grid). Coordinates are the SAME `(row, col)` `SetTableCell` targets. Backends that can't
   *  answer OMIT this (the chat then falls back to the thin anchor-only context). Reference impl:
   *  `WasmAdapter` via the engine `tableGrid` binding. */
  tableGrid?(section: number, block: number): Promise<TableGrid | null>;

  /** OPTIONAL — WYSIWYG GLYPH caret (engine half). Map a PAGE-LOCAL px click to the editable model
   *  target + CHARACTER offset (`HitResult`), or `null` off any glyph (018 null policy — a miss is null,
   *  never a throw). This is the rhwp glyph-box path (char-precise `offset`/`para_len`), DISTINCT from
   *  `hitTest` (own-render BLOCK box, no char offset). `HitResult.node`/`block` are null for a table-cell
   *  run or an unanchored binary-.hwp paragraph — the caret geometry exists but there is no editable text
   *  target in v1 (docs/CARET-GAP.md). Backends without the rhwp glyph path (or a `--no-default-features`
   *  wasm build) OMIT this method — the caller then has no glyph text caret and falls back to marking. */
  hitTestText?(page: number, x: number, y: number): Promise<HitResult | null>;

  /** OPTIONAL — WYSIWYG GLYPH caret (geometry half). Map an editable target (`node` + paragraph char
   *  `offset`) to a caret rectangle in own-render PAGE px on `page`, or `null` when that paragraph does
   *  NOT render on the queried page (query the page it does). A PAST-END `offset` is CLAMPED to the
   *  paragraph end and returns a rect — NEVER null — so the caller must not read a null rect as
   *  "end of paragraph" (see `HitResult.para_len`). Backends that can't answer OMIT this method. */
  caretRect?(page: number, node: number, offset: number): Promise<CaretRect | null>;

  /** OPTIONAL — CELL-ADDRESSED caret, hit half (issue 053 — closes `hitTestText`'s `in_cell → node:null`
   *  gap). Map a PAGE-LOCAL px click to the TABLE-CELL text caret target under it (`CellTextHit`: cell
   *  address + editor-space `para`/`offset`/`para_len` + the caret rect), or `null` off any cell text
   *  (018 null policy — never a throw). Geometry is OWN-RENDER placement (the same the SVG drew), so it
   *  answers on binary .hwp too and never drifts from the screen. Backends that can't answer OMIT this —
   *  the caller then has no cell caret (cell marking / the double-click editor still work). Reference
   *  impls: `WasmAdapter` via the engine `cellTextHit` binding (placed cache + injected fonts);
   *  `TauriAdapter` via the `HitTestCell` Intent (the general apply_intent_json command). */
  hitTestCellText?(page: number, x: number, y: number): Promise<CellTextHit | null>;

  /** OPTIONAL — CELL-ADDRESSED caret, geometry half (issue 053). The caret rect at char `offset` of the
   *  `para`-th editor paragraph of cell `(row, col)` of the table block at `(section, block)` — own-render
   *  PAGE px + the OWNING page (`CellCaretRect.page`), or `null` when the address doesn't resolve (018).
   *  A PAST-END `offset` is CLAMPED to the paragraph end and returns a rect — NEVER null — so the caller
   *  must not read a null rect as "end of paragraph" (same contract as `caretRect`). Backends that can't
   *  answer OMIT this method (the cell caret feature is then off). */
  caretRectCell?(section: number, block: number, row: number, col: number, para: number, offset: number): Promise<CellCaretRect | null>;

  /** OPTIONAL — read-only search of the doc's editable simple paragraphs (issue 045). Returns the matches
   *  in reading order (char coords over each paragraph's concatenated run text), or `[]` on no hit. No
   *  mutation, no undo unit. Backends that can't answer OMIT this — `FindController` then reports the
   *  feature unsupported. Reference impls: `WasmAdapter` via the `Find` Intent (applyIntent JSON),
   *  `TauriAdapter` via the desktop `find_text` command (043 homomorphic-parity pattern). */
  find?(query: string, opts: FindOptions): Promise<FindMatch[]>;

  /** OPTIONAL — replace `query`→`replacement` as ONE undo unit (issue 045): `all: true` = every match,
   *  `all: false` = the FIRST match in the document (the engine's `do_replace` contract). Preserves run
   *  formatting (the op-bus rebuilds runs — never a plain-text collapse). Returns the count replaced +
   *  the live page count. Backends that omit `find` omit this too. Reference impls: `WasmAdapter` via the
   *  `Replace` Intent, `TauriAdapter` via the desktop `replace_text` command. */
  replace?(query: string, replacement: string, opts: FindReplaceOptions): Promise<ReplaceResult>;
  /** OPTIONAL — the document outline (issue 046): the top-level headings each with `{section, block,
   *  level, text, page}` for the left nav panel. Resolves to an EMPTY ARRAY when the document has no
   *  detected heading (never null — the caller falls back to a plain page list). Both real backends answer
   *  (WasmAdapter via the engine `outline()` binding; TauriAdapter via the `doc_outline` command) with the
   *  SAME shape; a backend that can't OMITS the method → the panel shows the page-list fallback. */
  outline?(): Promise<OutlineItem[]>;

  /** Apply an Intent (schema v0). One undo unit per accepted Intent. */
  applyIntent(intent: Intent): Promise<Outcome>;

  /** Undo / redo the last edit. Graceful no-op (resolves false) when the stack is empty. */
  undo(): Promise<boolean>;
  redo(): Promise<boolean>;

  /** Inject a TTF/OTF face for PDF export (R8 — fonts are never bundled). Required before exportPdf. */
  registerFont(family: string, bytes: Uint8Array): Promise<void>;

  /** Whether a font has been registered (drives the PDF button's guidance, not a hard gate). */
  hasFont(): boolean;

  /** Export the live doc to PDF. Rejects with an error whose `.code === "font_missing"` if no font
   *  was registered (the UI surfaces the "폰트를 먼저 주입하세요" guidance). */
  exportPdf(): Promise<Uint8Array>;

  /** Export the live doc to a self-contained HTML string. */
  exportHtml(): Promise<string>;

  /** Serialize the live doc to round-trip-safe HWPX bytes. */
  toHwpx(): Promise<Uint8Array>;

  /** Release backend resources (wasm allocation / session). Idempotent. Called on document swap. */
  dispose(): void;
}
