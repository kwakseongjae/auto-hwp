import { describe, expect, it } from "vitest";
import { createEditorCore } from "../core";
import { type EditTarget, EditVetoedError, intentTargets } from "../editPolicy";
import { FindController } from "../find";
import { DocSession } from "../session";
import type { BlockHit, CellCaretRect, CellTextHit, Intent } from "../types";
import { MockAdapter } from "./mockAdapter";

// #368 — host-defined editable regions + intent veto. Pure editor-core: mock adapter, no DOM.

const cellRuns = (row: number, col: number, text = "v"): Intent => ({
  intent: "SetTableCellRuns",
  section: 0,
  index: 1,
  row,
  col,
  runs: [{ text }],
});
/** Only cell (0,1,0,1) — a "value" cell next to a "label" cell (0,1,0,0) — is editable. */
const valueCellOnly = (t: EditTarget) => t.kind === "cell" && t.block === 1 && t.row === 0 && t.col === 1;

describe("intentTargets", () => {
  it("maps content Intents to cell / paragraph targets and structure to block / document", () => {
    expect(intentTargets(cellRuns(2, 3))).toEqual([{ kind: "cell", section: 0, block: 1, row: 2, col: 3, intent: "SetTableCellRuns" }]);
    expect(intentTargets({ intent: "SetParagraphRuns", section: 1, block: 4, runs: [] })).toEqual([
      { kind: "paragraph", section: 1, block: 4, intent: "SetParagraphRuns" },
    ]);
    expect(intentTargets({ intent: "SetTableRowHeights", section: 0, index: 2, heights: [] })[0]).toMatchObject({ kind: "block", block: 2 });
    expect(intentTargets({ intent: "DeleteBlock", section: 0, index: 5 })[0]).toMatchObject({ kind: "block", block: 5 });
    expect(intentTargets({ intent: "MoveBlock", section: 0, from: 1, to: 7 }).map((t) => (t as { block: number }).block)).toEqual([1, 7]);
    expect(intentTargets({ intent: "SetPageMargins", section: 0 })[0]).toMatchObject({ kind: "document" });
    expect(intentTargets({ intent: "SomethingNew" })[0]).toMatchObject({ kind: "document", intent: "SomethingNew" });
  });

  it("a nested cell carries its leaf row/col and path; read-only Intents have no target", () => {
    const path = [
      { block: 1, row: 0, col: 0 },
      { block: 0, row: 2, col: 1 },
    ];
    expect(intentTargets({ intent: "SetTableCellRuns", section: 0, index: 1, row: 0, col: 0, path, runs: [] })).toEqual([
      { kind: "cell", section: 0, block: 1, row: 2, col: 1, path, intent: "SetTableCellRuns" },
    ]);
    expect(intentTargets({ intent: "TableGrid", section: 0, block: 1 })).toEqual([]);
    expect(intentTargets({ intent: "ProposeIntents", intents: [cellRuns(0, 0)] })[0]).toMatchObject({ kind: "cell", col: 0 });
  });
});

describe("DocSession veto (#368 acceptance ③)", () => {
  it("a disallowed Intent never reaches the engine and leaves the undo stack untouched", async () => {
    const adapter = new MockAdapter();
    const session = new DocSession(adapter, { editPolicy: { editable: valueCellOnly } });
    await session.applyBatch([cellRuns(0, 1)]);
    expect(session.undoDepth()).toBe(1);
    const err = await session.applyBatch([cellRuns(0, 0)]).catch((e) => e);
    expect(err).toBeInstanceOf(EditVetoedError);
    expect(err.code).toBe("edit_vetoed");
    expect(err.target).toMatchObject({ kind: "cell", col: 0 });
    // a mixed batch is refused WHOLE — the allowed half doesn't sneak through
    await expect(session.applyBatch([cellRuns(0, 1), { intent: "SetTableRowHeights", section: 0, index: 1, heights: [1] }])).rejects.toBeInstanceOf(EditVetoedError);
    expect(adapter.applied).toHaveLength(1);
    expect(session.undoDepth()).toBe(1);
  });

  it("beforeApply can veto or rewrite (a rewrite is re-checked); a throwing hook fails closed", async () => {
    const adapter = new MockAdapter();
    const session = new DocSession(adapter);
    session.setEditPolicy({ beforeApply: () => false });
    await expect(session.applyBatch([cellRuns(0, 1)])).rejects.toBeInstanceOf(EditVetoedError);
    session.setEditPolicy({ beforeApply: (xs) => xs.map((x) => ({ ...x, runs: [{ text: "rewritten" }] })) });
    await session.applyBatch([cellRuns(0, 1)]);
    expect((adapter.applied[0] as unknown as { runs: { text: string }[] }).runs[0].text).toBe("rewritten");
    session.setEditPolicy({ editable: valueCellOnly, beforeApply: () => [cellRuns(0, 0)] });
    await expect(session.applyBatch([cellRuns(0, 1)])).rejects.toBeInstanceOf(EditVetoedError);
    session.setEditPolicy({
      beforeApply: () => {
        throw new Error("host bug");
      },
    });
    await expect(session.applyBatch([cellRuns(0, 1)])).rejects.toBeInstanceOf(EditVetoedError);
    session.setEditPolicy({
      editable: () => {
        throw new Error("host bug");
      },
    });
    expect(session.canEdit({ kind: "paragraph", section: 0, block: 0, intent: "x" })).toBe(false);
    session.setEditPolicy(null);
    await session.applyBatch([cellRuns(0, 0)]);
    expect(adapter.applied).toHaveLength(2);
  });

  it("replace-all and proposal commits run through the same policy", async () => {
    const adapter = new MockAdapter({ find: [] });
    const session = new DocSession(adapter, { editPolicy: { editable: valueCellOnly } });
    const find = new FindController(adapter, session);
    await find.search("x");
    await expect(find.replaceAll("y")).rejects.toBeInstanceOf(EditVetoedError);
    expect(adapter.replaces).toHaveLength(0);
    class Proposing extends MockAdapter {
      commits = 0;
      async proposeIntents() {
        return {} as never;
      }
      async commitProposal() {
        this.commits++;
        return 1;
      }
    }
    const p = new Proposing();
    const s2 = new DocSession(p, { editPolicy: { editable: valueCellOnly } });
    await expect(s2.commitProposal({ intents: [cellRuns(0, 0)] } as never)).rejects.toBeInstanceOf(EditVetoedError);
    await expect(s2.propose([cellRuns(0, 0)])).rejects.toBeInstanceOf(EditVetoedError);
    expect(p.commits).toBe(0);
  });
});

describe("carets honor the policy (#368 acceptance ①)", () => {
  const rect: CellCaretRect = { page: 0, x: 100, top: 200, height: 13 };
  // x < 100 → label cell (col 0), x ≥ 100 → value cell (col 1)
  const cellAt = (_p: number, x: number): CellTextHit => ({ section: 0, block: 1, row: 0, col: x < 100 ? 0 : 1, para: 0, offset: 0, para_len: 1, caret: rect });

  it("clicking a read-only cell places no caret AND dismisses the live one (no keystroke leaks)", async () => {
    const adapter = new MockAdapter({ cellText: cellAt, cellCaret: rect, runs: [{ text: "v" }] });
    const core = createEditorCore(adapter, { session: { editPolicy: { editable: valueCellOnly } } });
    expect(await core.caret.clickAt(0, 150, 5)).not.toBeNull(); // value cell
    expect(core.caret.get()).not.toBeNull();
    expect(await core.caret.clickAt(0, 50, 5)).toBeNull(); // label cell
    expect(core.caret.get()).toBeNull();
    expect(await core.caret.insertText("x")).toBe(false);
    expect(adapter.applied).toHaveLength(0);
  });

  it("a read-only body paragraph gets no caret (and an editable one still does)", async () => {
    const band = { section: 0, block: 0, kind: "paragraph", x: 0, y: 0, w: 500, h: 20, editable: true, text: "" } as unknown as BlockHit;
    const make = () =>
      new MockAdapter({
        hit: band,
        // an EMPTY paragraph resolves without glyphs (the band itself is the caret line)
        runs: (_s: number, _b: number, row?: number) => (row === undefined ? [] : [{ text: "v" }]),
      });
    const open = createEditorCore(make());
    expect((await open.caret.clickAt(0, 10, 10))?.kind).toBe("body"); // control: no policy → caret
    const locked = createEditorCore(make(), { session: { editPolicy: { editable: (t) => t.kind !== "paragraph" } } });
    expect(await locked.caret.clickAt(0, 10, 10)).toBeNull();
    expect(locked.caret.get()).toBeNull();
    expect(await locked.caret.insertText("x")).toBe(false);
  });

  it("invalidateEditability() drops a caret whose cell became locked (dynamic predicate)", async () => {
    let locked = false;
    const adapter = new MockAdapter({ cellText: cellAt, cellCaret: rect, runs: [{ text: "v" }] });
    const core = createEditorCore(adapter);
    core.setEditPolicy({ editable: (t) => !locked && valueCellOnly(t) });
    await core.caret.clickAt(0, 150, 5);
    expect(core.caret.get()).not.toBeNull();
    locked = true;
    core.invalidateEditability();
    expect(core.caret.get()).toBeNull();
  });

  it("without a policy nothing changes (pre-#368 behavior)", async () => {
    const adapter = new MockAdapter({ cellText: cellAt, cellCaret: rect, runs: [{ text: "v" }] });
    const core = createEditorCore(adapter);
    expect(await core.caret.clickAt(0, 50, 5)).not.toBeNull();
    expect(core.session.canEdit({ kind: "document", section: null, intent: "SetPageMargins" })).toBe(true);
  });
});
