import type { BlockHit, CellHit, Intent, OpenResult, Outcome, TableBox } from "./types";

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

  /** Structural block under a PAGE-LOCAL px point, or null on a miss. */
  hitTest(page: number, x: number, y: number): Promise<BlockHit | null>;

  /** Placed table box under a PAGE-LOCAL px point (for marking), or null on a miss. */
  tableAt(page: number, x: number, y: number): Promise<TableBox | null>;

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
