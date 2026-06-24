import { invoke } from "@tauri-apps/api/core";

/** Result of opening a document: page count + 2-tier capability (editable) + a format label.
 *  `convertedPath` is set when a binary .hwp was auto-converted to an editable .hwpx saved beside it. */
export type OpenResult = {
  pages: number;
  editable: boolean;
  format: string;
  convertedPath?: string | null;
};

/** One FIND hit. `node`/`start`/`len` are CHAR (Unicode-scalar) coordinates over the owning
 *  paragraph's concatenated run text; `section`/`block` index the doc for scroll-to. */
export type FindMatch = {
  node: number;
  start: number;
  len: number;
  section: number;
  block: number;
};

/** Result of a replace: occurrences replaced + the new page count (re-render after). */
export type ReplaceResult = { replaced: number; pages: number };

/** One op in an AI/deterministic edit proposal, structured for the per-op chat CARD: a machine
 *  `kind`, the human `summary` line, and the anchored `[section/block]` target when the op addresses
 *  one (block is null for section-level / append ops; both null for whole-doc ops). */
export type ProposalOp = {
  kind: string;
  summary: string;
  section: number | null;
  block: number | null;
};

/** A pending edit proposal (dry-run, held on the Rust session): the active provider (for the honest
 *  mock badge), a rationale prose line, and the structured ops. `commitProposal()` applies it. */
export type Proposal = {
  provider: string;
  rationale: string;
  ops: ProposalOp[];
};

/** WYSIWYG caret — the editable model target a click resolved to. `node`/`block` are null for a
 *  table-cell run or a doc without NodeIds (an unedited binary .hwp): geometry is available, the
 *  editable target is not. `offset` is the caret position in PARAGRAPH chars (Unicode scalars). */
export type HitTarget = {
  node: number | null;
  block: number | null;
  offset: number;
  section: number;
  paraOrd: number;
  inCell: boolean;
  /** Editable char length of the resolved paragraph — the UI clamps caret moves to it. */
  paraLen: number;
};

/** WYSIWYG caret — a caret rectangle in page (unscaled) coordinates. Scale by the SVG zoom factor. */
export type CaretRect = { x: number; top: number; height: number };

/** An anchored image's placed box in own-engine PAGE (unscaled HWPUNIT) coordinates + its model
 *  anchor `(section, block)`. The move/resize overlay draws its 8 handles over `x/y/w/h` (scaled by
 *  the same SVG zoom factor the caret uses) and commits via `setImageSize`/`moveImage`. */
export type ImageBox = { x: number; y: number; w: number; h: number; section: number; block: number };

/** A placed table's OUTER box in own-engine PAGE (unscaled HWPUNIT) coordinates + its model anchor
 *  `(section, block)`. The drag-to-move overlay draws the grab handle / drop indicator over `x/y/w/h`
 *  (scaled by the same SVG zoom the image overlay uses) and commits via `moveTable`. */
export type TableBox = {
  x: number;
  y: number;
  w: number;
  h: number;
  section: number;
  block: number;
  rows: number;
  cols: number;
};

/** One document-outline heading: model anchor `(section, block)`, a heuristic `level`, the heading
 *  `text`, and the 0-based `page` it starts on (for click-to-scroll in the outline panel). */
export type OutlineItem = { section: number; block: number; level: number; text: string; page: number };

/** The top-level block the user POINTED at on the own-render surface: its `(section, block)` anchor, a
 *  label `kind` ("paragraph"/"table"/"image"), and its band box in own-engine PAGE units (`x/y/w/h`) so
 *  the UI can draw a pin/highlight over exactly what was pointed at. The own-render counterpart to a
 *  `HitTarget`, resolving paragraphs too (so a click sets an AI scope / insert target there). */
export type BlockHit = { section: number; block: number; kind: string; x: number; y: number; w: number; h: number; text: string };

/** The table CELL the user double-clicked (own-render): the table anchor `(section, block)`, the cell
 *  `(row, col)`, the table's `(rows, cols)`, and the cell's CURRENT text — so the cell editor opens
 *  pre-filled for that exact cell ("표에 내용 작성" by pointing at the cell). */
export type CellHit = { section: number; block: number; row: number; col: number; rows: number; cols: number; text: string; x: number; y: number; w: number; h: number };

/// Typed bindings to the Rust `Intent` command lane (crates/hwp-viewer/src/lib.rs). No prose
/// parsing: each command returns a typed value the UI consumes directly.
export const api = {
  /** Open a .hwp/.hwpx; returns page count + capability. */
  openDoc: (path: string) => invoke<OpenResult>("open_doc", { path }),
  /** Render one page to SVG markup (rhwp — faithful layout-preserve view of the original). */
  renderPage: (page: number) => invoke<string>("render_page", { page }),
  /** Render the WHOLE live doc through the JSX/CSS→HTML path (the pivot view; shows edits cleanly,
   *  matches export). Returned as one self-contained HTML document for an <iframe srcDoc>. */
  renderDocHtml: () => invoke<string>("render_doc_html"),
  /** Render ONE page to SVG through OUR OWN engine (자체 렌더 — place_doc → paint IR → SvgSink). The
   *  self-owned faithful render; unlike `renderPage` (rhwp) it regenerates from the live IR so edits
   *  show too. Same path as the CLI `own-render`. */
  renderOwnPage: (page: number) => invoke<string>("render_own_page", { page }),
  /** Page count of the live doc as paginated by OUR OWN engine (drives the 자체 렌더 page list). */
  ownPageCount: () => invoke<number>("own_page_count"),
  /** Live page count of the open document. */
  pageCount: () => invoke<number>("doc_page_count"),
  /** Document outline (□ labels + numbered section bands) with the page each starts on. */
  docOutline: () => invoke<OutlineItem[]>("doc_outline"),
  /** Apply template-conformant AI content JSON (one undo unit); returns the new page count. */
  applyContent: (content: string) => invoke<number>("apply_content", { content }),
  /** Serialize the edited document to a .hwpx path; returns a status line. */
  exportHwpx: (path: string) => invoke<string>("export_hwpx", { path }),
  /** Export the live doc to a self-contained HTML file (JSX/CSS → emit_html — matches the HTML
   *  preview byte-for-byte). Returns a status line. */
  exportHtml: (path: string) => invoke<string>("export_doc_html", { path }),
  /** Export the live doc to a PDF file through OUR OWN engine (place_doc → paint IR → krilla —
   *  matches 자체 렌더, NOT a browser print). Throws an actionable error if the build lacks
   *  `--features pdf`. Returns a status line. */
  exportPdf: (path: string) => invoke<string>("export_doc_pdf", { path }),
  /** Natural-language AI: a provider turns a prompt into content, dry-run; returns rationale+preview. */
  aiGenerate: (prompt: string) => invoke<string>("ai_generate", { prompt }),
  /** Vibe-docs chat-edit: the provider sees the doc as an anchored [s/b] outline and proposes
   *  TARGETED edits (insert table/image near an anchor, shade a column, …), dry-run into a pending
   *  proposal; returns rationale+preview. `commitProposal()` then applies it (one undo unit).
   *  `scope` is an optional click-resolved target the user pointed at (section, and block if known). */
  aiEdit: (instruction: string, scope?: { section: number; block: number | null }) =>
    invoke<Proposal>("ai_edit_propose", {
      instruction,
      scopeSection: scope?.section ?? null,
      scopeBlock: scope?.block ?? null,
    }),
  /** Active AI provider name ("anthropic"/"ollama"/"openrouter"/"mock"/"none") — for an honest badge. */
  aiProviderName: () => invoke<string>("ai_provider_name"),
  /** Insert a chat-attached image (base64) at the pointed target — deterministic, NO provider needed.
   *  Dry-run into a pending proposal; `commitProposal()` applies it. `widthMm`/`heightMm` from aspect. */
  insertImage: (
    name: string,
    dataB64: string,
    scope: { section: number; block: number | null } | null,
    widthMm: number,
    heightMm: number,
  ) =>
    invoke<Proposal>("propose_insert_image", {
      name,
      dataB64,
      scopeSection: scope?.section ?? null,
      scopeBlock: scope?.block ?? null,
      widthMm,
      heightMm,
    }),
  /** DIRECT-MANIPULATION image insert: a native OS file DROP onto a page. Rust reads the dropped
   *  file's bytes from `srcPath` (a native drop gives a path, not bytes) and COMMITS one undoable op
   *  IMMEDIATELY (no propose→review) at the hit-tested target. Returns the new page count (re-render
   *  after). `scope` is the resolved target (insert AFTER that block, else section/doc end). */
  applyImageDrop: (
    srcPath: string,
    scope: { section: number; block: number | null } | null,
    widthMm?: number,
    heightMm?: number,
  ) =>
    invoke<number>("apply_insert_image", {
      name: srcPath,
      srcPath,
      dataB64: null,
      scopeSection: scope?.section ?? null,
      scopeBlock: scope?.block ?? null,
      widthMm: widthMm ?? null,
      heightMm: heightMm ?? null,
    }),
  /** Dry-run hand-authored content JSON into a preview without mutating the doc (advanced). */
  propose: (content: string) => invoke<string>("propose", { content }),
  /** Commit the pending proposal (one undo unit); returns the new page count. */
  commitProposal: () => invoke<number>("commit_proposal"),
  /** Drop the pending proposal. */
  discardProposal: () => invoke<void>("discard_proposal"),
  /** Undo / redo the last edit; returns the new page count. */
  undo: () => invoke<number>("undo"),
  redo: () => invoke<number>("redo"),
  /** Find occurrences in editable simple paragraphs (read-only). Default: case-insensitive, not whole-word. */
  findText: (query: string, caseSensitive = false, wholeWord = false) =>
    invoke<FindMatch[]>("find_text", { query, caseSensitive, wholeWord }),
  /** Replace query→replacement as ONE undo unit. `all=false` replaces the first match only. */
  replaceText: (
    query: string,
    replacement: string,
    caseSensitive = false,
    wholeWord = false,
    all = false,
  ) => invoke<ReplaceResult>("replace_text", { query, replacement, caseSensitive, wholeWord, all }),
  /** WYSIWYG caret (engine half) — map a page-space click to an editable model target (null = off any
   *  text line). The interactive caret/selection/IME layer is built on top of this. */
  hitTest: (page: number, x: number, y: number) =>
    invoke<HitTarget | null>("hit_test", { page, x, y }),
  /** WYSIWYG caret (engine half) — map a model target (NodeId + paragraph char offset) to a caret
   *  rectangle on `page` (null if the paragraph doesn't render on that page). */
  caretRect: (page: number, node: number, offset: number) =>
    invoke<CaretRect | null>("caret_rect", { page, node, offset }),
  /** Interactive caret — insert `text` at a char-offset caret inside one simple paragraph as ONE
   *  undo unit (per-keystroke / IME-commit). Returns the new page count (re-render after). Rejects
   *  (throws the op-bus message) when the target paragraph is structural / the offset is out of
   *  range — the caller should toast it, not crash. */
  insertText: (node: number, offset: number, text: string) =>
    invoke<number>("insert_text", { node, offset, text }),
  /** Interactive caret — delete the single char ENDING at `offset` (Backspace) as ONE undo unit.
   *  `offset === 0` is a no-op. Returns the new page count. */
  deleteBack: (node: number, offset: number) =>
    invoke<number>("delete_back", { node, offset }),
  /** Image overlay (own-render only) — locate the placed box of the image anchored at
   *  `(section, block)` on `page`, in own-engine PAGE units (null if it doesn't fall on that page).
   *  Same geometry as the 자체 렌더 SVG, so the overlay handles align with what's drawn. */
  imageBbox: (page: number, section: number, block: number) =>
    invoke<ImageBox | null>("image_bbox", { page, section, block }),
  /** Image overlay (own-render only) — the topmost image under a page-space click `(x,y)` on `page`
   *  (with its `(section, block)` anchor), or null if the click misses every image. Click-to-select. */
  imageAt: (page: number, x: number, y: number) =>
    invoke<ImageBox | null>("image_at", { page, x, y }),
  /** Image overlay — resize the image anchored at `(section, block)` to `width`×`height` HWPUNIT as
   *  ONE undo unit (SetImageSize). The resize handle's pointerup commit. Returns the new page count. */
  setImageSize: (section: number, block: number, width: number, height: number) =>
    invoke<number>("set_image_size", { section, block, width, height }),
  /** Image overlay — move the image from block `from` to block `to` in `section` as ONE undo unit
   *  (DeleteBlock + InsertImageAt; size preserved). Returns the new page count. */
  moveImage: (section: number, from: number, to: number, width: number, height: number) =>
    invoke<number>("move_image", { section, from, to, width, height }),
  /** Table overlay (own-render only) — locate the outer box of the table anchored at
   *  `(section, block)` on `page`, in own-engine PAGE units (null if it doesn't fall on that page).
   *  Same geometry as the 자체 렌더 SVG, so the drag handle / drop indicator align with what's drawn. */
  tableBbox: (page: number, section: number, block: number) =>
    invoke<TableBox | null>("table_bbox", { page, section, block }),
  /** Table overlay (own-render only) — the topmost table under a page-space click `(x,y)` on `page`
   *  (with its `(section, block)` anchor), or null if the click misses every table. Hover-to-grab. */
  tableAt: (page: number, x: number, y: number) =>
    invoke<TableBox | null>("table_at", { page, x, y }),
  /** Point-to-block (own-render only) — the top-level block under a page-space click `(x,y)` on `page`,
   *  resolving PARAGRAPHS too (unlike `imageAt`/`tableAt`). Powers click-to-scope / point-to-insert so
   *  edits land at what the user pointed at, not the document end. Null only if the page has no blocks. */
  ownHitTest: (page: number, x: number, y: number) =>
    invoke<BlockHit | null>("own_hit_test", { page, x, y }),
  /** Point-to-cell (own-render only) — the table cell under a page-space double-click, with its current
   *  text, so the cell editor opens pre-filled for that exact cell. Null if not over a table cell. */
  tableCellAt: (page: number, x: number, y: number) =>
    invoke<CellHit | null>("table_cell_at", { page, x, y }),
  /** Table drag-to-move — relocate the block at `(section, from)` to index `to` as ONE undo unit
   *  (MoveBlock — works for tables and paragraphs). The drop commit. Returns the new page count. */
  moveTable: (section: number, from: number, to: number) =>
    invoke<number>("move_table", { section, from, to }),
  /** Table quick-edit — append `count` empty body rows at logical row `at` of the `index`-th table as
   *  ONE undo unit (TableInsertRows). `cols` = the table's column count. Returns the new page count. */
  tableAddRows: (section: number, index: number, at: number, count: number, cols: number) =>
    invoke<number>("table_add_rows", { section, index, at, count, cols }),
  /** Table "+행" — append ONE empty body row that REPLICATES the last row's column layout (merge-safe)
   *  as ONE undo unit (TableAppendEmptyRow). Returns the new page count. */
  appendTableRow: (section: number, index: number) =>
    invoke<number>("table_append_row", { section, index }),
  /** Inline edit — replace a SIMPLE paragraph's text (preserving its char/para shape) as ONE undo unit
   *  (SetParagraphText). Throws the op's refusal (structural paragraph) for the UI to toast. */
  setParagraphText: (section: number, block: number, text: string) =>
    invoke<number>("set_paragraph_text", { section, block, text }),
  /** Table quick-edit — replace the text of the cell at `(row, col)` of the `index`-th table as ONE
   *  undo unit (SetTableCell). Empty `text` clears the cell. Returns the new page count. */
  setTableCell: (section: number, index: number, row: number, col: number, text: string) =>
    invoke<number>("set_table_cell", { section, index, row, col, text }),
  /** Delete the block at `(section, index)` (e.g. 표 삭제) as ONE undo unit (DeleteBlock). Returns the
   *  new page count. */
  deleteBlock: (section: number, index: number) =>
    invoke<number>("delete_block", { section, index }),
};
