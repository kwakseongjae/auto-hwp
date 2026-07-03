import { describe, expect, it } from "vitest";
import { SelectionModel } from "../selection";
import type { BlockHit, CellHit, PointerInput, TableBox } from "../types";
import { MockAdapter } from "./mockAdapter";

// The @tf-hwp/react selection.model.test.tsx scenarios (issues 021 + 023) PORTED to node: DOM pointer
// events → pure `pointerDown({page,x,y,mod})` inputs. No jsdom, no getBoundingClientRect stub — the UI's
// client-px → page-px conversion stays in @tf-hwp/react; here we feed page px directly (SDK-LAYERS §함정).

const para = (block: number, y: number, h: number, text: string): BlockHit => ({
  section: 0,
  block,
  kind: "paragraph",
  x: 0,
  y,
  w: 794,
  h,
  text,
  editable: true,
});

const pd = (page: number, x: number, y: number, mod = false): PointerInput => ({ page, x, y, mod });

const anchors = (m: SelectionModel) => m.getAnchors();
const labels = (m: SelectionModel) => m.getAnchors().map((a) => a.label);
const chips = (m: SelectionModel) => m.getSelection().length;

async function click(m: SelectionModel, page: number, x: number, y: number, mod = false) {
  await m.pointerDown(pd(page, x, y, mod));
  await m.pointerUp();
}

describe("SelectionModel — replace/toggle/marquee (issue 021)", () => {
  it("click REPLACES the selection (never accumulates)", async () => {
    const m = new SelectionModel(new MockAdapter({ pages: 1, hit: (_p, _x, y) => (y < 400 ? para(1, 0, 400, "블록 하나") : para(2, 400, 723, "블록 둘")) }));
    await click(m, 0, 100, 100);
    expect(chips(m)).toBe(1);
    expect(labels(m)[0]).toContain("블록 하나");

    // A second click on a DIFFERENT block replaces (still exactly one chip).
    await click(m, 0, 100, 800);
    expect(chips(m)).toBe(1);
    expect(labels(m)[0]).toContain("블록 둘");
  });

  it("⌘/Ctrl+click TOGGLES a block in and out of the selection", async () => {
    const m = new SelectionModel(new MockAdapter({ pages: 1, hit: para(3, 0, 1123, "토글 대상") }));
    await click(m, 0, 100, 100, true);
    expect(chips(m)).toBe(1); // absent → added
    await click(m, 0, 100, 100, true);
    expect(chips(m)).toBe(0); // present → removed
  });

  it("empty-area drag = marquee; ⌘/Ctrl UNION adds the crossed blocks to the selection", async () => {
    const m = new SelectionModel(
      new MockAdapter({
        pages: 1,
        hit: (_p, _x, y) => (y < 300 ? para(1, 0, 300, "머리 블록") : null), // below 300 is EMPTY (marquee eligible)
        blocks: [para(5, 400, 200, "표 아래 하나"), para(6, 620, 200, "표 아래 둘")],
      }),
    );
    // First a plain click selects the head block.
    await click(m, 0, 100, 100);
    expect(chips(m)).toBe(1);

    // Then a ⌘/Ctrl marquee over the empty lower area unions two more blocks in.
    await m.pointerDown(pd(0, 80, 600, true)); // await → the async "empty" probe lands
    m.pointerMove(pd(0, 300, 900, true));
    expect(m.getMarquee()).toBeTruthy();
    await m.pointerUp();
    expect(chips(m)).toBe(3);
    expect(m.getMarquee()).toBeNull(); // rect cleared on release
    const all = labels(m).join(" ");
    expect(all).toContain("머리 블록");
    expect(all).toContain("표 아래 하나");
    expect(all).toContain("표 아래 둘");
  });

  it("a drag from a BLOCK (non-empty) does NOT marquee", async () => {
    const m = new SelectionModel(new MockAdapter({ pages: 1, hit: para(1, 0, 1123, "블록"), blocks: [para(9, 0, 100, "안됨")] }));
    await m.pointerDown(pd(0, 100, 100)); // press lands on a block → not empty
    m.pointerMove(pd(0, 400, 400));
    expect(m.getMarquee()).toBeNull(); // no marquee from a block-origin drag
    await m.pointerUp();
    expect(chips(m)).toBe(1); // resolved as a click on the block
  });

  it("clear() empties the whole selection (Esc analog)", async () => {
    const m = new SelectionModel(new MockAdapter({ pages: 1, hit: para(2, 0, 1123, "선택") }));
    await click(m, 0, 100, 100);
    expect(chips(m)).toBe(1);
    m.clear();
    expect(chips(m)).toBe(0);
  });
});

// Cell-level marking (issue 023): a click inside a table anchors the exact CELL (chip = snippet + "N행
// M열", 1-based, global row/col), ⌘/Ctrl toggles the exact clicked cell, and cells mix with block
// anchors. A 3×2 table fills the top of the page; a coordinate-aware `cell` resolver maps a point to
// (row,col). Mirrors the @tf-hwp/react cell scenarios.
const CELL_TABLE: TableBox = { section: 0, block: 1, x: 0, y: 0, w: 794, h: 780, rows: 3, cols: 2, first_row: 0 };
const cellAt = (_p: number, x: number, y: number): CellHit => {
  const row = y < 260 ? 0 : y < 520 ? 1 : 2;
  const col = x < 397 ? 0 : 1;
  const text = row === 1 && col === 0 ? "1-2. 제품·서비스의 개요 설명" : row === 0 ? "항목" : "";
  return { section: 0, block: 1, row, col, rows: 3, cols: 2, text, x: col * 397, y: row * 260, w: 397, h: 260 };
};

describe("SelectionModel — cell-level marking (issue 023)", () => {
  it("click inside a table anchors the exact CELL (snippet + 1-based N행 M열, global coords)", async () => {
    const m = new SelectionModel(new MockAdapter({ pages: 1, table: CELL_TABLE, cell: cellAt }));
    await click(m, 0, 100, 390); // row 1, col 0
    expect(chips(m)).toBe(1);
    const label = labels(m)[0];
    expect(label).toContain("2행 1열"); // row 1 → 2행, col 0 → 1열
    expect(label).toContain("제품");
    expect(m.getMarks()[0].kind).toBe("cell"); // the green cell mark, not the whole-table mark
    expect(anchors(m)[0].kind).toBe("cell");
    expect(anchors(m)[0].rows).toEqual([1, 1]);
    expect(anchors(m)[0].cols).toEqual([0, 0]);
  });

  it("a plain click on ANOTHER cell replaces (still one chip, new address)", async () => {
    const m = new SelectionModel(new MockAdapter({ pages: 1, table: CELL_TABLE, cell: cellAt }));
    await click(m, 0, 100, 100); // row 0 col 0
    expect(labels(m)[0]).toContain("1행 1열");
    await click(m, 0, 600, 650); // row 2 col 1
    expect(labels(m)[0]).toContain("3행 2열");
    expect(chips(m)).toBe(1);
  });

  it("⌘/Ctrl+click TOGGLES the exact clicked cell in and out", async () => {
    const m = new SelectionModel(new MockAdapter({ pages: 1, table: CELL_TABLE, cell: cellAt }));
    await click(m, 0, 100, 390, true);
    expect(chips(m)).toBe(1);
    await click(m, 0, 100, 390, true); // SAME cell
    expect(chips(m)).toBe(0);
  });

  it("two DIFFERENT cells of the same table accumulate under ⌘/Ctrl (distinct identity)", async () => {
    const m = new SelectionModel(new MockAdapter({ pages: 1, table: CELL_TABLE, cell: cellAt }));
    await click(m, 0, 100, 100); // row 0 col 0
    expect(chips(m)).toBe(1);
    await click(m, 0, 100, 390, true); // row 1 col 0 — different cell, same table
    expect(chips(m)).toBe(2);
    const all = labels(m).join(" ");
    expect(all).toContain("1행 1열");
    expect(all).toContain("2행 1열");
  });

  it("cell + block MIXED selection: a cell anchor coexists with a ⌘-added paragraph", async () => {
    const m = new SelectionModel(
      new MockAdapter({
        pages: 1,
        table: (_p, _x, y) => (y < 500 ? CELL_TABLE : null),
        cell: (_p, x, y) => (y < 500 ? cellAt(_p, x, y) : null),
        hit: (_p, _x, y) => (y >= 500 ? para(7, 500, 400, "결론 문단") : null),
      }),
    );
    await click(m, 0, 100, 100); // a cell
    expect(chips(m)).toBe(1);
    await click(m, 0, 100, 700, true); // ⌘-click the paragraph below the table
    expect(chips(m)).toBe(2);
    const all = labels(m).join(" ");
    expect(all).toContain("1행 1열");
    expect(all).toContain("결론 문단");
  });

  it("split-table fragment: the anchor keeps the GLOBAL row (no fragment-local reset)", async () => {
    const splitCell: CellHit = { section: 0, block: 3, row: 15, col: 1, rows: 20, cols: 2, text: "분할표 하단 셀", x: 100, y: 40, w: 300, h: 44 };
    const m = new SelectionModel(new MockAdapter({ pages: 2, table: { section: 0, block: 3, x: 0, y: 0, w: 794, h: 900, rows: 20, cols: 2, first_row: 12 }, cell: () => splitCell }));
    await click(m, 1, 200, 200);
    expect(chips(m)).toBe(1);
    expect(labels(m)[0]).toContain("16행 2열"); // row 15 → 16행, col 1 → 2열 (global, 1-based)
    expect(anchors(m)[0].rows).toEqual([15, 15]);
  });

  it("without tableCellAt (backend omits it) a table click falls back to the whole-table anchor", async () => {
    // No `cell` opt → MockAdapter omits tableCellAt (reference TauriAdapter parity → 021 whole-table).
    const m = new SelectionModel(new MockAdapter({ pages: 1, table: CELL_TABLE }));
    await click(m, 0, 100, 100);
    expect(chips(m)).toBe(1);
    expect(m.getMarks()[0].kind).toBe("table");
    expect(anchors(m)[0].kind).toBe("table");
  });
});
