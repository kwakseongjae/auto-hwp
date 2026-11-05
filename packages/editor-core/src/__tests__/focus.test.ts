import { describe, expect, it, vi } from "vitest";
import { createEditorCore } from "../core";
import type { BlockHit, CellBoxItem, RunSpec } from "../types";
import { MockAdapter } from "./mockAdapter";

const addr = { section: 0, block: 1, row: 0, col: 0 };
const band: BlockHit = { section: 0, block: 3, kind: "paragraph", x: 80, y: 50, w: 200, h: 20, text: "", editable: true };
async function setup() {
  const adapter = new MockAdapter({
    runs: (_s, _b, row) => [{ text: row === undefined ? "" : "AB\ncd" }],
    blocks: [band], cellText: null,
    cellCaret: (_s, _b, _row, _col, para, offset) => ({ page: 0, x: 100 + offset * 10, top: 200 + para * 20, height: 13 }),
  });
  const core = createEditorCore(adapter);
  await core.session.open(new Uint8Array([1]));
  return { core, adapter };
}

describe("#507 headless address focus", () => {
  it("cell/body focus share one caret and do not mutate the document", async () => {
    const { core, adapter } = await setup();
    expect(await core.caret.focusCell(addr, "end")).toBe(true);
    expect(core.cellCaret.get()?.anchor).toMatchObject({ ...addr, para: 0, offset: 2, selAnchor: 2, paraLen: 2 });
    expect(await core.caret.focusParagraph({ section: 0, block: 3 })).toBe(true);
    expect(core.cellCaret.get()).toBeNull();
    expect(core.bodyCaret.get()?.anchor).toMatchObject({ section: 0, block: 3, offset: 0 });
    expect(adapter.applied).toEqual([]);
    expect(core.session.canUndo()).toBe(false);
  });

  it("preparation failure keeps both the old caret range and click-veto flag", async () => {
    const { core } = await setup();
    await core.caret.focusCell(addr, 1);
    await core.caret.extend(1);
    const before = core.cellCaret.get();
    core.cellCaret.lastClickVetoed = true;
    expect(await core.caret.focusCell({ ...addr, col: 1 }, 0, async () => false)).toBe(false);
    expect(await core.caret.focusParagraph({ section: 0, block: 3 }, 0, async () => false)).toBe(false);
    expect(core.cellCaret.get()).toBe(before);
    expect(core.cellCaret.lastClickVetoed).toBe(true);
  });

  it("policy is rechecked after asynchronous shell preparation", async () => {
    const { core } = await setup();
    await core.caret.focusCell(addr, 1);
    const before = core.cellCaret.get();
    let allowed = true;
    core.setEditPolicy({ editable: (t) => t.kind === "cell" && (t.col === 0 || allowed) });
    expect(await core.caret.focusCell({ ...addr, col: 1 }, 0, async () => { allowed = false; return true; })).toBe(false);
    expect(core.cellCaret.get()).toBe(before);
  });

  it.each(["clear", "close", "reopen"] as const)("a %s during an address read invalidates the pending focus", async (action) => {
    const { core, adapter } = await setup();
    let release!: (runs: RunSpec[]) => void;
    vi.spyOn(adapter, "blockRuns").mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
    const pending = core.caret.focusCell(addr);
    await Promise.resolve(); await Promise.resolve();
    if (action === "clear") core.caret.clear();
    else if (action === "close") core.session.close();
    else await core.session.open(new Uint8Array([2]));
    release([{ text: "AB" }]);
    expect(await pending).toBe(false);
    expect(core.caret.get()).toBeNull();
  });

  it("a paragraph with unalignable glyphs does not clear a valid cell caret", async () => {
    const { core, adapter } = await setup();
    await core.caret.focusCell(addr);
    const before = core.cellCaret.get();
    vi.spyOn(adapter, "blockRuns").mockResolvedValue([{ text: "no matching glyphs" }]);
    expect(await core.caret.focusParagraph({ section: 0, block: 3 })).toBe(false);
    expect(core.cellCaret.get()).toBe(before);
  });

  it("a backend without cell input capabilities cannot create a dead caret", async () => {
    const { core, adapter } = await setup();
    Object.assign(adapter, { hitTestCellText: undefined });
    expect(await core.caret.focusCell(addr)).toBe(false);
    expect(core.caret.get()).toBeNull();
  });

  it("focusNext starts backwards at the last target, skips unresolvable cells and deduplicates fragments", async () => {
    const { core, adapter } = await setup();
    const c: CellBoxItem = { ...addr, path: [{ block: 1, row: 0, col: 0 }], text: "AB\ncd", x: 100, y: 200, w: 100, h: 40 };
    Object.assign(adapter, { cellBoxes: async () => [c, c] });
    expect(await core.caret.focusNext(-1)).toBe(true);
    expect(core.caret.getTarget()).toEqual({ kind: "paragraph", section: 0, block: 3 });
    expect(await core.caret.focusNext(-1)).toBe(true);
    expect(core.cellCaret.get()?.anchor.para).toBe(1);
    expect(await core.caret.focusNext(-1)).toBe(true);
    expect(core.cellCaret.get()?.anchor.para).toBe(0);
    expect(await core.caret.focusNext(-1)).toBe(false);
    vi.spyOn(adapter, "caretRectCell").mockResolvedValue(null);
    core.caret.clear();
    expect(await core.caret.focusNext()).toBe(true);
    expect(core.caret.getTarget()?.kind).toBe("paragraph");
  });

  it("wrap can return to the only editable target", async () => {
    const { core } = await setup();
    await core.caret.focusParagraph({ section: 0, block: 3 });
    expect(await core.caret.focusNext()).toBe(false);
    expect(await core.caret.focusNext(1, { wrap: true })).toBe(true);
  });

  it("typing immediately after a focus request writes to the requested target", async () => {
    const { core, adapter } = await setup();
    await core.caret.focusCell(addr);
    const focused = core.caret.focusCell({ ...addr, col: 1 });
    const typed = core.caret.insertText("X");
    expect(await focused).toBe(true);
    expect(await typed).toBe(true);
    expect(adapter.applied[0]).toMatchObject({ intent: "SetTableCellRuns", col: 1 });
  });

  it("focus waits for preceding typing and its layout invalidation", async () => {
    const { core, adapter } = await setup();
    await core.caret.focusCell(addr);
    const typed = core.caret.insertText("X");
    const focused = core.caret.focusParagraph({ section: 0, block: 3 });
    expect(await typed).toBe(true);
    expect(await focused).toBe(true);
    expect(adapter.applied[0]).toMatchObject({ intent: "SetTableCellRuns", col: 0 });
    expect(core.caret.getTarget()?.kind).toBe("paragraph");
  });

  it("nested tables interleave with paragraphs before and after them in the containing cell", async () => {
    const { core, adapter } = await setup();
    const path = [{ block: 1, row: 0, col: 0 }, { block: 1, row: 0, col: 0 }];
    Object.assign(adapter, {
      cellBoxes: async () => [
        { ...addr, path: [path[0]], text: "AB\ncd", paragraph_blocks: [0, 2], x: 100, y: 200, w: 100, h: 80 },
        { ...addr, path, text: "leaf", paragraph_blocks: [0], x: 100, y: 220, w: 100, h: 20 },
      ],
      blockRunsPath: async () => [{ text: "leaf" }],
    });
    await core.caret.focusCell(addr);
    expect(await core.caret.focusNext()).toBe(true);
    expect(core.cellCaret.get()?.anchor.path).toEqual(path);
    expect(await core.caret.focusNext()).toBe(true);
    expect(core.cellCaret.get()?.anchor).toMatchObject({ para: 1, offset: 0 });
    expect(core.cellCaret.get()?.anchor.path).toBeUndefined();
    expect(await core.caret.focusNext(-1)).toBe(true);
    expect(core.cellCaret.get()?.anchor.path).toEqual(path);
  });
});
