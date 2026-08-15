import { describe, expect, it } from "vitest";
import { CellCaretController, cellGlobalOffset, cellParaOffsetAt, inheritStyleAt, runsText, spliceRuns } from "../cellCaret";
import { DocSession } from "../session";
import type { CellCaretRect, CellTextHit, Intent, RunSpec } from "../types";
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
    // selAnchor === offset ⇒ 범위 없는 순수 캐럿(범위 선택의 기본 상태).
    expect(s?.anchor).toEqual({ section: 0, block: 1, row: 0, col: 0, para: 0, offset: 2, selAnchor: 2, paraLen: 2 });
    expect(s?.rects).toEqual([]);
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
    // 같은 주소의 오프셋 기하는 메모된다(범위 하이라이트가 오프셋을 훑기 때문) — 두 번째 2는 캐시 히트.
    expect(asked).toEqual([2, 0]);
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
    expect((adapter.applied[0] as Intent & { runs: RunSpec[] }).runs).toEqual([
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
    expect((adapter.applied[0] as Intent & { runs: RunSpec[] }).runs).toEqual([{ text: "AB", bold: true }, { text: "cd" }]);
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

  // ── 범위 선택 — 본문 캐럿과 **같은 규약**({anchor, focus}), 기하만 엔진 probe 로 얻는다 ──────────

  /** 폭 10짜리 글자가 3개마다 접히는 셀(엔진 계약: 줄바꿈 경계 오프셋은 다음 줄 시작). */
  const wrappingCell = (_s: number, _b: number, _r: number, _c: number, _p: number, offset: number): CellCaretRect => ({
    page: 0,
    x: 100 + (offset % 3) * 10,
    top: 200 + Math.floor(offset / 3) * 20,
    height: 13,
  });

  it("Shift+←/→는 고정단을 두고 범위를 넓히며, 줄별 하이라이트를 낸다", async () => {
    const { adapter, ctl } = makeController({
      cellText: hit({ para: 0, offset: 0, para_len: 5 }),
      cellCaret: wrappingCell,
      runs: [{ text: "ABCDE" }],
    });
    await ctl.clickAt(0, 5, 5);
    await ctl.extend(2);
    expect(ctl.get()!.anchor).toMatchObject({ selAnchor: 0, offset: 2 });
    expect(ctl.get()!.rects).toEqual([{ page: 0, x: 100, top: 200, width: 20, height: 13 }]);
    await ctl.extend(2); // 줄을 넘겨 4까지 → 두 줄
    expect(ctl.get()!.rects).toHaveLength(2);
    expect(adapter.applied).toHaveLength(0); // 선택은 읽기 전용
  });

  it("바깥 편집(⌘Z 등)으로 레이아웃이 무효화되면 캐시된 기하를 버리고 다시 물어본다", async () => {
    const asked: number[] = [];
    const { session, ctl } = makeController({
      cellText: hit({ para: 0, offset: 1, para_len: 5 }),
      cellCaret: (_s, _b, _r, _c, _p, offset) => {
        asked.push(offset);
        return { ...cellRect, x: 100 + offset };
      },
      runs: [{ text: "ABCDE" }],
    });
    await ctl.clickAt(0, 5, 5); // offset 1 — 기하는 히트가 들고 온다(물어보지 않는다)
    await ctl.move(1); // → 2 (물어봄)
    await ctl.move(-1); // → 1 (물어봄)
    const n = asked.length;
    await ctl.move(1); // → 2 다시 (캐시 히트 — 엔진 왕복 0)
    expect(asked).toHaveLength(n);
    // 캐럿을 거치지 않은 바깥 편집(AI 적용/툴바/⌘Z) — 레이아웃 무효화 → 캐시된 기하는 거짓말이 된다.
    await session.applyBatch([{ intent: "SetParagraphText", section: 0, block: 0, text: "바깥" }]);
    await ctl.move(-1);
    expect(asked.length).toBeGreaterThan(n); // 캐시를 버리고 다시 물어봤다
  });

  it("범위가 있으면 방향키는 가까운 끝으로 접히고, ⌘A는 셀 문단 전체를 잡는다", async () => {
    const { ctl } = makeController({
      cellText: hit({ para: 0, offset: 1, para_len: 5 }),
      cellCaret: wrappingCell,
      runs: [{ text: "ABCDE" }],
    });
    await ctl.clickAt(0, 5, 5);
    await ctl.extend(2); // [1,3)
    await ctl.move(-1);
    expect(ctl.get()!.anchor).toMatchObject({ offset: 1, selAnchor: 1 });
    await ctl.selectAll();
    expect(ctl.get()!.anchor).toMatchObject({ selAnchor: 0, offset: 5 });
  });

  it("범위 위 타이핑은 대체, Backspace는 범위 삭제 — 각각 SetTableCellRuns 하나", async () => {
    const base = { cellText: hit({ para: 0, offset: 0, para_len: 2 }), cellCaret: cellRect, runs: twoParaRuns() };
    const typed = makeController(base);
    await typed.ctl.clickAt(0, 5, 5);
    await typed.ctl.extend(2); // "AB" 선택
    expect(await typed.ctl.insertText("X")).toBe(true);
    expect((typed.adapter.applied[0] as Intent & { runs: RunSpec[] }).runs).toEqual([{ text: "X" }, { text: "\n" }, { text: "cd" }]);

    const erased = makeController(base);
    await erased.ctl.clickAt(0, 5, 5);
    await erased.ctl.extend(2);
    expect(await erased.ctl.deleteBack()).toBe(true);
    // 첫 문단이 비면 그 앞엔 아무 런도 남지 않는다(구분자 "\n" 이 곧 빈 문단의 경계 — blockRuns 왕복 규약).
    expect((erased.adapter.applied[0] as Intent & { runs: RunSpec[] }).runs).toEqual([{ text: "\n" }, { text: "cd" }]);
  });

  it("범위 ⌘B는 셀 텍스트의 그 구간만 굵게 — 두 번째 문단은 건드리지 않는다", async () => {
    const { adapter, ctl } = makeController({
      cellText: hit({ para: 1, offset: 0, para_len: 2 }),
      cellCaret: cellRect,
      runs: () => [{ text: "AB", bold: true }, { text: "\n" }, { text: "cd" }],
    });
    await ctl.clickAt(0, 5, 5); // 두 번째 문단("cd")의 맨 앞
    await ctl.extend(2);
    expect(await ctl.toggleStyle("bold")).toBe(true);
    expect((adapter.applied[0] as Intent & { runs: RunSpec[] }).runs).toEqual([
      { text: "AB", bold: true },
      { text: "\n" },
      { text: "cd", bold: true },
    ]);
  });

  it("Shift+클릭은 같은 셀 문단이면 범위를 잇고, 다른 셀이면 새 캐럿", async () => {
    const { ctl } = makeController({
      cellText: (_p, x) => (x < 10 ? hit({ para: 0, offset: 0, para_len: 5 }) : hit({ col: 1, para: 0, offset: 3, para_len: 5 })),
      cellCaret: wrappingCell,
      runs: [{ text: "ABCDE" }],
    });
    await ctl.clickAt(0, 5, 5);
    await ctl.clickAt(0, 5, 5, true); // 같은 셀 — 고정단 유지
    expect(ctl.get()!.anchor.selAnchor).toBe(0);
    await ctl.clickAt(0, 50, 5, true); // 다른 셀 — 새 캐럿(범위 없음)
    expect(ctl.get()!.anchor).toMatchObject({ col: 1, selAnchor: 3, offset: 3 });
    expect(ctl.get()!.rects).toEqual([]);
  });

  it("마우스 드래그는 같은 셀 문단의 범위를 만들고 대체 입력은 SetTableCellRuns만 낸다", async () => {
    const { adapter, ctl } = makeController({
      cellText: (page, x) => {
        const offset = x < 20 ? 0 : 2;
        return hit({ offset, para_len: 2, caret: { page, x: 100 + offset * 10, top: 200, height: 13 } });
      },
      cellCaret: wrappingCell,
      runs: [{ text: "AB", bold: true }],
    });
    await ctl.clickAt(0, 5, 5);
    expect(await ctl.beginDragAt(0, 5, 5)).toBe(true);
    expect(await ctl.dragTo(0, 50, 5)).toBe(true);
    ctl.endDrag();
    expect(ctl.get()!.anchor).toMatchObject({ selAnchor: 0, offset: 2, paraLen: 2 });
    expect(ctl.get()!.rects).toHaveLength(1);

    expect(await ctl.insertText("X")).toBe(true);
    expect(adapter.applied).toHaveLength(1);
    expect(adapter.applied.every((i) => i.intent === "SetTableCellRuns")).toBe(true); // mutation: 평문 variant 금지
    // 전체 런을 지운 뒤의 삽입은 물려받을 이웃 글자가 없으므로 안전한 무서식 런이다.
    expect((adapter.applied[0] as Intent & { runs: RunSpec[] }).runs).toEqual([{ text: "X" }]);
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
    expect((adapter.applied[0] as Intent & { runs: RunSpec[] }).runs).toEqual([{ text: "AB1", bold: true }]);
    expect((adapter.applied[1] as Intent & { runs: RunSpec[] }).runs).toEqual([{ text: "AB2", bold: true }]);
    expect(session.canUndo()).toBe(true);
  });

  it("a nested hit commits SetTableCellRuns.path and does not plant outer flat coords", async () => {
    const path = [
      { block: 1, row: 0, col: 0 },
      { block: 0, row: 0, col: 0 },
    ];
    const { adapter, ctl } = makeController({
      cellText: hit({
        row: undefined,
        col: undefined,
        path,
        offset: 1,
        para_len: 3,
      }),
      cellCaret: cellRect,
      runs: [{ text: "WRONG" }],
      runsPath: [{ text: "ABC" }],
    });
    await ctl.clickAt(0, 5, 5);
    expect(ctl.get()?.anchor.path).toEqual(path);
    expect(await ctl.insertText("X")).toBe(true);
    expect(adapter.applied[0]).toEqual({
      intent: "SetTableCellRuns",
      section: 0,
      index: 1,
      row: 0,
      col: 0,
      path,
      runs: [{ text: "AXBC" }],
    });
  });

  it("Home/End move to the first/last offset of the current visual line", async () => {
    const { ctl } = makeController({
      cellText: hit({ offset: 2, para_len: 5 }),
      cellCaret: (_s, _b, _r, _c, _p, offset) => ({
        page: 0,
        x: 100 + offset * 10,
        top: offset < 3 ? 200 : 220,
        height: 13,
      }),
      runs: [{ text: "ABCDE" }],
    });
    await ctl.clickAt(0, 5, 5);
    const home = await ctl.moveToLineEnd("start");
    expect(home?.anchor.offset).toBe(0);
    expect(home?.rect.x).toBe(100);
    await ctl.move(4);
    const end = await ctl.moveToLineEnd("end");
    expect(end?.anchor.offset).toBe(5);
    expect(end?.rect.top).toBe(220);
  });
});
