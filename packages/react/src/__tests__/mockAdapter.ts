import type { EngineAdapter } from "../EngineAdapter";
import type { BlockHit, CellHit, Intent, OpenResult, Outcome, PageGeom, RunSpec, TableBox } from "../types";

/** A headless EngineAdapter for tests: canned SVG (optionally malicious, to exercise the R7 gate), a
 *  fixed table hit, and a spy-able applyIntent. No wasm — pure in-memory. */
export class MockAdapter implements EngineAdapter {
  applied: Intent[] = [];
  undos = 0;
  redos = 0;
  fontRegistered = false;
  registeredFonts: { family: string; bytes: Uint8Array }[] = [];

  constructor(
    private opts: {
      svg?: (page: number) => string;
      /** A fixed table box, or a coordinate-aware resolver (so a test can place a table region by point
       *  and empty space elsewhere — needed for cell/block MIXED selection, issue 023). */
      table?: TableBox | null | ((page: number, x: number, y: number) => TableBox | null);
      /** A fixed hit, or a coordinate-aware resolver (so a test can place distinct blocks by point). */
      hit?: BlockHit | null | ((page: number, x: number, y: number) => BlockHit | null);
      /** A fixed cell hit, or a coordinate-aware resolver (cell-level marking, issue 023). Present opts
       *  make `tableCellAt` answer; omitting it entirely OMITS the method (reference `TauriAdapter` parity
       *  → whole-table fallback). */
      cell?: CellHit | null | ((page: number, x: number, y: number) => CellHit | null);
      /** Canned marquee result for `blocksInRect` (issue 021). */
      blocks?: BlockHit[];
      /** Canned column boundaries / page geometry / cell runs (issue 027). Omit to OMIT the method. */
      colBoundaries?: number[] | null;
      pageGeom?: PageGeom | null;
      runs?: RunSpec[];
      pages?: number;
    } = {},
  ) {
    // Only expose the OPTIONAL methods when the corresponding opt was supplied — so tests exercise BOTH
    // the capable backend (WasmAdapter parity) and a backend that omits the optional method.
    if (!("cell" in this.opts)) (this as { tableCellAt?: unknown }).tableCellAt = undefined;
    if (!("colBoundaries" in this.opts)) (this as { tableColBoundaries?: unknown }).tableColBoundaries = undefined;
    if (!("pageGeom" in this.opts)) (this as { pageGeometry?: unknown }).pageGeometry = undefined;
    if (!("runs" in this.opts)) (this as { blockRuns?: unknown }).blockRuns = undefined;
  }

  async open(_bytes: Uint8Array, name?: string): Promise<OpenResult> {
    void _bytes;
    return { format: name?.endsWith(".hwp") ? "hwp" : "hwpx", editable: true, sections: 1, pages: this.opts.pages ?? 1 };
  }
  async pageCount(): Promise<number> {
    return this.opts.pages ?? 1;
  }
  async pageSvg(page: number): Promise<string> {
    return this.opts.svg
      ? this.opts.svg(page)
      : `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 794 1123" width="794" height="1123"><rect width="794" height="1123" fill="#fff"/></svg>`;
  }
  async hitTest(page: number, x: number, y: number): Promise<BlockHit | null> {
    const h = this.opts.hit;
    return (typeof h === "function" ? h(page, x, y) : h) ?? null;
  }
  async tableAt(page: number, x: number, y: number): Promise<TableBox | null> {
    const t = this.opts.table;
    return (typeof t === "function" ? t(page, x, y) : t) ?? null;
  }
  async tableCellAt(page: number, x: number, y: number): Promise<CellHit | null> {
    const c = this.opts.cell;
    return (typeof c === "function" ? c(page, x, y) : c) ?? null;
  }
  async blocksInRect(): Promise<BlockHit[]> {
    return this.opts.blocks ?? [];
  }
  async tableColBoundaries(): Promise<number[] | null> {
    return this.opts.colBoundaries ?? null;
  }
  async pageGeometry(): Promise<PageGeom | null> {
    return this.opts.pageGeom ?? null;
  }
  async blockRuns(): Promise<RunSpec[]> {
    return this.opts.runs ?? [];
  }
  async applyIntent(intent: Intent): Promise<Outcome> {
    this.applied.push(intent);
    return { kind: "applied", ops: 1 };
  }
  async undo(): Promise<boolean> {
    this.undos++;
    return true;
  }
  async redo(): Promise<boolean> {
    this.redos++;
    return true;
  }
  async registerFont(family: string, bytes: Uint8Array): Promise<void> {
    this.registeredFonts.push({ family, bytes });
    this.fontRegistered = true;
  }
  hasFont(): boolean {
    return this.fontRegistered;
  }
  async exportPdf(): Promise<Uint8Array> {
    if (!this.fontRegistered) throw Object.assign(new Error("font_missing"), { code: "font_missing" });
    return new Uint8Array([0x25, 0x50, 0x44, 0x46]); // "%PDF"
  }
  async exportHtml(): Promise<string> {
    return "<html><body>mock</body></html>";
  }
  async toHwpx(): Promise<Uint8Array> {
    return new Uint8Array([0x50, 0x4b]); // "PK"
  }
  dispose(): void {}
}
