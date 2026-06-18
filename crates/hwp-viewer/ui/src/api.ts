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

/// Typed bindings to the Rust `Intent` command lane (crates/hwp-viewer/src/lib.rs). No prose
/// parsing: each command returns a typed value the UI consumes directly.
export const api = {
  /** Open a .hwp/.hwpx; returns page count + capability. */
  openDoc: (path: string) => invoke<OpenResult>("open_doc", { path }),
  /** Render one page to SVG markup. */
  renderPage: (page: number) => invoke<string>("render_page", { page }),
  /** Live page count of the open document. */
  pageCount: () => invoke<number>("doc_page_count"),
  /** Apply template-conformant AI content JSON (one undo unit); returns the new page count. */
  applyContent: (content: string) => invoke<number>("apply_content", { content }),
  /** Serialize the edited document to a .hwpx path; returns a status line. */
  exportHwpx: (path: string) => invoke<string>("export_hwpx", { path }),
  /** Natural-language AI: a provider turns a prompt into content, dry-run; returns rationale+preview. */
  aiGenerate: (prompt: string) => invoke<string>("ai_generate", { prompt }),
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
};
