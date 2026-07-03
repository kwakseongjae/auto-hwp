import { fireEvent, render, waitFor } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HwpWorkspace } from "../components/HwpWorkspace";
import type { BlockHit, CellHit, TableBox } from "../types";
import { MockAdapter } from "./mockAdapter";

// jsdom does no layout → getBoundingClientRect returns zeros. Stub a full A4 box so screenToPage maps
// a client point to a real own-render page point (same trick as workspace.flow.test).
const origRect = Element.prototype.getBoundingClientRect;
beforeAll(() => {
  Element.prototype.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: 794, bottom: 1123, width: 794, height: 1123, x: 0, y: 0, toJSON() {} }) as DOMRect;
});
afterAll(() => {
  Element.prototype.getBoundingClientRect = origRect;
});

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

function openDoc(adapter: MockAdapter) {
  const r = render(<HwpWorkspace adapter={adapter} document={{ bytes: new Uint8Array([1]), name: "t.hwpx" }} onAiRequest={async () => []} />);
  return r;
}

// Wait until the first page sheet (with its SVG) has rendered, then return it. The `expect` inside makes
// waitFor RETRY (a bare querySelector would resolve with null before the async open finishes).
async function sheetOf(container: HTMLElement): Promise<HTMLElement> {
  return waitFor(() => {
    const el = container.querySelector('.hw-sheet[data-page="0"]') as HTMLElement | null;
    expect(el?.querySelector("svg")).toBeTruthy();
    return el as HTMLElement;
  });
}

const chips = (c: HTMLElement) => c.querySelectorAll(".hw-anchor").length;
const chipText = (c: HTMLElement) => Array.from(c.querySelectorAll(".hw-anchor")).map((e) => (e.textContent ?? "").trim());

const down = (el: Element, x: number, y: number, meta = false) =>
  fireEvent.pointerDown(el, { clientX: x, clientY: y, button: 0, buttons: 1, pointerId: 1, metaKey: meta, ctrlKey: false });
const move = (el: Element, x: number, y: number, meta = false) =>
  fireEvent.pointerMove(el, { clientX: x, clientY: y, buttons: 1, pointerId: 1, metaKey: meta, ctrlKey: false });
const up = (el: Element, x: number, y: number, meta = false) =>
  fireEvent.pointerUp(el, { clientX: x, clientY: y, button: 0, buttons: 0, pointerId: 1, metaKey: meta, ctrlKey: false });

const flush = () => new Promise((r) => setTimeout(r, 0)); // let onPointerDown's async "empty" resolve

describe("selection model (issue 021)", () => {
  it("click REPLACES the selection (never accumulates)", async () => {
    // Coordinate-aware hit: top band → block 1, bottom band → block 2.
    const adapter = new MockAdapter({
      pages: 1,
      hit: (_p, _x, y) => (y < 400 ? para(1, 0, 400, "블록 하나") : para(2, 400, 723, "블록 둘")),
    });
    const { container } = openDoc(adapter);
    const sheet = await sheetOf(container);

    down(sheet, 100, 100);
    up(sheet, 100, 100);
    await waitFor(() => expect(chips(container)).toBe(1));
    expect(chipText(container)[0]).toContain("블록 하나");

    // A second click on a DIFFERENT block replaces (still exactly one chip).
    down(sheet, 100, 800);
    up(sheet, 100, 800);
    await waitFor(() => expect(chipText(container)[0]).toContain("블록 둘"));
    expect(chips(container)).toBe(1);
  });

  it("⌘/Ctrl+click TOGGLES a block in and out of the selection", async () => {
    const adapter = new MockAdapter({ pages: 1, hit: para(3, 0, 1123, "토글 대상") });
    const { container } = openDoc(adapter);
    const sheet = await sheetOf(container);

    down(sheet, 100, 100, true);
    up(sheet, 100, 100, true);
    await waitFor(() => expect(chips(container)).toBe(1)); // absent → added

    down(sheet, 100, 100, true);
    up(sheet, 100, 100, true);
    await waitFor(() => expect(chips(container)).toBe(0)); // present → removed
  });

  it("empty-area drag = marquee; ⌘/Ctrl UNION adds the crossed blocks to the selection", async () => {
    // Hit only in the top band (y<300) → block 1; below that is EMPTY (marquee eligible). The marquee
    // query returns two OTHER blocks.
    const adapter = new MockAdapter({
      pages: 1,
      hit: (_p, _x, y) => (y < 300 ? para(1, 0, 300, "머리 블록") : null),
      blocks: [para(5, 400, 200, "표 아래 하나"), para(6, 620, 200, "표 아래 둘")],
    });
    const { container } = openDoc(adapter);
    const sheet = await sheetOf(container);

    // First a plain click selects the head block.
    down(sheet, 100, 100);
    up(sheet, 100, 100);
    await waitFor(() => expect(chips(container)).toBe(1));

    // Then a ⌘/Ctrl marquee over the empty lower area unions two more blocks in.
    down(sheet, 80, 600, true);
    await flush(); // resolve "empty" before the move decides marquee-start
    move(sheet, 300, 900, true);
    await waitFor(() => expect(container.querySelector(".hw-marquee")).toBeTruthy());
    up(sheet, 300, 900, true);
    await waitFor(() => expect(chips(container)).toBe(3));
    expect(container.querySelector(".hw-marquee")).toBeNull(); // rect cleared on release
    const labels = chipText(container).join(" ");
    expect(labels).toContain("머리 블록");
    expect(labels).toContain("표 아래 하나");
    expect(labels).toContain("표 아래 둘");
  });

  it("Esc clears the whole selection", async () => {
    const adapter = new MockAdapter({ pages: 1, hit: para(2, 0, 1123, "선택") });
    const { container } = openDoc(adapter);
    const sheet = await sheetOf(container);

    down(sheet, 100, 100);
    up(sheet, 100, 100);
    await waitFor(() => expect(chips(container)).toBe(1));

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(chips(container)).toBe(0));
  });
});

// Cell-level marking (issue 023): a click inside a table anchors the exact CELL (chip = text snippet +
// "N행 M열", 1-based; global row/col preserved), ⌘/Ctrl toggles the exact clicked cell, and cells mix
// with block anchors. The 3×2 table fills the top of the page; a coordinate-aware `cell` resolver maps a
// point to (row, col) so distinct cells are addressable.
const CELL_TABLE: TableBox = { section: 0, block: 1, x: 0, y: 0, w: 794, h: 780, rows: 3, cols: 2, first_row: 0 };
// row bands: y<260 → 0, <520 → 1, else 2 (within the 0..780 table). col: x<397 → 0, else 1.
const cellAt = (_p: number, x: number, y: number): CellHit => {
  const row = y < 260 ? 0 : y < 520 ? 1 : 2;
  const col = x < 397 ? 0 : 1;
  const text = row === 1 && col === 0 ? "1-2. 제품·서비스의 개요 설명" : row === 0 ? "항목" : "";
  return { section: 0, block: 1, row, col, rows: 3, cols: 2, text, x: col * 397, y: row * 260, w: 397, h: 260 };
};

describe("cell-level marking (issue 023)", () => {
  it("click inside a table anchors the exact CELL (snippet + 1-based N행 M열, global coords)", async () => {
    const adapter = new MockAdapter({ pages: 1, table: CELL_TABLE, cell: cellAt });
    const { container } = openDoc(adapter);
    const sheet = await sheetOf(container);

    // Click into row 1, col 0 (page y≈390, x≈100).
    down(sheet, 100, 390);
    up(sheet, 100, 390);
    await waitFor(() => expect(chips(container)).toBe(1));
    const label = chipText(container)[0];
    expect(label).toContain("2행 1열"); // row 1 → 2행, col 0 → 1열 (1-based, global)
    expect(label).toContain("제품"); // the cell text snippet rides along
    // The green cell mark (not the purple whole-table mark) is drawn.
    await waitFor(() => expect(container.querySelector(".hw-mark-cell")).toBeTruthy());
    expect(container.querySelector(".hw-mark-table")).toBeNull();
  });

  it("a plain click on ANOTHER cell replaces (still one chip, new address)", async () => {
    const adapter = new MockAdapter({ pages: 1, table: CELL_TABLE, cell: cellAt });
    const { container } = openDoc(adapter);
    const sheet = await sheetOf(container);

    down(sheet, 100, 100); // row 0 col 0
    up(sheet, 100, 100);
    await waitFor(() => expect(chipText(container)[0]).toContain("1행 1열"));

    down(sheet, 600, 650); // row 2 col 1
    up(sheet, 600, 650);
    await waitFor(() => expect(chipText(container)[0]).toContain("3행 2열"));
    expect(chips(container)).toBe(1); // replace, never accumulate
  });

  it("⌘/Ctrl+click TOGGLES the exact clicked cell in and out", async () => {
    const adapter = new MockAdapter({ pages: 1, table: CELL_TABLE, cell: cellAt });
    const { container } = openDoc(adapter);
    const sheet = await sheetOf(container);

    down(sheet, 100, 390, true); // row 1 col 0
    up(sheet, 100, 390, true);
    await waitFor(() => expect(chips(container)).toBe(1)); // absent → added

    down(sheet, 100, 390, true); // SAME cell
    up(sheet, 100, 390, true);
    await waitFor(() => expect(chips(container)).toBe(0)); // present → removed
  });

  it("two DIFFERENT cells of the same table accumulate under ⌘/Ctrl (distinct identity)", async () => {
    const adapter = new MockAdapter({ pages: 1, table: CELL_TABLE, cell: cellAt });
    const { container } = openDoc(adapter);
    const sheet = await sheetOf(container);

    down(sheet, 100, 100); // row 0 col 0
    up(sheet, 100, 100);
    await waitFor(() => expect(chips(container)).toBe(1));

    down(sheet, 100, 390, true); // row 1 col 0 — different cell, same table
    up(sheet, 100, 390, true);
    await waitFor(() => expect(chips(container)).toBe(2)); // both kept (rows/cols make identity)
    const labels = chipText(container).join(" ");
    expect(labels).toContain("1행 1열");
    expect(labels).toContain("2행 1열");
  });

  it("cell + block MIXED selection: a cell anchor coexists with a ⌘-added paragraph", async () => {
    // Top half (y<500) is the table; below that is a paragraph (no table, no cell there).
    const adapter = new MockAdapter({
      pages: 1,
      table: (_p, _x, y) => (y < 500 ? CELL_TABLE : null),
      cell: (_p, x, y) => (y < 500 ? cellAt(_p, x, y) : null),
      hit: (_p, _x, y) => (y >= 500 ? para(7, 500, 400, "결론 문단") : null),
    });
    const { container } = openDoc(adapter);
    const sheet = await sheetOf(container);

    down(sheet, 100, 100); // a cell
    up(sheet, 100, 100);
    await waitFor(() => expect(chips(container)).toBe(1));

    down(sheet, 100, 700, true); // ⌘-click the paragraph below the table
    up(sheet, 100, 700, true);
    await waitFor(() => expect(chips(container)).toBe(2));
    const labels = chipText(container).join(" ");
    expect(labels).toContain("1행 1열"); // the cell
    expect(labels).toContain("결론 문단"); // the paragraph block
  });

  it("split-table fragment: the chip shows the GLOBAL row (no fragment-local reset)", async () => {
    // A cell whose MODEL-GLOBAL address is row 15 / col 1 of a 20-row table — the UI must render "16행"
    // (1-based global), never a fragment-local index. Verified on a second page to mimic a split.
    const splitCell: CellHit = { section: 0, block: 3, row: 15, col: 1, rows: 20, cols: 2, text: "분할표 하단 셀", x: 100, y: 40, w: 300, h: 44 };
    const adapter = new MockAdapter({
      pages: 2,
      table: { section: 0, block: 3, x: 0, y: 0, w: 794, h: 900, rows: 20, cols: 2, first_row: 12 },
      cell: () => splitCell,
    });
    const { container } = openDoc(adapter);
    await sheetOf(container); // page 0 ready
    const sheet1 = await waitFor(() => {
      const el = container.querySelector('.hw-sheet[data-page="1"]') as HTMLElement | null;
      expect(el?.querySelector("svg")).toBeTruthy();
      return el as HTMLElement;
    });

    down(sheet1, 200, 200);
    up(sheet1, 200, 200);
    await waitFor(() => expect(chips(container)).toBe(1));
    expect(chipText(container)[0]).toContain("16행 2열"); // row 15 → 16행, col 1 → 2열 (global, 1-based)
  });
});
