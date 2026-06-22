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
  /** Live page count of the open document. */
  pageCount: () => invoke<number>("doc_page_count"),
  /** Apply template-conformant AI content JSON (one undo unit); returns the new page count. */
  applyContent: (content: string) => invoke<number>("apply_content", { content }),
  /** Serialize the edited document to a .hwpx path; returns a status line. */
  exportHwpx: (path: string) => invoke<string>("export_hwpx", { path }),
  /** Natural-language AI: a provider turns a prompt into content, dry-run; returns rationale+preview. */
  aiGenerate: (prompt: string) => invoke<string>("ai_generate", { prompt }),
  /** Vibe-docs chat-edit: the provider sees the doc as an anchored [s/b] outline and proposes
   *  TARGETED edits (insert table/image near an anchor, shade a column, …), dry-run into a pending
   *  proposal; returns rationale+preview. `commitProposal()` then applies it (one undo unit).
   *  `scope` is an optional click-resolved target the user pointed at (section, and block if known). */
  aiEdit: (instruction: string, scope?: { section: number; block: number | null }) =>
    invoke<string>("ai_edit_propose", {
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
    invoke<string>("propose_insert_image", {
      name,
      dataB64,
      scopeSection: scope?.section ?? null,
      scopeBlock: scope?.block ?? null,
      widthMm,
      heightMm,
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
};
