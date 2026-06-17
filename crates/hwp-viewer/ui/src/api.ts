import { invoke } from "@tauri-apps/api/core";

/// Typed bindings to the Rust `Intent` command lane (crates/hwp-viewer/src/lib.rs). No prose
/// parsing: each command returns a typed value the UI consumes directly.
export const api = {
  /** Open a .hwp/.hwpx; returns the page count. */
  openDoc: (path: string) => invoke<number>("open_doc", { path }),
  /** Render one page to SVG markup. */
  renderPage: (page: number) => invoke<string>("render_page", { page }),
  /** Live page count of the open document. */
  pageCount: () => invoke<number>("doc_page_count"),
  /** Apply template-conformant AI content JSON (one undo unit); returns the new page count. */
  applyContent: (content: string) => invoke<number>("apply_content", { content }),
  /** Serialize the edited document to a .hwpx path; returns a status line. */
  exportHwpx: (path: string) => invoke<string>("export_hwpx", { path }),
  /** Undo / redo the last edit; returns the new page count. */
  undo: () => invoke<number>("undo"),
  redo: () => invoke<number>("redo"),
};
