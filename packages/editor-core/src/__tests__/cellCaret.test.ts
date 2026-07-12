import { describe, expect, it } from "vitest";
import { CellCaretController, cellGlobalOffset, cellParaOffsetAt, inheritStyleAt, runsText, spliceRuns } from "../cellCaret";
import { DocSession } from "../session";
import type { CellCaretRect, CellTextHit, RunSpec } from "../types";
import { MockAdapter } from "./mockAdapter";

// Issue 053 (FG-12 後半) — the cell-addressed glyph caret MODEL: the editor ("\n"-split) offset math,
// the style-preserving run splice, and the headless controller's click → caret → per-keystroke
// SetTableCellRuns commit lane. No wasm, no DOM. The engine-side geometry (segment addressing, the
// paraLen clamp, the 018 nulls) is pinned by Rust tests (hwp-typeset place.rs + hwp-mcp schema_v0);
// here we pin the TS half that turns a caret into a commit.
//
// ⚠️ MockAdapter is a FROZEN READ: `blockRuns` keeps returning the canned runs after a commit (it is
// not a live engine). Each splice test therefore asserts the COMMITTED intent payload (what the real
// engine would receive), not a re-read.

const cellRect: CellCaretRect = { page: 0, x: 100, top: 200, height: 13 };

const hit = (over: Partial<CellTextHit> = {}): CellTextHit => ({
  section: 0,
  block: 1,
  row: 0,
  col: 0,
  para: 0,
  offset: 1,
  para_len: 2,
  caret: cellRect,
  ...over,
});

/** Runs of a two-paragraph cell: "AB" (bold) ⏎ "cd" (plain) — joined editor text "AB\ncd". */
const twoParaRuns = (): RunSpec[] => [
  { text: "AB", bold: true },
  { text: "\n" },
  { text: "cd" },
];

describe("cell caret offset math (editor \\n-split space)", () => {
  it("runsText joins run texts verbatim (separators included)", () => {
    expect(runsText(twoParaRuns())).toBe("AB\ncd");
  });

  it("cellGlobalOffset maps (para, offset) → joined offset across separators", () => {
    expect(cellGlobalOffset("AB\ncd", 0, 0)).toBe(0);
    expect(cellGlobalOffset("AB\ncd", 0, 2)).toBe(2); // end of para 0 (before the "\n")
    expect(cellGlobalOffset("AB\ncd", 1, 0)).toBe(3); // start of para 1 (after the "\n")
    expect(cellGlobalOffset("AB\ncd", 1, 2)).toBe(5);
  });

  it("cellGlobalOffset clamps para and offset instead of throwing", () => {
    expect(cellGlobalOffset("AB\ncd", 9, 0)).toBe(3); // para clamps to the last paragraph
    expect(cellGlobalOffset("AB\ncd", 0, 99)).toBe(2); // offset clamps to paraLen
    expect(cellGlobalOffset("AB\ncd", 0, -3)).toBe(0);
  });

  it("cellParaOffsetAt is the inverse (incl. the separator boundary → next paragraph's start)", () => {
    expect(cellParaOffsetAt("AB\ncd", 0)).toEqual({ para: 0, offset: 0, paraLen: 2 });
    expect(cellParaOffsetAt("AB\ncd", 2)).toEqual({ para: 0, offset: 2, paraLen: 2 });
    expect(cellParaOffsetAt("AB\ncd", 3)).toEqual({ para: 1, offset: 0, paraLen: 2 });
    expect(cellParaOffsetAt("AB\ncd", 5)).toEqual({ para: 1, offset: 2, paraLen: 2 });
    expect(cellParaOffsetAt("AB\ncd", 99)).toEqual({ para: 1, offset: 2, paraLen: 2 }); // clamps
  });
});

describe("spliceRuns (style-preserving run splice)", () => {
  it("inserting inside a styled run inherits and merges into it", () => {
    expect(spliceRuns([{ text: "AB", bold: true }], 1, 0, "X")).toEqual([{ text: "AXB", bold: true }]);
  });

  it("inserting at position 0 of a styled cell inherits the FOLLOWING char's style", () => {
    expect(spliceRuns([{ text: "AB", bold: true }], 0, 0, "X")).toEqual([{ text: "XAB", bold: true }]);
  });

  it("typing right AFTER a separator inherits the next paragraph's style, not the bare \\n's", () => {
    const out = spliceRuns([{ text: "A", bold: true }, { text: "\n" }, { text: "b", italic: true }], 2, 0, "X");
    expect(out).toEqual([{ text: "A", bold: true }, { text: "\n" }, { text: "Xb", italic: true }]);
  });

  it("a typed \\n becomes a BARE separator run (paragraph split — SetTableCellRuns parity)", () => {
    expect(spliceRuns([{ text: "AB", bold: true }], 1, 0, "\n")).toEqual([
      { text: "A", bold: true },
      { text: "\n" },
      { text: "B", bold: true },
    ]);
  });

  it("deleting across the separator merges the paragraphs (Backspace at a paragraph start)", () => {
    // Joined "AB\ncd", delete the char ending at 3 (the "\n") → "ABcd"; styles preserved per side.
    expect(spliceRuns(twoParaRuns(), 3, 1, "")).toEqual([
      { text: "AB", bold: true },
      { text: "cd" },
    ]);
  });

  it("deleting the whole text yields ONE empty run (clear, not a no-op)", () => {
    expect(spliceRuns([{ text: "AB", bold: true }], 2, 2, "")).toEqual([{ text: "" }]);
  });

  it("typing into an EMPTY cell emits an unstyled run", () => {
    expect(spliceRuns([], 0, 0, "가")).toEqual([{ text: "가" }]);
    expect(spliceRuns([{ text: "" }], 0, 0, "가")).toEqual([{ text: "가" }]);
  });

  it("distinct neighbour styles stay distinct (no cross-run style bleed)", () => {
    const out = spliceRuns([{ text: "A", bold: true }, { text: "b" }], 1, 0, "X");
    expect(out).toEqual([{ text: "AX", bold: true }, { text: "b" }]);
  });
});

describe("inheritStyleAt (059 IME preview 스타일 소스 — the same inherit rule spliceRuns uses)", () => {
  it("takes the char BEFORE the caret when it's not a separator", () => {
    expect(inheritStyleAt([{ text: "AB", bold: true }], 1)).toEqual({ bold: true });
    expect(inheritStyleAt([{ text: "AB", bold: true }], 2)).toEqual({ bold: true }); // at the very end
  });
  it("at offset 0 inherits the FOLLOWING char's style (matches spliceRuns at 0)", () => {
    expect(inheritStyleAt([{ text: "AB", bold: true }], 0)).toEqual({ bold: true });
  });
  it("right after a separator inherits the next paragraph's style, not the bare \\n's", () => {
    const runs = [{ text: "A", bold: true }, { text: "\n" }, { text: "b", italic: true }];
    expect(inheritStyleAt(runs, 2)).toEqual({ italic: true });
  });
  it("an empty / fresh cell inherits nothing (unstyled)", () => {
    expect(inheritStyleAt([], 0)).toEqual({});
    expect(inheritStyleAt([{ text: "" }], 0)).toEqual({});
  });
});

describe("CellCaretController (headless click → caret → commit)", () => {
  function makeController(opts: ConstructorParameters<typeof MockAdapter>[0] = {}) {
    const adapter = new MockAdapter(opts);
    const session = new DocSession(adapter);
    return { adapter, session, ctl: new CellCaretController(adapter, session) };
  }

  it("is unsupported (and clickAt resolves null) when the adapter omits the cell caret queries", async () => {
    const { ctl } = makeController({}); // no cellText/cellCaret opts → methods absent
    expect(ctl.supported).toBe(false);
    expect(await ctl.clickAt(0, 5, 5)).toBeNull();
    expect(ctl.get()).toBeNull();
  });

  it("clickAt sets the caret from a hit (offset clamped into para_len) and emits", async () => {
    const { ctl } = makeController({ cellText: hit({ offset: 99, para_len: 2 }), cellCaret: cellRect, runs: twoParaRuns() });
    const seen: (ReturnType<typeof ctl.get>)[] = [];
    ctl.onChange((s) => seen.push(s));
    const s = await ctl.clickAt(0, 5, 5);
    expect(s?.anchor).toEqual({ section: 0, block: 1, row: 0, col: 0, para: 0, offset: 2, paraLen: 2 });
    expect(s?.rect).toEqual(cellRect);
    expect(seen).toHaveLength(1);
  });

  it("clickAt off any cell text clears the caret (018 null)", async () => {
    const { ctl } = makeController({ cellText: (_p, x) => (x < 10 ? hit() : null), cellCaret: cellRect, runs: twoParaRuns() });
    await ctl.clickAt(0, 5, 5);
    expect(ctl.get()).not.toBeNull();
    expect(await ctl.clickAt(0, 50, 5)).toBeNull();
    expect(ctl.get()).toBeNull();
  });

  it("move clamps to [0, paraLen] and re-queries the rect at the new offset", async () => {
    const asked: number[] = [];
    const { ctl } = makeController({
      cellText: hit({ offset: 1, para_len: 2 }),
      cellCaret: (_s, _b, _r, _c, _p, offset) => {
        asked.push(offset);
        return { ...cellRect, x: 100 + offset };
      },
      runs: twoParaRuns(),
    });
    await ctl.clickAt(0, 5, 5);
    const right = await ctl.move(+1);
    expect(right?.anchor.offset).toBe(2);
    const clamped = await ctl.move(+5);
    expect(clamped?.anchor.offset).toBe(2); // already at the end — clamped, no drift past paraLen
    const left = await ctl.move(-99);
    expect(left?.anchor.offset).toBe(0);
    expect(asked).toEqual([2, 2, 0]);
    expect(left?.rect.x).toBe(100);
  });

  it("insertText commits ONE SetTableCellRuns with the spliced runs and advances the caret", async () => {
    const { adapter, session, ctl } = makeController({
      cellText: hit({ para: 0, offset: 1, para_len: 2 }),
      cellCaret: cellRect,
      runs: twoParaRuns(),
    });
    await ctl.clickAt(0, 5, 5);
    expect(await ctl.insertText("X")).toBe(true);
    expect(adapter.applied).toHaveLength(1);
    expect(adapter.applied[0]).toEqual({
      intent: "SetTableCellRuns",
      section: 0,
      index: 1,
      row: 0,
      col: 0,
      runs: [{ text: "AXB", bold: true }, { text: "\n" }, { text: "cd" }],
    });
    expect(ctl.get()?.anchor).toMatchObject({ para: 0, offset: 2, paraLen: 3 });
    expect(session.canUndo()).toBe(true); // one keystroke = one undo unit
  });

  it("styleAtCaret returns the run style the composed/typed text will take (059) — no intent", async () => {
    const { adapter, ctl } = makeController({
      cellText: hit({ para: 0, offset: 0, para_len: 2 }),
      cellCaret: cellRect,
      runs: [{ text: "AB", bold: true }],
    });
    expect(await ctl.styleAtCaret()).toBeNull(); // no caret yet
    await ctl.clickAt(0, 5, 5);
    expect(await ctl.styleAtCaret()).toEqual({ bold: true }); // inherits the bold run at offset 0
    expect(adapter.applied).toHaveLength(0); // read-only — never a commit
  });

  it("styleAtCaret is null on a backend without the cell caret queries (018 feature-off)", async () => {
    const { ctl } = makeController({}); // no cellText/cellCaret → unsupported
    expect(await ctl.styleAtCaret()).toBeNull();
  });

  it("Enter (insertText '\\n') splits the paragraph and lands at the next paragraph's start", async () => {
    const { adapter, ctl } = makeController({
      cellText: hit({ para: 0, offset: 1, para_len: 2 }),
      cellCaret: cellRect,
      runs: [{ text: "AB", bold: true }],
    });
    await ctl.clickAt(0, 5, 5);
    await ctl.insertText("\n");
    expect((adapter.applied[0] as { runs: RunSpec[] }).runs).toEqual([
      { text: "A", bold: true },
      { text: "\n" },
      { text: "B", bold: true },
    ]);
    expect(ctl.get()?.anchor).toMatchObject({ para: 1, offset: 0, paraLen: 1 });
  });

  it("deleteBack at a paragraph start deletes the separator (merges paragraphs)", async () => {
    const { adapter, ctl } = makeController({
      cellText: hit({ para: 1, offset: 0, para_len: 2 }),
      cellCaret: cellRect,
      runs: twoParaRuns(),
    });
    await ctl.clickAt(0, 5, 5);
    expect(await ctl.deleteBack()).toBe(true);
    expect((adapter.applied[0] as { runs: RunSpec[] }).runs).toEqual([{ text: "AB", bold: true }, { text: "cd" }]);
    expect(ctl.get()?.anchor).toMatchObject({ para: 0, offset: 2, paraLen: 4 }); // caret at the join
  });

  it("deleteBack at the very start of the cell is a graceful no-op (no intent)", async () => {
    const { adapter, ctl } = makeController({
      cellText: hit({ para: 0, offset: 0, para_len: 2 }),
      cellCaret: cellRect,
      runs: twoParaRuns(),
    });
    await ctl.clickAt(0, 5, 5);
    expect(await ctl.deleteBack()).toBe(false);
    expect(adapter.applied).toHaveLength(0);
  });

  it("clears the caret (018) when the post-commit rect no longer resolves — the edit still stands", async () => {
    let answer = true;
    const { adapter, ctl } = makeController({
      cellText: hit(),
      cellCaret: () => (answer ? cellRect : null),
      runs: twoParaRuns(),
    });
    await ctl.clickAt(0, 5, 5);
    answer = false;
    expect(await ctl.insertText("X")).toBe(true);
    expect(adapter.applied).toHaveLength(1); // the commit happened
    expect(ctl.get()).toBeNull(); // the caret honestly went away
  });

  it("chains fast keystrokes strictly in order (each commit is its own undo unit)", async () => {
    const { adapter, session, ctl } = makeController({
      cellText: hit({ para: 0, offset: 2, para_len: 2 }),
      cellCaret: cellRect,
      runs: [{ text: "AB", bold: true }],
    });
    await ctl.clickAt(0, 5, 5);
    // Fire without awaiting — the controller's chain must serialize them.
    const p1 = ctl.insertText("1");
    const p2 = ctl.insertText("2");
    await Promise.all([p1, p2]);
    expect(adapter.applied).toHaveLength(2);
    // The mock's blockRuns is a FROZEN read ("AB" both times), so the 2nd commit re-splices the
    // frozen text — order (not content accumulation) is what this pins.
    expect((adapter.applied[0] as { runs: RunSpec[] }).runs).toEqual([{ text: "AB1", bold: true }]);
    expect((adapter.applied[1] as { runs: RunSpec[] }).runs).toEqual([{ text: "AB2", bold: true }]);
    expect(session.canUndo()).toBe(true);
  });
});
