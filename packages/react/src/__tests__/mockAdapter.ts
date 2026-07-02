import type { EngineAdapter } from "../EngineAdapter";
import type { BlockHit, Intent, OpenResult, Outcome, TableBox } from "../types";

/** A headless EngineAdapter for tests: canned SVG (optionally malicious, to exercise the R7 gate), a
 *  fixed table hit, and a spy-able applyIntent. No wasm — pure in-memory. */
export class MockAdapter implements EngineAdapter {
  applied: Intent[] = [];
  undos = 0;
  redos = 0;
  fontRegistered = false;

  constructor(
    private opts: {
      svg?: (page: number) => string;
      table?: TableBox | null;
      hit?: BlockHit | null;
      pages?: number;
    } = {},
  ) {}

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
  async hitTest(): Promise<BlockHit | null> {
    return this.opts.hit ?? null;
  }
  async tableAt(): Promise<TableBox | null> {
    return this.opts.table ?? null;
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
  async registerFont(): Promise<void> {
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
