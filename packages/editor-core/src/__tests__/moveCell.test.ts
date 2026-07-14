import { describe, expect, it } from "vitest";
import { SelectionModel } from "../selection";
import type { CellHit, TableBox } from "../types";
import { MockAdapter } from "./mockAdapter";

// Keyboard cell navigation (issue 036): SelectionModel.moveCell(dir) moves the active CELL selection one
// cell in `dir` by RE-PROBING the adapter's `tableCellAt` a few px past the current cell's box edge (there
// is no engine "cell box by address" query). 4-directional move + boundary clamp + split-table page
// transition (전역 row). Pure node — no jsdom, page px fed directly (SDK-LAYERS §함정).
//
// Figma drill (issue 06x): a SINGLE click now marks the whole table, so a cell is selected via `drillInto`
// (the double-click / Enter path). `click` here drills so moveCell has a live CELL to navigate from.
async function click(m: SelectionModel, page: number, x: number, y: number) {
  await m.drillInto(page, x, y);
}
const addr = (m: SelectionModel) => {
  const a = m.getAnchors()[0];
  return a ? { row: a.rows?.[0], col: a.cols?.[0], page: a.page } : null;
};

// A single-page 2-col × 3-row grid, each cell 100×50 px starting at the page origin. A coordinate-aware
// `cell` resolver maps a point → the containing cell (null off the 200×150 table). The cell box always
// spans exactly its column/row, so a probe a few px past an edge lands in the neighbour (or off-table).
const GRID: TableBox = { section: 0, block: 1, x: 0, y: 0, w: 200, h: 150, rows: 3, cols: 2, first_row: 0 };
const gridCell = (_p: number, x: number, y: number): CellHit | null => {
  if (x < 0 || y < 0 || x >= 200 || y >= 150) return null;
  const col = Math.min(1, Math.floor(x / 100));
  const row = Math.min(2, Math.floor(y / 50));
  return { section: 0, block: 1, row, col, rows: 3, cols: 2, text: `r${row}c${col}`, x: col * 100, y: row * 50, w: 100, h: 50 };
};

describe("SelectionModel.moveCell — 4 directions + boundary clamp (issue 036)", () => {
  const mk = () => new SelectionModel(new MockAdapter({ pages: 1, table: GRID, cell: gridCell }));

  it("right / down / left / up move to the adjacent cell", async () => {
    const m = mk();
    await click(m, 0, 50, 25); // (0,0)
    expect(addr(m)).toEqual({ row: 0, col: 0, page: 0 });

    expect(await m.moveCell("right")).toBe(true);
    expect(addr(m)).toEqual({ row: 0, col: 1, page: 0 });

    expect(await m.moveCell("down")).toBe(true);
    expect(addr(m)).toEqual({ row: 1, col: 1, page: 0 });

    expect(await m.moveCell("left")).toBe(true);
    expect(addr(m)).toEqual({ row: 1, col: 0, page: 0 });

    expect(await m.moveCell("up")).toBe(true);
    expect(addr(m)).toEqual({ row: 0, col: 0, page: 0 });
  });

  it("a move never accumulates — it REPLACES the selection (one chip)", async () => {
    const m = mk();
    await click(m, 0, 50, 25);
    await m.moveCell("right");
    await m.moveCell("down");
    expect(m.getSelection()).toHaveLength(1);
    expect(m.getMarks()[0].kind).toBe("cell");
  });

  it("clamps at the LEFT/TOP boundary (no move, stays put)", async () => {
    const m = mk();
    await click(m, 0, 50, 25); // (0,0) — top-left corner
    expect(await m.moveCell("left")).toBe(false);
    expect(await m.moveCell("up")).toBe(false);
    expect(addr(m)).toEqual({ row: 0, col: 0, page: 0 });
  });

  it("clamps at the RIGHT/BOTTOM boundary (single page → no next fragment)", async () => {
    const m = mk();
    await click(m, 0, 150, 125); // (2,1) — bottom-right corner
    expect(addr(m)).toEqual({ row: 2, col: 1, page: 0 });
    expect(await m.moveCell("right")).toBe(false);
    expect(await m.moveCell("down")).toBe(false); // no rowBoundaries + single page → clamp
    expect(addr(m)).toEqual({ row: 2, col: 1, page: 0 });
  });

  it("no-op when nothing (or a non-cell) is selected", async () => {
    const m = mk();
    expect(await m.moveCell("right")).toBe(false); // empty selection
    m.clear();
    expect(await m.moveCell("down")).toBe(false);
  });

  it("a backend without tableCellAt cannot navigate (graceful false)", async () => {
    // No `cell` opt → MockAdapter omits tableCellAt (reference TauriAdapter parity).
    const m = new SelectionModel(new MockAdapter({ pages: 1, table: GRID }));
    await click(m, 0, 50, 25); // whole-table anchor (not a cell)
    expect(await m.moveCell("right")).toBe(false);
  });
});

// A split table (section 0, block 3): a 5-row × 1-col table whose GLOBAL rows 0..2 render on page 0 and
// rows 3..4 on page 1 (each fragment rebased to its page top). moveCell down off the page-0 fragment
// bottom lands on page 1's fragment top (전역 row → row 3), and up from page 1 returns to page 0 row 2.
const splitCell = (page: number, x: number, y: number): CellHit | null => {
  if (x < 0 || x >= 100) return null;
  if (page === 0) {
    if (y < 0 || y >= 150) return null; // 3 rows × 50px on page 0
    const row = Math.floor(y / 50); // global rows 0,1,2
    return { section: 0, block: 3, row, col: 0, rows: 5, cols: 1, text: `r${row}`, x: 0, y: row * 50, w: 100, h: 50 };
  }
  if (page === 1) {
    if (y < 0 || y >= 100) return null; // 2 rows × 50px on page 1 (fragment rebased to top)
    const row = 3 + Math.floor(y / 50); // global rows 3,4
    return { section: 0, block: 3, row, col: 0, rows: 5, cols: 1, text: `r${row}`, x: 0, y: (row - 3) * 50, w: 100, h: 50 };
  }
  return null;
};
// Per-page fragment row boundaries (own-render px, rebased to the fragment top — issue 023/031).
const splitRowB = (page: number): number[] | null => (page === 0 ? [0, 50, 100, 150] : page === 1 ? [0, 50, 100] : null);

describe("SelectionModel.moveCell — split table page transition (전역 row, issue 036)", () => {
  const mk = () =>
    new SelectionModel(
      new MockAdapter({
        pages: 2,
        table: (p: number) => (p <= 1 ? { section: 0, block: 3, x: 0, y: 0, w: 100, h: p === 0 ? 150 : 100, rows: 5, cols: 1, first_row: p === 0 ? 0 : 3 } : null),
        cell: splitCell,
        rowBoundaries: (p: number) => splitRowB(p),
      }),
    );

  it("down off the page-0 fragment bottom → page 1 fragment top (global row 2 → 3)", async () => {
    const m = mk();
    await click(m, 0, 50, 125); // global row 2 on page 0
    expect(addr(m)).toEqual({ row: 2, col: 0, page: 0 });
    expect(await m.moveCell("down")).toBe(true);
    expect(addr(m)).toEqual({ row: 3, col: 0, page: 1 }); // next fragment, next page
  });

  it("up off the page-1 fragment top → page 0 fragment bottom (global row 3 → 2)", async () => {
    const m = mk();
    await click(m, 1, 50, 25); // global row 3 on page 1
    expect(addr(m)).toEqual({ row: 3, col: 0, page: 1 });
    expect(await m.moveCell("up")).toBe(true);
    expect(addr(m)).toEqual({ row: 2, col: 0, page: 0 }); // prev fragment, prev page
  });

  it("down from the very last global row clamps (no page 2 fragment)", async () => {
    const m = mk();
    await click(m, 1, 50, 75); // global row 4 (last)
    expect(addr(m)).toEqual({ row: 4, col: 0, page: 1 });
    expect(await m.moveCell("down")).toBe(false);
    expect(addr(m)).toEqual({ row: 4, col: 0, page: 1 });
  });

  it("within a page fragment still uses the fast same-page probe", async () => {
    const m = mk();
    await click(m, 0, 50, 25); // global row 0
    expect(await m.moveCell("down")).toBe(true);
    expect(addr(m)).toEqual({ row: 1, col: 0, page: 0 }); // stayed on page 0
  });
});
