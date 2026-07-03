import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HwpWorkspace } from "../components/HwpWorkspace";
import type { BlockHit, CellHit, Intent, TableBox } from "../types";
import { MockAdapter } from "./mockAdapter";

// Issue 036 — keyboard cell navigation wiring (react side). editor-core owns moveCell (unit-tested in
// @tf-hwp/editor-core); here we prove the KEYDOWN BINDING: 방향키 → moveCell (셀 선택일 때만),
// Enter → 제자리 편집, 편집 중 Tab → 저장+오른쪽 셀 이동+재진입, 그리고 포커스/비셀 가드.

// jsdom does no layout — a full-A4 getBoundingClientRect maps client px 1:1 to page px (scale via zoom
// handled by the components); a click at (x,y) resolves to page px (x,y).
const origRect = Element.prototype.getBoundingClientRect;
beforeAll(() => {
  Element.prototype.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: 794, bottom: 1123, width: 794, height: 1123, x: 0, y: 0, toJSON() {} }) as DOMRect;
});
afterAll(() => {
  Element.prototype.getBoundingClientRect = origRect;
});

const noAi = async () => [] as Intent[];
const doc = { bytes: new Uint8Array([1]), name: "t.hwpx" };

// A 3×3 grid, each cell 100×40 px at the page origin. Coordinate-aware `cell` maps a point → its cell so a
// probe a few px past a box edge lands in the neighbour (issue 036's re-probe strategy).
const GRID: TableBox = { section: 0, block: 1, x: 0, y: 0, w: 300, h: 120, rows: 3, cols: 3, first_row: 0 };
const gridCell = (_p: number, x: number, y: number): CellHit | null => {
  if (x < 0 || y < 0 || x >= 300 || y >= 120) return null;
  const col = Math.min(2, Math.floor(x / 100));
  const row = Math.min(2, Math.floor(y / 40));
  return { section: 0, block: 1, row, col, rows: 3, cols: 3, text: `r${row}c${col}`, x: col * 100, y: row * 40, w: 100, h: 40 };
};
const para: BlockHit = { section: 0, block: 5, kind: "paragraph", x: 0, y: 400, w: 300, h: 60, text: "문단 하나", editable: true };

async function sheetOf(container: HTMLElement): Promise<HTMLElement> {
  return waitFor(() => {
    const el = container.querySelector('.hw-sheet[data-page="0"]');
    expect(el?.querySelector("svg")).toBeTruthy();
    return el as HTMLElement;
  });
}
const clickAt = (sheet: HTMLElement, x: number, y: number) => {
  fireEvent.pointerDown(sheet, { clientX: x, clientY: y, button: 0, pointerId: 1 });
  fireEvent.pointerUp(sheet, { clientX: x, clientY: y, button: 0, pointerId: 1 });
};
const anchorText = (container: HTMLElement) => container.querySelector(".hw-anchor")?.textContent ?? "";

describe("issue 036 — arrow-key cell navigation binding", () => {
  it("selecting a cell then ArrowRight ×2 moves the selection right (label column grows)", async () => {
    const adapter = new MockAdapter({ table: GRID, cell: gridCell, runs: [{ text: "x" }], pages: 1 });
    const { container } = render(<HwpWorkspace adapter={adapter} document={doc} onAiRequest={noAi} enableEditing />);
    const sheet = await sheetOf(container);
    clickAt(sheet, 50, 20); // cell (0,0)
    await waitFor(() => expect(anchorText(container)).toContain("1행 1열"));

    fireEvent.keyDown(window, { key: "ArrowRight" });
    await waitFor(() => expect(anchorText(container)).toContain("1행 2열"));
    fireEvent.keyDown(window, { key: "ArrowRight" });
    await waitFor(() => expect(anchorText(container)).toContain("1행 3열"));
    // Only ONE chip — a move REPLACES, never accumulates.
    expect(container.querySelectorAll(".hw-anchor")).toHaveLength(1);
  });

  it("ArrowDown then ArrowLeft navigates rows/cols; clamps at the boundary (no wrap)", async () => {
    const adapter = new MockAdapter({ table: GRID, cell: gridCell, runs: [{ text: "x" }], pages: 1 });
    const { container } = render(<HwpWorkspace adapter={adapter} document={doc} onAiRequest={noAi} enableEditing />);
    const sheet = await sheetOf(container);
    clickAt(sheet, 50, 20); // (0,0)
    await waitFor(() => expect(anchorText(container)).toContain("1행 1열"));
    // Clamp at top/left — no movement off the table.
    fireEvent.keyDown(window, { key: "ArrowUp" });
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    await waitFor(() => expect(anchorText(container)).toContain("1행 1열"));
    fireEvent.keyDown(window, { key: "ArrowDown" });
    await waitFor(() => expect(anchorText(container)).toContain("2행 1열"));
  });

  it("GUARD: a non-cell selection (paragraph) does NOT navigate", async () => {
    const adapter = new MockAdapter({ table: (_p, _x, y) => (y < 120 ? GRID : null), cell: (_p, x, y) => (y < 120 ? gridCell(_p, x, y) : null), hit: (_p, _x, y) => (y >= 120 ? para : null), pages: 1 });
    const { container } = render(<HwpWorkspace adapter={adapter} document={doc} onAiRequest={noAi} enableEditing />);
    const sheet = await sheetOf(container);
    clickAt(sheet, 50, 430); // the paragraph, not a cell
    await waitFor(() => expect(anchorText(container)).toContain("문단"));
    fireEvent.keyDown(window, { key: "ArrowRight" });
    // still the paragraph — arrows are ignored for a non-cell selection.
    await new Promise((r) => setTimeout(r, 10));
    expect(anchorText(container)).toContain("문단");
  });

  it("GUARD: keys typed into a text-entry surface (chat composer) never move the cell", async () => {
    const adapter = new MockAdapter({ table: GRID, cell: gridCell, runs: [{ text: "x" }], pages: 1 });
    const { container } = render(<HwpWorkspace adapter={adapter} document={doc} onAiRequest={noAi} enableEditing />);
    const sheet = await sheetOf(container);
    clickAt(sheet, 50, 20); // cell (0,0)
    await waitFor(() => expect(anchorText(container)).toContain("1행 1열"));
    const composer = container.querySelector(".hw-textarea") as HTMLTextAreaElement;
    composer.focus();
    fireEvent.keyDown(composer, { key: "ArrowRight" }); // bubbles to window; target is the textarea
    await new Promise((r) => setTimeout(r, 10));
    expect(anchorText(container)).toContain("1행 1열"); // unchanged — the composer keeps its arrows
  });
});

describe("issue 036 — Enter opens the editor, Tab commits + moves + re-enters", () => {
  it("Enter over a selected cell opens the in-place editor at that cell", async () => {
    const adapter = new MockAdapter({ table: GRID, cell: gridCell, runs: [{ text: "x" }], pages: 1 });
    const { container } = render(<HwpWorkspace adapter={adapter} document={doc} onAiRequest={noAi} enableEditing />);
    const sheet = await sheetOf(container);
    clickAt(sheet, 50, 20); // cell (0,0)
    await waitFor(() => expect(anchorText(container)).toContain("1행 1열"));
    fireEvent.keyDown(window, { key: "Enter" });
    const ta = (await screen.findByTestId("hw-inplace-editor")) as HTMLTextAreaElement;
    // Editor sits over cell (0,0): left/top = box × zoom(0.9) = 0.
    expect(ta.style.left).toBe("0px");
    expect(ta.style.top).toBe("0px");
    expect(ta.style.width).toBe("90px"); // 100 × 0.9
  });

  it("Tab commits (SetTableCellRuns) then moves to the right cell and re-enters edit", async () => {
    const adapter = new MockAdapter({ table: GRID, cell: gridCell, runs: [{ text: "x" }], pages: 1 });
    const { container } = render(<HwpWorkspace adapter={adapter} document={doc} onAiRequest={noAi} enableEditing />);
    const sheet = await sheetOf(container);
    clickAt(sheet, 50, 20); // cell (0,0)
    await waitFor(() => expect(anchorText(container)).toContain("1행 1열"));
    fireEvent.keyDown(window, { key: "Enter" });
    const ta = (await screen.findByTestId("hw-inplace-editor")) as HTMLTextAreaElement;
    expect(ta.style.left).toBe("0px"); // over cell (0,0)
    fireEvent.change(ta, { target: { value: "새값" } });
    fireEvent.keyDown(ta, { key: "Tab" }); // 저장 + 오른쪽 셀 이동 + 재진입

    // committed via the run-preserving path.
    await waitFor(() => {
      const applied = adapter.applied.find((i) => i.intent === "SetTableCellRuns") as (Intent & { runs: unknown[]; col: number }) | undefined;
      expect(applied).toBeTruthy();
      expect(applied!.col).toBe(0); // committed the ORIGIN cell
    });
    // the selection moved right and the editor RE-ENTERED at cell (0,1) (left = 100 × 0.9 = 90px).
    await waitFor(() => {
      const ed = screen.getByTestId("hw-inplace-editor") as HTMLTextAreaElement;
      expect(ed.style.left).toBe("90px");
    });
    await waitFor(() => expect(anchorText(container)).toContain("1행 2열"));
  });

  it("Shift+Tab moves LEFT after commit", async () => {
    const adapter = new MockAdapter({ table: GRID, cell: gridCell, runs: [{ text: "x" }], pages: 1 });
    const { container } = render(<HwpWorkspace adapter={adapter} document={doc} onAiRequest={noAi} enableEditing />);
    const sheet = await sheetOf(container);
    clickAt(sheet, 150, 20); // cell (0,1)
    await waitFor(() => expect(anchorText(container)).toContain("1행 2열"));
    fireEvent.keyDown(window, { key: "Enter" });
    const ta = (await screen.findByTestId("hw-inplace-editor")) as HTMLTextAreaElement;
    expect(ta.style.left).toBe("90px"); // over cell (0,1)
    fireEvent.change(ta, { target: { value: "왼쪽" } });
    fireEvent.keyDown(ta, { key: "Tab", shiftKey: true });
    await waitFor(() => {
      const ed = screen.getByTestId("hw-inplace-editor") as HTMLTextAreaElement;
      expect(ed.style.left).toBe("0px"); // moved to cell (0,0)
    });
    await waitFor(() => expect(anchorText(container)).toContain("1행 1열"));
  });
});
