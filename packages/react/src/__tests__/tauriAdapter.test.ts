import { describe, expect, it, vi } from "vitest";
import { TauriAdapter } from "../TauriAdapter";
import type { Intent } from "../types";

// Issue 043 — the desktop TauriAdapter now implements the WHOLE EngineAdapter surface HwpWorkspace
// consumes, mapping each method onto a Tauri command (crates/hwp-viewer). These lock the invoke seam
// with a mock `invoke`: every method's command name, argument keys, UNIT passthrough (own-render px in
// and out — NO conversion, §4.5) and null policy (018). The wasm end-to-end path is proven separately
// (scripts/caret-geometry-smoke.mjs); the caret half lives in caretAdapter.test.ts.

/** A mock invoke that records calls and returns a queued value per command. */
function mockInvoke(returns: Record<string, unknown>) {
  const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
  const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    calls.push({ cmd, args });
    return returns[cmd];
  });
  return { invoke: invoke as <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>, calls };
}

describe("TauriAdapter — open / lifecycle (issue 043)", () => {
  it("open() bridges bytes→path via resolveOpenPath, then maps open_doc to OpenResult", async () => {
    const { invoke, calls } = mockInvoke({ open_doc: { pages: 8, editable: true, format: "HWP5" } });
    const resolveOpenPath = vi.fn(async () => "/tmp/doc.hwpx");
    const a = new TauriAdapter({ invoke, resolveOpenPath });
    const bytes = new Uint8Array([1, 2, 3]);
    const r = await a.open(bytes, "doc.hwp");
    expect(resolveOpenPath).toHaveBeenCalledWith(bytes, "doc.hwp");
    expect(calls[0]).toEqual({ cmd: "open_doc", args: { path: "/tmp/doc.hwpx" } });
    expect(r).toEqual({ format: "HWP5", editable: true, sections: 1, pages: 8 });
  });

  it("open() throws a clear error when resolveOpenPath is missing (path-based host)", async () => {
    const { invoke } = mockInvoke({});
    const a = new TauriAdapter({ invoke });
    await expect(a.open(new Uint8Array())).rejects.toThrow(/resolveOpenPath/);
  });

  it("dispose() is a no-op (the desktop session outlives the component)", () => {
    const { invoke } = mockInvoke({});
    expect(() => new TauriAdapter({ invoke }).dispose()).not.toThrow();
  });
});

describe("TauriAdapter — render + geometry commands speak own-render px (issue 043 §4.5)", () => {
  it("pageCount / pageSvg map to own_page_count / render_own_page", async () => {
    const { invoke, calls } = mockInvoke({ own_page_count: 12, render_own_page: "<svg/>" });
    const a = new TauriAdapter({ invoke });
    expect(await a.pageCount()).toBe(12);
    expect(await a.pageSvg(3)).toBe("<svg/>");
    expect(calls).toEqual([
      { cmd: "own_page_count", args: undefined },
      { cmd: "render_own_page", args: { page: 3 } },
    ]);
  });

  it("hitTest forwards the px point unchanged (no unit slip) and passes BlockHit through", async () => {
    const hit = { section: 0, block: 2, kind: "paragraph", x: 10, y: 20, w: 300, h: 14, text: "hi", editable: true };
    const { invoke, calls } = mockInvoke({ own_hit_test: hit });
    const a = new TauriAdapter({ invoke });
    expect(await a.hitTest(1, 123.5, 456.5)).toEqual(hit);
    expect(calls[0]).toEqual({ cmd: "own_hit_test", args: { page: 1, x: 123.5, y: 456.5 } });
  });

  it("tableAt passes TableBox through and returns null on a miss", async () => {
    const box = { section: 0, block: 1, x: 5, y: 6, w: 200, h: 100, rows: 3, cols: 2, first_row: 0 };
    const { invoke } = mockInvoke({ table_at: box });
    const a = new TauriAdapter({ invoke });
    expect(await a.tableAt(0, 50, 60)).toEqual(box);
    const miss = new TauriAdapter({ invoke: mockInvoke({ table_at: null }).invoke });
    expect(await miss.tableAt(0, 0, 0)).toBeNull();
  });

  it("tableCellAt maps to table_cell_at; null off any cell (018 null policy)", async () => {
    const cell = { section: 0, block: 1, row: 2, col: 1, rows: 3, cols: 2, text: "c", x: 1, y: 2, w: 3, h: 4 };
    const { invoke, calls } = mockInvoke({ table_cell_at: cell });
    const a = new TauriAdapter({ invoke });
    expect(await a.tableCellAt!(0, 11, 22)).toEqual(cell);
    expect(calls[0]).toEqual({ cmd: "table_cell_at", args: { page: 0, x: 11, y: 22 } });
    const miss = new TauriAdapter({ invoke: mockInvoke({ table_cell_at: null }).invoke });
    expect(await miss.tableCellAt!(0, 0, 0)).toBeNull();
  });

  it("blocksInRect maps to blocks_in_rect with corner args; [] on a miss (never null)", async () => {
    const { invoke, calls } = mockInvoke({ blocks_in_rect: [] });
    const a = new TauriAdapter({ invoke });
    expect(await a.blocksInRect!(2, 0, 0, 500, 400)).toEqual([]);
    expect(calls[0]).toEqual({ cmd: "blocks_in_rect", args: { page: 2, x0: 0, y0: 0, x1: 500, y1: 400 } });
  });

  it("tableColBoundaries / tableRowBoundaries map to their commands; null off-page", async () => {
    const { invoke, calls } = mockInvoke({ table_col_boundaries: [0, 100, 200], table_row_boundaries: null });
    const a = new TauriAdapter({ invoke });
    expect(await a.tableColBoundaries!(1, 0, 3)).toEqual([0, 100, 200]);
    expect(await a.tableRowBoundaries!(1, 0, 3)).toBeNull();
    expect(calls[0]).toEqual({ cmd: "table_col_boundaries", args: { page: 1, section: 0, block: 3 } });
    expect(calls[1]).toEqual({ cmd: "table_row_boundaries", args: { page: 1, section: 0, block: 3 } });
  });

  it("pageGeometry maps to page_geometry and returns the px PageGeom (or null)", async () => {
    const geom = { w: 794, h: 1123, ml: 90, mt: 80, mr: 90, mb: 80 };
    const { invoke, calls } = mockInvoke({ page_geometry: geom });
    const a = new TauriAdapter({ invoke });
    expect(await a.pageGeometry!(0)).toEqual(geom);
    expect(calls[0]).toEqual({ cmd: "page_geometry", args: { page: 0 } });
  });
});

describe("TauriAdapter — run reads + edit intents (issue 043)", () => {
  it("blockRuns maps to get_block_runs; omitted row/col become null (paragraph target)", async () => {
    const runs = [{ text: "A", bold: true }, { text: "B" }];
    const { invoke, calls } = mockInvoke({ get_block_runs: runs });
    const a = new TauriAdapter({ invoke });
    // paragraph read (no row/col)
    expect(await a.blockRuns!(0, 5)).toEqual(runs);
    expect(calls[0]).toEqual({ cmd: "get_block_runs", args: { section: 0, block: 5, row: null, col: null } });
    // cell read (row/col present)
    await a.blockRuns!(0, 1, 2, 3);
    expect(calls[1]).toEqual({ cmd: "get_block_runs", args: { section: 0, block: 1, row: 2, col: 3 } });
  });

  it("applyIntent forwards the whole schema through the single apply_intent_json command", async () => {
    const outcome = { kind: "edited", pages: 9 };
    const { invoke, calls } = mockInvoke({ apply_intent_json: outcome });
    const a = new TauriAdapter({ invoke });
    const intent: Intent = { intent: "SetTableCellRuns", section: 0, index: 1, row: 0, col: 0, runs: [{ text: "x" }] };
    expect(await a.applyIntent(intent)).toEqual(outcome);
    expect(calls[0]).toEqual({ cmd: "apply_intent_json", args: { intent } });
  });

  it("applyIntent surfaces a rejected op-bus edit (no silent no-op)", async () => {
    const invoke = vi.fn(async () => {
      throw new Error("paragraph 3 has structural content and cannot be edited in place");
    }) as <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
    const a = new TauriAdapter({ invoke });
    await expect(a.applyIntent({ intent: "SetParagraphText", section: 0, block: 3, text: "x" })).rejects.toThrow(
      /structural content/,
    );
  });

  it("undo / redo resolve true and call the undo/redo commands", async () => {
    const { invoke, calls } = mockInvoke({ undo: 8, redo: 9 });
    const a = new TauriAdapter({ invoke });
    expect(await a.undo()).toBe(true);
    expect(await a.redo()).toBe(true);
    expect(calls.map((c) => c.cmd)).toEqual(["undo", "redo"]);
  });
});

describe("TauriAdapter — fonts + export (issue 043)", () => {
  it("registerFont is a no-op and hasFont is always true (native font stack)", async () => {
    const { invoke, calls } = mockInvoke({});
    const a = new TauriAdapter({ invoke });
    await expect(a.registerFont("Noto", new Uint8Array([1]))).resolves.toBeUndefined();
    expect(a.hasFont()).toBe(true);
    expect(calls).toEqual([]); // no command issued for font registration on the desktop
  });

  it("exportHtml maps to render_doc_html (string)", async () => {
    const { invoke, calls } = mockInvoke({ render_doc_html: "<!doctype html>…" });
    const a = new TauriAdapter({ invoke });
    expect(await a.exportHtml()).toContain("<!doctype html>");
    expect(calls[0].cmd).toBe("render_doc_html");
  });

  it("exportPdf wraps the command's number[] back into a Uint8Array", async () => {
    const { invoke, calls } = mockInvoke({ export_pdf_bytes: [37, 80, 68, 70] }); // %PDF
    const a = new TauriAdapter({ invoke });
    const out = await a.exportPdf();
    expect(out).toBeInstanceOf(Uint8Array);
    expect(Array.from(out)).toEqual([37, 80, 68, 70]);
    expect(calls[0].cmd).toBe("export_pdf_bytes");
  });

  it("toHwpx wraps export_hwpx_bytes' number[] back into a Uint8Array", async () => {
    const { invoke, calls } = mockInvoke({ export_hwpx_bytes: [80, 75, 3, 4] }); // PK zip
    const a = new TauriAdapter({ invoke });
    const out = await a.toHwpx();
    expect(out).toBeInstanceOf(Uint8Array);
    expect(Array.from(out)).toEqual([80, 75, 3, 4]);
    expect(calls[0].cmd).toBe("export_hwpx_bytes");
  });
});
