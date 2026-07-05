import type { EngineAdapter } from "../adapter";
import type { BlockHit, CaretRect, CellHit, FindMatch, FindOptions, FindReplaceOptions, HitResult, ImageBox, Intent, OpenResult, Outcome, OutlineItem, PageGeom, ReplaceResult, RunSpec, TableBox } from "../types";

/** A headless EngineAdapter for node tests: canned geometry resolvers + a spy-able applyIntent/undo.
 *  No wasm, no DOM — pure in-memory. Mirrors @tf-hwp/react's test MockAdapter so the same selection
 *  scenarios port 1:1 (issue 026: DOM events → pure `pointerDown({page,x,y,mod})` inputs). */
export class MockAdapter implements EngineAdapter {
  applied: Intent[] = [];
  undos = 0;
  redos = 0;
  fontRegistered = false;
  registeredFonts: { family: string; bytes: Uint8Array }[] = [];
  /** Spy for issue-045 find/replace: every find query + every replace call (query/replacement/opts). */
  finds: { query: string; opts: FindOptions }[] = [];
  replaces: { query: string; replacement: string; opts: FindReplaceOptions }[] = [];

  constructor(
    private opts: {
      /** A fixed table box, or a coordinate-aware resolver (place a table region by point). */
      table?: TableBox | null | ((page: number, x: number, y: number) => TableBox | null);
      /** A fixed hit, or a coordinate-aware resolver (place distinct blocks by point). */
      hit?: BlockHit | null | ((page: number, x: number, y: number) => BlockHit | null);
      /** A fixed cell hit, or a coordinate-aware resolver (cell-level marking, issue 023). Present opts
       *  make `tableCellAt` answer; omitting it entirely OMITS the method (whole-table fallback). */
      cell?: CellHit | null | ((page: number, x: number, y: number) => CellHit | null);
      /** Canned marquee result for `blocksInRect` (issue 021). Omit to OMIT the method (no marquee). */
      blocks?: BlockHit[];
      /** Canned column boundaries for `tableColBoundaries` (issue 027). Omit to OMIT the method. */
      colBoundaries?: number[] | null;
      /** Canned row boundaries for `tableRowBoundaries` (issue 031), or a page-aware resolver (so a split
       *  table returns a different per-page FRAGMENT — issue 036 cross-page cell nav). Omit to OMIT it. */
      rowBoundaries?: number[] | null | ((page: number, section: number, block: number) => number[] | null);
      /** Canned page geometry for `pageGeometry` (issue 027). Omit to OMIT the method. */
      pageGeom?: PageGeom | null;
      /** Canned current runs for `blockRuns` (issue 027 run-preservation). Omit to OMIT the method. */
      runs?: RunSpec[];
      /** Canned glyph-caret hit for `hitTestText` (issue 041), or a coordinate-aware resolver. Present
       *  makes `hitTestText` answer; omit to OMIT the method (a no-glyph-caret backend). */
      hitText?: HitResult | null | ((page: number, x: number, y: number) => HitResult | null);
      /** Canned caret rect for `caretRect` (issue 041), or a `(page, node, offset)` resolver (so a test
       *  can model past-end CLAMP + "not on this page" = null). Omit to OMIT the method. */
      caret?: CaretRect | null | ((page: number, node: number, offset: number) => CaretRect | null);
      /** Canned find matches (issue 045), or a `(query, opts)` resolver. Present makes `find`/`replace`
       *  answer; omit to OMIT both (a backend without find/replace). */
      find?: FindMatch[] | ((query: string, opts: FindOptions) => FindMatch[]);
      /** Explicit replaced-count for `replace`; default = the current `find` match count (all) or min(1,n). */
      replaceCount?: number;
      /** Canned document outline for `outline` (issue 046). Omit to OMIT the method (page-list fallback). */
      outline?: OutlineItem[];
      /** Canned image hit for `imageAt` (issue 049), or a `(page, x, y)` resolver. Present makes `imageAt`
       *  answer; omit to OMIT the method (a backend with no image overlay). */
      image?: ImageBox | null | ((page: number, x: number, y: number) => ImageBox | null);
      /** Canned image box for `imageBbox` (issue 049), or a `(page, section, block)` resolver (so a test can
       *  model a post-resize re-query = 적용-확인). Omit to OMIT the method. */
      imageBox?: ImageBox | null | ((page: number, section: number, block: number) => ImageBox | null);
      pages?: number;
    } = {},
  ) {
    // Only expose the OPTIONAL methods when the corresponding opt was supplied — so tests exercise BOTH
    // the capable backend AND a backend that omits them (reference TauriAdapter parity).
    if (!("cell" in this.opts)) (this as { tableCellAt?: unknown }).tableCellAt = undefined;
    if (!("blocks" in this.opts)) (this as { blocksInRect?: unknown }).blocksInRect = undefined;
    if (!("colBoundaries" in this.opts)) (this as { tableColBoundaries?: unknown }).tableColBoundaries = undefined;
    if (!("rowBoundaries" in this.opts)) (this as { tableRowBoundaries?: unknown }).tableRowBoundaries = undefined;
    if (!("pageGeom" in this.opts)) (this as { pageGeometry?: unknown }).pageGeometry = undefined;
    if (!("runs" in this.opts)) (this as { blockRuns?: unknown }).blockRuns = undefined;
    if (!("hitText" in this.opts)) (this as { hitTestText?: unknown }).hitTestText = undefined;
    if (!("caret" in this.opts)) (this as { caretRect?: unknown }).caretRect = undefined;
    if (!("find" in this.opts)) {
      (this as { find?: unknown }).find = undefined;
      (this as { replace?: unknown }).replace = undefined;
    }
    if (!("outline" in this.opts)) (this as { outline?: unknown }).outline = undefined;
    if (!("image" in this.opts)) (this as { imageAt?: unknown }).imageAt = undefined;
    if (!("imageBox" in this.opts)) (this as { imageBbox?: unknown }).imageBbox = undefined;
  }

  private matchesFor(query: string, opts: FindOptions): FindMatch[] {
    const f = this.opts.find;
    return (typeof f === "function" ? f(query, opts) : f) ?? [];
  }

  async open(_bytes: Uint8Array, name?: string): Promise<OpenResult> {
    void _bytes;
    return { format: name?.endsWith(".hwp") ? "hwp" : "hwpx", editable: true, sections: 1, pages: this.opts.pages ?? 1 };
  }
  async pageCount(): Promise<number> {
    return this.opts.pages ?? 1;
  }
  async pageSvg(_page: number): Promise<string> {
    return `<svg viewBox="0 0 794 1123" width="794" height="1123"></svg>`;
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
  async tableRowBoundaries(page: number, section: number, block: number): Promise<number[] | null> {
    const rb = this.opts.rowBoundaries;
    return (typeof rb === "function" ? rb(page, section, block) : rb) ?? null;
  }
  async pageGeometry(): Promise<PageGeom | null> {
    return this.opts.pageGeom ?? null;
  }
  async imageAt(page: number, x: number, y: number): Promise<ImageBox | null> {
    const im = this.opts.image;
    return (typeof im === "function" ? im(page, x, y) : im) ?? null;
  }
  async imageBbox(page: number, section: number, block: number): Promise<ImageBox | null> {
    const ib = this.opts.imageBox;
    return (typeof ib === "function" ? ib(page, section, block) : ib) ?? null;
  }
  async blockRuns(): Promise<RunSpec[]> {
    return this.opts.runs ?? [];
  }
  async hitTestText(page: number, x: number, y: number): Promise<HitResult | null> {
    const h = this.opts.hitText;
    return (typeof h === "function" ? h(page, x, y) : h) ?? null;
  }
  async caretRect(page: number, node: number, offset: number): Promise<CaretRect | null> {
    const c = this.opts.caret;
    return (typeof c === "function" ? c(page, node, offset) : c) ?? null;
  }
  async find(query: string, opts: FindOptions): Promise<FindMatch[]> {
    this.finds.push({ query, opts });
    return this.matchesFor(query, opts);
  }
  async replace(query: string, replacement: string, opts: FindReplaceOptions): Promise<ReplaceResult> {
    this.replaces.push({ query, replacement, opts });
    const n = this.matchesFor(query, opts).length;
    const replaced = this.opts.replaceCount ?? (opts.all ? n : Math.min(1, n));
    return { replaced, pages: this.opts.pages ?? 1 };
  }
  async outline(): Promise<OutlineItem[]> {
    return this.opts.outline ?? [];
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
