// examples/vanilla.ts — "custom freedom" proof (SDK-LAYERS): a COMPLETE editor flow with NO React and
// NO DOM. It constructs the headless core over a mock EngineAdapter, opens a document, SELECTS a table
// cell with a pure pointer input, APPLIES an AI-proposed Intent (as the host would, from its own model),
// UNDOES it, and EXPORTS HTML — all by driving @tf-hwp/editor-core directly.
//
// A host embedding tf-hwp in a non-React app (Svelte, Vue, a Node service, a CLI) writes exactly this:
// bring your own EngineAdapter (WasmAdapter for the web, TauriAdapter for a desktop app, or your own),
// bring your own AI bridge, and the core handles selection/edit/undo/session with zero UI assumptions.
//
// Run the accompanying node test (examples/vanilla.test.ts) to see it drive end-to-end.

import { createEditorCore } from "../src/index";
import type { CellHit, EngineAdapter, Intent, OpenResult, Outcome, TableBox } from "../src/index";

/** A tiny in-memory adapter: a one-cell table at the page top + a spy-able apply/undo. Stands in for a
 *  real WasmAdapter/TauriAdapter so the example runs anywhere (no wasm, no files). */
class DemoAdapter implements EngineAdapter {
  applied: Intent[] = [];
  undos = 0;
  private table: TableBox = { section: 0, block: 1, x: 0, y: 0, w: 794, h: 260, rows: 1, cols: 1, first_row: 0 };
  private cellText = "미작성";

  async open(_b: Uint8Array, name?: string): Promise<OpenResult> {
    return { format: name?.endsWith(".hwp") ? "hwp" : "hwpx", editable: true, sections: 1, pages: 1 };
  }
  async pageCount() {
    return 1;
  }
  async pageSvg() {
    return `<svg viewBox="0 0 794 1123"></svg>`;
  }
  async hitTest() {
    return null;
  }
  async tableAt(_p: number, x: number, y: number): Promise<TableBox | null> {
    return x >= 0 && x <= 794 && y >= 0 && y <= 260 ? this.table : null;
  }
  async tableCellAt(_p: number, x: number, y: number): Promise<CellHit | null> {
    if (!(x >= 0 && x <= 794 && y >= 0 && y <= 260)) return null;
    return { section: 0, block: 1, row: 0, col: 0, rows: 1, cols: 1, text: this.cellText, x: 0, y: 0, w: 794, h: 260 };
  }
  async applyIntent(intent: Intent): Promise<Outcome> {
    this.applied.push(intent);
    if (intent.intent === "SetTableCell" && typeof intent.text === "string") this.cellText = intent.text;
    return { kind: "applied", ops: 1 };
  }
  async undo(): Promise<boolean> {
    this.undos++;
    this.cellText = "미작성";
    return true;
  }
  async redo(): Promise<boolean> {
    return true;
  }
  async registerFont() {}
  hasFont() {
    return false;
  }
  async exportPdf() {
    return new Uint8Array([0x25, 0x50, 0x44, 0x46]);
  }
  async exportHtml() {
    return `<!doctype html><html><body><table><tr><td>${this.cellText}</td></tr></table></body></html>`;
  }
  async toHwpx() {
    return new Uint8Array([0x50, 0x4b]);
  }
  dispose() {}
}

/** The host's AI bridge (R6). Here it's a deterministic stand-in for "call my server-side model": it
 *  targets the marked cell anchor and fills it. A real host returns the model's Intents. */
const fillCellAi = async (instruction: string, anchors: { section: number; block: number; rows?: [number, number]; cols?: [number, number] }[]): Promise<Intent[]> => {
  const a = anchors[0];
  if (!a) return [];
  return [{ intent: "SetTableCell", section: a.section, index: a.block, row: a.rows?.[0] ?? 0, col: a.cols?.[0] ?? 0, text: instruction }];
};

/** Run the whole flow and return a step log + the final export (for the node test to assert). */
export async function runVanillaDemo(): Promise<{ log: string[]; html: string; undoHtml: string }> {
  const log: string[] = [];
  const core = createEditorCore(new DemoAdapter());

  // Observe the headless events like any UI would (no framework).
  core.session.onDocChange((m) => log.push(`doc: ${m ? `${m.format} ${m.pages}p` : "closed"}`));
  core.selection.onChange((s) => log.push(`selection: ${s.length} — ${s.map((x) => x.anchor.label).join(", ")}`));

  // 1) open
  await core.session.open(new Uint8Array([1, 2, 3]), "plan.hwpx");

  // 2) DRILL into a cell with a pure page-local point (no DOM event). Figma progressive selection
  //    (issue 06x): a plain click marks the WHOLE table; `drillInto` descends to the exact cell (the
  //    UI wires it to a double-click / Enter).
  await core.selection.drillInto(0, 100, 100);

  // 3) ask the host AI + apply the returned Intent as one undo batch
  const anchors = core.selection.getAnchors();
  const intents = await fillCellAi("사업 개요를 채운다", anchors);
  log.push(`preview: ${core.edit.preview(intents).map((c) => c.label).join(", ")}`);
  const applied = await core.edit.apply(intents);
  log.push(`applied: ${applied} op(s)`);

  // 4) export the edited document
  const html = core.session.getMeta() ? await core.adapter.exportHtml() : "";

  // 5) undo, then export again to prove the round-trip
  await core.session.undo();
  const undoHtml = await core.adapter.exportHtml();

  return { log, html, undoHtml };
}
