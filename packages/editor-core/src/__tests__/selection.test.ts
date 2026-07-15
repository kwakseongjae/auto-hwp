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

  it("a MULTI-PAGE marquee unions blocks from EVERY intersected page (per-page sub-rects)", async () => {
    // Empty everywhere (marquee-eligible); each page returns a DIFFERENT block for a rect query, so the
    // union must contain a block from BOTH pages. The React layer computes the per-page sub-rects; here we
    // feed them directly to `pointerMoveMultipage` (the DOM-free contract).
    const perPage: Record<number, BlockHit[]> = {
      0: [para(5, 800, 200, "1페이지 블록")],
      1: [para(9, 40, 200, "2페이지 블록")],
    };
    const m = new SelectionModel(
      new MockAdapter({
        pages: 2,
        hit: () => null, // empty → marquee eligible
        blocks: (page) => perPage[page] ?? [],
      }),
    );
    // Press on empty space on page 0, then drag down onto page 1. React supplies a slice per page.
    await m.pointerDown({ page: 0, x: 80, y: 850, mod: false, client: { x: 80, y: 850 } });
    m.pointerMoveMultipage({ x: 300, y: 300 }, [
      { page: 0, box: { x: 80, y: 780, w: 220, h: 300 } }, // lower part of page 0
      { page: 1, box: { x: 80, y: 0, w: 220, h: 240 } }, // upper part of page 1
    ]);
    const mq = m.getMarquee();
    expect(mq).toBeTruthy();
    expect(mq!.boxes?.length).toBe(2); // both pages carried in the marquee model
    await m.pointerUp();
    expect(chips(m)).toBe(2);
    const all = labels(m).join(" ");
    expect(all).toContain("1페이지 블록");
    expect(all).toContain("2페이지 블록");
    // The page-1 hit is stamped page 1 (blockHitToSel(h, page) per slice), not the start page.
    const p1 = anchors(m).find((a) => (a.text ?? "").includes("2페이지"));
    expect(p1?.page).toBe(1);
    expect(m.getMarquee()).toBeNull(); // rect cleared on release
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

  it("a click on EMPTY space inside a page DESELECTS (nearest-band fallback must not grab a paragraph)", async () => {
    // Engine `block_at` returns the vertically-NEAREST band even in a gap (ignores x), so hitTest is
    // non-null in empty white space but its box does NOT contain the point. finishClick re-checks strict
    // containment → a true empty-space click must CLEAR, not select the nearest paragraph. (QA regression.)
    const band = para(1, 0, 200, "본문 한 줄"); // occupies y 0..200; MockAdapter returns it for ANY point
    const m = new SelectionModel(new MockAdapter({ pages: 1, hit: band }));
    await click(m, 0, 100, 100); // inside the band → selects
    expect(chips(m)).toBe(1);
    await click(m, 0, 100, 900); // deep in empty space (band still the "nearest" hit) → must deselect
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

// Figma progressive table selection (issue 06x — SUPERSEDES the 023 single-click=cell model): a single
// click on a table now marks the WHOLE TABLE (drill level-0); `drillInto` (the double-click / Enter path)
// DESCENDS into the exact CELL and marks the table drilled, so subsequent plain clicks inside the SAME
// table keep selecting cells until the drill is reset (a click on a DIFFERENT table / paragraph / clear).
describe("SelectionModel — Figma table drill (issue 06x)", () => {
  it("(a) a single click inside a table anchors the WHOLE TABLE, not a cell", async () => {
    const m = new SelectionModel(new MockAdapter({ pages: 1, table: CELL_TABLE, cell: cellAt }));
    await click(m, 0, 100, 390); // would be row 1, col 0 — but a fresh click marks the whole table
    expect(chips(m)).toBe(1);
    expect(m.getMarks()[0].kind).toBe("table"); // the whole-table mark, never a green cell mark
    expect(anchors(m)[0].kind).toBe("table");
    expect(labels(m)[0]).toBe("표 (p.1)");
    expect(anchors(m)[0].rows).toBeUndefined();
    expect(anchors(m)[0].cols).toBeUndefined();
    expect(m.currentCell()).toBeNull();
  });

  it("(b) drillInto anchors the exact CELL (snippet + 1-based N행 M열, global coords)", async () => {
    const m = new SelectionModel(new MockAdapter({ pages: 1, table: CELL_TABLE, cell: cellAt }));
    const sel = await m.drillInto(0, 100, 390); // row 1, col 0
    expect(sel).not.toBeNull();
    expect(chips(m)).toBe(1);
    const label = labels(m)[0];
    expect(label).toContain("2행 1열"); // row 1 → 2행, col 0 → 1열
    expect(label).toContain("제품");
    expect(m.getMarks()[0].kind).toBe("cell"); // now the green cell mark
    expect(anchors(m)[0].kind).toBe("cell");
    expect(anchors(m)[0].rows).toEqual([1, 1]);
    expect(anchors(m)[0].cols).toEqual([0, 0]);
  });

  it("(c) after drilling, a plain click inside the SAME table yields the clicked CELL (drill persists)", async () => {
    const m = new SelectionModel(new MockAdapter({ pages: 1, table: CELL_TABLE, cell: cellAt }));
    await m.drillInto(0, 100, 390); // drill into row 1 col 0
    await click(m, 0, 600, 650); // a plain click on ANOTHER cell (row 2 col 1) of the SAME table
    expect(chips(m)).toBe(1);
    expect(anchors(m)[0].kind).toBe("cell");
    expect(labels(m)[0]).toContain("3행 2열");
    expect(m.currentCell()).toEqual({ section: 0, block: 1, row: 2, col: 1 });
  });

  it("(c) a plain click on a DIFFERENT table resets the drill to a whole-table anchor", async () => {
    const OTHER: TableBox = { section: 0, block: 5, x: 0, y: 800, w: 794, h: 200, rows: 1, cols: 1, first_row: 0 };
    const otherCell: CellHit = { section: 0, block: 5, row: 0, col: 0, rows: 1, cols: 1, text: "다른 표", x: 0, y: 800, w: 794, h: 200 };
    const m = new SelectionModel(
      new MockAdapter({
        pages: 1,
        table: (_p, _x, y) => (y < 780 ? CELL_TABLE : OTHER),
        cell: (_p, x, y) => (y < 780 ? cellAt(_p, x, y) : otherCell),
      }),
    );
    await m.drillInto(0, 100, 390); // drilled into block 1
    expect(anchors(m)[0].kind).toBe("cell");
    await click(m, 0, 100, 900); // click the OTHER table (block 5) → fresh table, drill reset
    expect(chips(m)).toBe(1);
    expect(anchors(m)[0].kind).toBe("table");
    expect(anchors(m)[0].block).toBe(5);
    expect(m.currentCell()).toBeNull();
  });

  it("(c) after drilling, a click on a PARAGRAPH resets the drill (next table click is whole-table)", async () => {
    const m = new SelectionModel(
      new MockAdapter({
        pages: 1,
        table: (_p, _x, y) => (y < 500 ? CELL_TABLE : null),
        cell: (_p, x, y) => (y < 500 ? cellAt(_p, x, y) : null),
        hit: (_p, _x, y) => (y >= 500 ? para(7, 500, 400, "결론 문단") : null),
      }),
    );
    await m.drillInto(0, 100, 100); // drilled
    await click(m, 0, 100, 700); // a paragraph → drill reset
    expect(anchors(m)[0].kind).toBe("paragraph");
    await click(m, 0, 100, 100); // back into the table → a FRESH table click (whole table)
    expect(anchors(m)[0].kind).toBe("table");
  });

  it("(d) currentCell() returns the address only when exactly ONE cell is selected", async () => {
    const m = new SelectionModel(new MockAdapter({ pages: 1, table: CELL_TABLE, cell: cellAt }));
    await click(m, 0, 100, 390); // whole table
    expect(m.currentCell()).toBeNull();
    await m.drillInto(0, 100, 390); // now a lone cell
    expect(m.currentCell()).toEqual({ section: 0, block: 1, row: 1, col: 0 });
    await click(m, 0, 600, 650, true); // ⌘-add a second cell (drilled, same table)
    expect(chips(m)).toBe(2);
    expect(m.currentCell()).toBeNull(); // two cells → not a lone cell
  });

  it("(e) clear() resets the drill so the next table click is a whole-table anchor", async () => {
    const m = new SelectionModel(new MockAdapter({ pages: 1, table: CELL_TABLE, cell: cellAt }));
    await m.drillInto(0, 100, 390); // drilled
    expect(anchors(m)[0].kind).toBe("cell");
    m.clear();
    await click(m, 0, 100, 390); // the next click is level-0 again
    expect(anchors(m)[0].kind).toBe("table");
  });

  it("⌘/Ctrl+click TOGGLES the whole table in and out (fresh, un-drilled)", async () => {
    const m = new SelectionModel(new MockAdapter({ pages: 1, table: CELL_TABLE, cell: cellAt }));
    await click(m, 0, 100, 390, true);
    expect(chips(m)).toBe(1);
    expect(anchors(m)[0].kind).toBe("table");
    await click(m, 0, 100, 390, true); // SAME table → toggled off
    expect(chips(m)).toBe(0);
  });

  it("two DIFFERENT cells of the same table accumulate under ⌘/Ctrl once drilled (distinct identity)", async () => {
    const m = new SelectionModel(new MockAdapter({ pages: 1, table: CELL_TABLE, cell: cellAt }));
    await m.drillInto(0, 100, 100); // drill into row 0 col 0
    expect(chips(m)).toBe(1);
    await click(m, 0, 100, 390, true); // ⌘-click row 1 col 0 — different cell, same drilled table
    expect(chips(m)).toBe(2);
    const all = labels(m).join(" ");
    expect(all).toContain("1행 1열");
    expect(all).toContain("2행 1열");
  });

  it("cell + block MIXED selection: a drilled cell coexists with a ⌘-added paragraph", async () => {
    const m = new SelectionModel(
      new MockAdapter({
        pages: 1,
        table: (_p, _x, y) => (y < 500 ? CELL_TABLE : null),
        cell: (_p, x, y) => (y < 500 ? cellAt(_p, x, y) : null),
        hit: (_p, _x, y) => (y >= 500 ? para(7, 500, 400, "결론 문단") : null),
      }),
    );
    await m.drillInto(0, 100, 100); // a cell
    expect(chips(m)).toBe(1);
    await click(m, 0, 100, 700, true); // ⌘-click the paragraph below the table
    expect(chips(m)).toBe(2);
    const all = labels(m).join(" ");
    expect(all).toContain("1행 1열");
    expect(all).toContain("결론 문단");
  });

  it("split-table fragment: a drilled anchor keeps the GLOBAL row (no fragment-local reset)", async () => {
    const splitCell: CellHit = { section: 0, block: 3, row: 15, col: 1, rows: 20, cols: 2, text: "분할표 하단 셀", x: 100, y: 40, w: 300, h: 44 };
    const m = new SelectionModel(new MockAdapter({ pages: 2, table: { section: 0, block: 3, x: 0, y: 0, w: 794, h: 900, rows: 20, cols: 2, first_row: 12 }, cell: () => splitCell }));
    await m.drillInto(1, 200, 200);
    expect(chips(m)).toBe(1);
    expect(labels(m)[0]).toContain("16행 2열"); // row 15 → 16행, col 1 → 2열 (global, 1-based)
    expect(anchors(m)[0].rows).toEqual([15, 15]);
  });

  it("without tableCellAt (backend omits it) a table click is the whole-table anchor; drillInto too", async () => {
    // No `cell` opt → MockAdapter omits tableCellAt (reference TauriAdapter parity → whole-table).
    const m = new SelectionModel(new MockAdapter({ pages: 1, table: CELL_TABLE }));
    await click(m, 0, 100, 100);
    expect(chips(m)).toBe(1);
    expect(m.getMarks()[0].kind).toBe("table");
    expect(anchors(m)[0].kind).toBe("table");
    const sel = await m.drillInto(0, 100, 100); // no cell query → falls back to the whole-table mark
    expect(sel).not.toBeNull();
    expect(anchors(m)[0].kind).toBe("table");
  });
});

// issue 064 Tier-2: descending CellPath drill. `rfind` (topmost) makes a click over the nested grid
// resolve the INNER table box + the nested LEAF cell (length-2 path); outside it resolves the OUTER
// table + a length-1 cell. The drill stack matches by `sameTable`, so nested levels don't collide with
// the outer table's `(section, block)`.
const NESTED_INNER: TableBox = { section: 0, block: 1, x: 0, y: 0, w: 200, h: 200, rows: 2, cols: 2, first_row: 0 };
const NESTED_OUTER: TableBox = { section: 0, block: 1, x: 0, y: 0, w: 400, h: 400, rows: 2, cols: 1, first_row: 0 };
// The nested grid occupies the top-left quadrant (x<200 && y<200) — the OUTER cell (0,0). Elsewhere is a
// plain outer cell (length-1 path).
const nestedTableAt = (_p: number, x: number, y: number): TableBox => (x < 200 && y < 200 ? NESTED_INNER : NESTED_OUTER);
const nestedCellAt = (_p: number, x: number, y: number): CellHit => {
  if (x < 200 && y < 200) {
    const r = y < 100 ? 0 : 1;
    const c = x < 100 ? 0 : 1;
    return {
      section: 0,
      block: 1,
      row: r,
      col: c,
      rows: 2,
      cols: 2,
      text: `n${r}${c}`,
      x: c * 100,
      y: r * 100,
      w: 100,
      h: 100,
      nested: false,
      path: [
        { block: 1, row: 0, col: 0 },
        { block: 1, row: r, col: c },
      ],
    };
  }
  const r = y < 200 ? 0 : 1;
  return { section: 0, block: 1, row: r, col: 0, rows: 2, cols: 1, text: `o${r}`, x: 0, y: r * 200, w: 400, h: 200, path: [{ block: 1, row: r, col: 0 }] };
};

describe("SelectionModel — nested table drill (issue 064 Tier-2)", () => {
  const model = () => new SelectionModel(new MockAdapter({ pages: 1, table: nestedTableAt, cell: nestedCellAt }));

  it("drillInto a nested cell descends → the anchor carries the length-2 CellPath", async () => {
    const m = model();
    const sel = await m.drillInto(0, 50, 50); // nested leaf (0,0)
    expect(sel).not.toBeNull();
    expect(anchors(m)[0].kind).toBe("cell");
    expect(anchors(m)[0].path).toEqual([
      { block: 1, row: 0, col: 0 },
      { block: 1, row: 0, col: 0 },
    ]);
    expect(m.currentCell()).toEqual({ section: 0, block: 1, row: 0, col: 0, path: anchors(m)[0].path });
  });

  it("after drilling a nested cell, a plain click on ANOTHER cell of the SAME nested table stays drilled", async () => {
    const m = model();
    await m.drillInto(0, 50, 50); // nested (0,0)
    await click(m, 0, 150, 50); // nested (0,1) — same nested table
    expect(chips(m)).toBe(1);
    expect(anchors(m)[0].kind).toBe("cell");
    expect(anchors(m)[0].path).toEqual([
      { block: 1, row: 0, col: 0 },
      { block: 1, row: 0, col: 1 },
    ]);
  });

  it("after drilling a nested cell, a click on an OUTER cell (length-1 path) resets to the whole table", async () => {
    const m = model();
    await m.drillInto(0, 50, 50); // nested (0,0)
    await click(m, 0, 300, 300); // an OUTER cell — different table (path length differs) → reset
    expect(chips(m)).toBe(1);
    expect(anchors(m)[0].kind).toBe("table"); // whole (innermost=outer) table, drill reset
  });

  it("two nested cells are DISTINCT selections (⌘-add both — selKey folds the path)", async () => {
    const m = model();
    await m.drillInto(0, 50, 50); // nested (0,0)
    await click(m, 0, 150, 150, true); // ⌘-add nested (1,1), same drilled nested table
    expect(chips(m)).toBe(2);
    expect(m.getAnchors().map((a) => a.path?.[1])).toEqual([
      { block: 1, row: 0, col: 0 },
      { block: 1, row: 1, col: 1 },
    ]);
  });

  it("a NON-nested cell keeps a length-1 (undefined) anchor path — back-compat with pre-Tier-2", async () => {
    const m = new SelectionModel(new MockAdapter({ pages: 1, table: CELL_TABLE, cell: cellAt }));
    await m.drillInto(0, 100, 390); // top-level cell (1,0) — cellAt returns no `path`
    expect(anchors(m)[0].kind).toBe("cell");
    expect(anchors(m)[0].path).toBeUndefined(); // no nested path → identical to the pre-Tier-2 anchor
    expect(m.currentCell()).toEqual({ section: 0, block: 1, row: 1, col: 0 });
  });
});
