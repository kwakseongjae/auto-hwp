import type { EngineAdapter } from "./EngineAdapter";
import type { BlockHit, CaretRect, CellHit, FindMatch, FindOptions, FindReplaceOptions, HitResult, Intent, OpenResult, Outcome, PageGeom, ReplaceResult, RunSpec, TableBox } from "./types";

/** The desktop `hit_test` command's DTO (camelCase, crates/hwp-viewer/src/lib.rs `HitDto`). Remapped
 *  into editor-core's snake_case `HitResult` below so both adapters return ONE shape. */
type TauriHitDto = {
  node: number | null;
  block: number | null;
  offset: number;
  section: number;
  paraOrd: number;
  inCell: boolean;
  paraLen: number;
};

/** The `invoke` surface (matches `@tauri-apps/api/core`'s `invoke`). Injected so this package has NO
 *  hard @tauri-apps dependency — the host passes its own `invoke`. */
export type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

export interface TauriAdapterOptions {
  /** The Tauri `invoke`. */
  invoke: Invoke;
  /** The desktop app opens documents by PATH (a native file dialog), not by bytes. The host supplies
   *  this to bridge the web `open(bytes)` seam — e.g. write the bytes to a temp file and return the
   *  path. Reference impl: the real app migration (issue 044) wires this to a Tauri command. */
  resolveOpenPath?: (bytes: Uint8Array, name?: string) => Promise<string>;
}

/// TauriAdapter — the DESKTOP backend for the shared @tf-hwp/react workspace (issue 043 convergence
/// prerequisite). It maps the whole `EngineAdapter` surface onto the desktop app's Tauri commands
/// (crates/hwp-viewer/src/lib.rs), routing through the SAME op-bus / hwp-session facade the `WasmAdapter`
/// uses — so `HwpWorkspace` runs against either backend with identical semantics + null policy (018).
///
/// Coordinate contract (§4.5): the geometry commands (`own_hit_test`/`table_at`/`table_cell_at`/
/// `blocks_in_rect`/`table_col_boundaries`/`table_row_boundaries`/`page_geometry`/`caret_rect`) speak
/// own-render PAGE px (= HWPUNIT/75) IN AND OUT — the exact space the wasm backend + the UI overlays use
/// (verified against hwp-session's px↔HWPUNIT boundary), so NO unit conversion happens in the adapter.
/// Edit Intents carry MODEL indices / HWPUNIT and are forwarded verbatim to the op-bus (which converts).
///
/// Two seams are DESKTOP-SPECIFIC (host chrome), documented not hidden:
///   • `open(bytes)` vs. the app's path-based `open_doc` — bridged by `resolveOpenPath` (a native file
///     dialog wraps opening; the workspace's `<input type=file>` is a web convenience).
///   • `registerFont` is a no-op + `hasFont()` is always true — the desktop renders with its native /
///     bundled font stack (no per-call byte injection like the fontless browser); PDF export subsets a
///     discovered Korean face natively. (Byte-injected own-render metrics on desktop = a 044 follow-up.)
export class TauriAdapter implements EngineAdapter {
  private invoke: Invoke;
  private resolveOpenPath?: (bytes: Uint8Array, name?: string) => Promise<string>;

  constructor(opts: TauriAdapterOptions) {
    this.invoke = opts.invoke;
    this.resolveOpenPath = opts.resolveOpenPath;
  }

  async open(bytes: Uint8Array, name?: string): Promise<OpenResult> {
    if (!this.resolveOpenPath) {
      throw new Error("TauriAdapter.open needs `resolveOpenPath` (the app opens by path, not bytes)");
    }
    const path = await this.resolveOpenPath(bytes, name);
    const r = await this.invoke<{ pages: number; editable: boolean; format: string }>("open_doc", { path });
    return { format: r.format, editable: r.editable, sections: 1, pages: r.pages };
  }

  pageCount(): Promise<number> {
    return this.invoke<number>("own_page_count");
  }

  pageSvg(page: number): Promise<string> {
    return this.invoke<string>("render_own_page", { page });
  }

  hitTest(page: number, x: number, y: number): Promise<BlockHit | null> {
    return this.invoke<BlockHit | null>("own_hit_test", { page, x, y });
  }

  tableAt(page: number, x: number, y: number): Promise<TableBox | null> {
    return this.invoke<TableBox | null>("table_at", { page, x, y });
  }

  /** Cell-level marking (issue 023) — the desktop `table_cell_at` (own-render px). Its `CellHitDto`
   *  matches `CellHit` verbatim (`row`/`col` MODEL-GLOBAL); `null` off any cell (table border / merged
   *  boundary → null, the caller falls back to whole-table). Same null policy as the wasm backend. */
  tableCellAt(page: number, x: number, y: number): Promise<CellHit | null> {
    return this.invoke<CellHit | null>("table_cell_at", { page, x, y });
  }

  /** Marquee select (issue 021) — the desktop `blocks_in_rect` (own-render px rect). Returns a
   *  `BlockHit[]`; the command yields an EMPTY array on a miss / out-of-range page (never null), matching
   *  the wasm backend's "[]"-on-miss policy — so the workspace enables marquee for this backend too. */
  blocksInRect(page: number, x0: number, y0: number, x1: number, y1: number): Promise<BlockHit[]> {
    return this.invoke<BlockHit[]>("blocks_in_rect", { page, x0, y0, x1, y1 });
  }

  /** Column-resize geometry (issue 027) — the desktop `table_col_boundaries`: `cols + 1` absolute px
   *  x's (own-render px), or `null` when the table isn't on `page`. */
  tableColBoundaries(page: number, section: number, block: number): Promise<number[] | null> {
    return this.invoke<number[] | null>("table_col_boundaries", { page, section, block });
  }

  /** Row-resize geometry (issue 031) — the desktop `table_row_boundaries`: `rows + 1` absolute px y's
   *  (own-render px), the per-page FRAGMENT's boundaries for a split table, or `null` when off `page`. */
  tableRowBoundaries(page: number, section: number, block: number): Promise<number[] | null> {
    return this.invoke<number[] | null>("table_row_boundaries", { page, section, block });
  }

  /** Ruler geometry (issue 027) — the desktop `page_geometry`: the page box + printable-area margins
   *  (own-render px), or `null` when `page` is out of range. Its `PageGeom` matches verbatim. */
  pageGeometry(page: number): Promise<PageGeom | null> {
    return this.invoke<PageGeom | null>("page_geometry", { page });
  }

  /** Run-style read for run-preserving edits (issue 027 §함정) — the desktop `get_block_runs`: the
   *  CURRENT styled runs of the `(row, col)` cell of the table at `(section, block)`, or of the paragraph
   *  when `row`/`col` are omitted. `RunDto` matches `RunSpec`. `row`/`col` are passed as `null` (→ the
   *  op-bus's paragraph target) when absent, mirroring the wasm binding's `row ?? null`. */
  blockRuns(section: number, block: number, row?: number, col?: number): Promise<RunSpec[]> {
    return this.invoke<RunSpec[]>("get_block_runs", { section, block, row: row ?? null, col: col ?? null });
  }

  /** WYSIWYG GLYPH caret (engine half) — the desktop `hit_test` command (crates/hwp-viewer, same rhwp
   *  glyph-box `Intent::HitTest` the wasm path uses). Returns `null` off any glyph (018 null policy).
   *  The command answers in camelCase; remap it to editor-core's snake_case `HitResult` so both
   *  backends return ONE shape. `node`/`block` are null for cell text / an unanchored .hwp paragraph. */
  async hitTestText(page: number, x: number, y: number): Promise<HitResult | null> {
    const r = await this.invoke<TauriHitDto | null>("hit_test", { page, x, y });
    if (!r) return null;
    return {
      node: r.node,
      block: r.block,
      offset: r.offset,
      section: r.section,
      para_ord: r.paraOrd,
      in_cell: r.inCell,
      para_len: r.paraLen,
    };
  }

  /** WYSIWYG GLYPH caret (geometry half) — the desktop `caret_rect` command. Its DTO already matches
   *  `CaretRect` ({x, top, height}); `null` when the paragraph isn't on `page` (a past-end offset is
   *  clamped by the engine, never null). */
  caretRect(page: number, node: number, offset: number): Promise<CaretRect | null> {
    return this.invoke<CaretRect | null>("caret_rect", { page, node, offset });
  }

  /** Find (issue 045) — the desktop `find_text` command (same op-bus `do_find` the wasm `Find` Intent
   *  uses, so identical matches). Its `FindMatchDto` (node/start/len/section/block) matches `FindMatch`
   *  verbatim — no remap. `caseSensitive`/`wholeWord` are the command's camelCase param keys. Read-only,
   *  no undo unit. */
  find(query: string, opts: FindOptions): Promise<FindMatch[]> {
    return this.invoke<FindMatch[]>("find_text", { query, caseSensitive: !!opts.caseSensitive, wholeWord: !!opts.wholeWord });
  }

  /** Replace (issue 045) — the desktop `replace_text` command, ONE undo unit (all=false → the first match
   *  in the doc). Its `ReplaceResult` ({replaced, pages}) matches editor-core's `ReplaceResult` verbatim.
   *  Same run-preserving op-bus core as the wasm `Replace` Intent (040 교훈: no plain-text collapse). */
  replace(query: string, replacement: string, opts: FindReplaceOptions): Promise<ReplaceResult> {
    return this.invoke<ReplaceResult>("replace_text", {
      query,
      replacement,
      caseSensitive: !!opts.caseSensitive,
      wholeWord: !!opts.wholeWord,
      all: !!opts.all,
    });
  }

  /** Apply one schema-v0 Intent through the desktop's GENERAL `apply_intent_json` command (issue 043) —
   *  the SAME op-bus (`hwp_mcp::apply_intent_json`) the wasm backend dispatches. The whole schema is
   *  covered (SetTableCellRuns / SetCellRangeFmt / ApplyContent / TableInsertRows / …), so no Intent
   *  silently no-ops; the command returns the `{kind, …}` Outcome (wasm-identical) and rejects with the
   *  typed op-bus error verbatim on a refused edit. */
  applyIntent(intent: Intent): Promise<Outcome> {
    return this.invoke<Outcome>("apply_intent_json", { intent });
  }

  async undo(): Promise<boolean> {
    await this.invoke<number>("undo");
    return true;
  }

  async redo(): Promise<boolean> {
    await this.invoke<number>("redo");
    return true;
  }

  async registerFont(_family: string, _bytes: Uint8Array): Promise<void> {
    // The desktop build renders with its native / bundled font stack; there is no per-call byte
    // injection command (unlike the fontless browser). Documented no-op — see the class header.
    // Params match the EngineAdapter contract (and WasmAdapter) even though nothing is injected.
  }

  hasFont(): boolean {
    return true; // native font stack is always available in the desktop shell
  }

  /** PDF export as BYTES via the desktop `export_pdf_bytes` (issue 043 — the byte twin of the app's
   *  path-based save). Tauri serializes the `Vec<u8>` as a number array; wrap it back into a Uint8Array
   *  so the workspace's `download()` gets the SAME shape the wasm backend returns. On a build without
   *  `--features pdf` the command rejects with an actionable message (the workspace toasts it). */
  async exportPdf(): Promise<Uint8Array> {
    return new Uint8Array(await this.invoke<number[]>("export_pdf_bytes"));
  }

  exportHtml(): Promise<string> {
    return this.invoke<string>("render_doc_html");
  }

  /** Round-trip-safe HWPX as BYTES via the desktop `export_hwpx_bytes` (issue 043 — the byte twin of
   *  the app's path save; reuses `hwp_mcp::export_bytes`). Same Uint8Array shape as the wasm backend. */
  async toHwpx(): Promise<Uint8Array> {
    return new Uint8Array(await this.invoke<number[]>("export_hwpx_bytes"));
  }

  dispose(): void {
    /* the desktop session outlives the component; nothing to free here */
  }
}
