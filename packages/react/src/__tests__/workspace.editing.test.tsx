import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HwpWorkspace } from "../components/HwpWorkspace";
import type { CellHit, Intent, TableBox } from "../types";
import { MockAdapter } from "./mockAdapter";

// jsdom does no layout — stub getBoundingClientRect to a full A4 box so coords.ts maps clicks to page px.
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
const table: TableBox = { section: 0, block: 1, x: 40, y: 60, w: 300, h: 120, rows: 3, cols: 3, first_row: 0 };

async function sheetOf(container: HTMLElement): Promise<HTMLElement> {
  return waitFor(() => {
    const el = container.querySelector('.hw-sheet[data-page="0"]');
    expect(el?.querySelector("svg")).toBeTruthy();
    return el as HTMLElement;
  });
}

describe("HwpWorkspace issue-027 editing chrome — opt-in", () => {
  it("is OFF by default: no 표 추가 button, no ruler", async () => {
    const adapter = new MockAdapter({ table, pageGeom: { w: 794, h: 1123, ml: 90, mt: 90, mr: 90, mb: 90 }, pages: 1 });
    const { container } = render(<HwpWorkspace adapter={adapter} document={doc} onAiRequest={noAi} />);
    await sheetOf(container);
    expect(screen.queryByTestId("hw-table-insert")).toBeNull();
    expect(screen.queryByTestId("hw-ruler")).toBeNull();
  });

  it("enableEditing shows the ruler (mm) + 표 추가 button; picking a size appends a table via ApplyContent", async () => {
    const adapter = new MockAdapter({ table, pageGeom: { w: 794, h: 1123, ml: 90, mt: 90, mr: 90, mb: 90 }, pages: 1 });
    const { container } = render(<HwpWorkspace adapter={adapter} document={doc} onAiRequest={noAi} enableEditing />);
    await sheetOf(container);
    await waitFor(() => expect(screen.getByTestId("hw-ruler")).toBeTruthy());

    fireEvent.click(screen.getByTestId("hw-table-insert"));
    fireEvent.mouseEnter(screen.getByTestId("hw-table-cell-2-2"));
    fireEvent.click(screen.getByTestId("hw-table-cell-2-2"));
    await waitFor(() => expect(adapter.applied).toHaveLength(1));
    const intent = adapter.applied[0] as Intent & { json: string };
    expect(intent.intent).toBe("ApplyContent");
    expect(JSON.parse(intent.json).blocks[0].rows).toHaveLength(2);
  });

  it("marking a table shows column-resize grips; a drag commits SetTableColWidths (1 undo)", async () => {
    const adapter = new MockAdapter({ table, colBoundaries: [40, 140, 240, 340], pageGeom: { w: 794, h: 1123, ml: 90, mt: 90, mr: 90, mb: 90 }, pages: 1 });
    const { container } = render(<HwpWorkspace adapter={adapter} document={doc} onAiRequest={noAi} enableEditing />);
    const sheet = await sheetOf(container);
    // click the table → whole-table mark.
    fireEvent.pointerDown(sheet, { clientX: 100, clientY: 100, button: 0, pointerId: 1 });
    fireEvent.pointerUp(sheet, { clientX: 100, clientY: 100, button: 0, pointerId: 1 });
    const grip = await screen.findByTestId("hw-col-grip-1");
    const resize = screen.getByTestId("hw-col-resize");
    fireEvent.pointerDown(grip, { clientX: 140, clientY: 100, pointerId: 2 });
    fireEvent.pointerMove(resize, { clientX: 180, clientY: 100, pointerId: 2 });
    fireEvent.pointerUp(resize, { clientX: 180, clientY: 100, pointerId: 2 });
    await waitFor(() => {
      const applied = adapter.applied.find((i) => i.intent === "SetTableColWidths") as (Intent & { widths: number[] }) | undefined;
      expect(applied).toBeTruthy();
      expect(applied!.widths.length).toBe(3);
    });
  });

  it("double-click a cell → text popover → save PRESERVES bold via SetTableCellRuns", async () => {
    const cell: CellHit = { section: 0, block: 1, row: 0, col: 0, rows: 3, cols: 3, text: "굵게", x: 40, y: 60, w: 100, h: 40 };
    const adapter = new MockAdapter({ table, cell, runs: [{ text: "굵게", bold: true }], pages: 1 });
    const { container } = render(<HwpWorkspace adapter={adapter} document={doc} onAiRequest={noAi} enableEditing />);
    const sheet = await sheetOf(container);
    // Two quick pointer up/down pairs = a double-click (detected by the pointerup timing, since
    // setPointerCapture suppresses the DOM dblclick).
    fireEvent.pointerDown(sheet, { clientX: 60, clientY: 80, button: 0, pointerId: 1 });
    fireEvent.pointerUp(sheet, { clientX: 60, clientY: 80, button: 0, pointerId: 1 });
    fireEvent.pointerDown(sheet, { clientX: 60, clientY: 80, button: 0, pointerId: 1 });
    fireEvent.pointerUp(sheet, { clientX: 60, clientY: 80, button: 0, pointerId: 1 });
    const ta = await screen.findByTestId("hw-cell-textarea");
    fireEvent.change(ta, { target: { value: "바뀐 값" } });
    fireEvent.click(screen.getByTestId("hw-cell-save"));
    await waitFor(() => {
      const applied = adapter.applied.find((i) => i.intent === "SetTableCellRuns") as (Intent & { runs: unknown[] }) | undefined;
      expect(applied).toBeTruthy();
      expect(applied!.runs).toEqual([{ text: "바뀐 값", bold: true }]); // bold inherited
    });
  });

  it("marking a cell shows the format toolbar; 굵게 applies SetCellRangeFmt", async () => {
    const cell: CellHit = { section: 0, block: 1, row: 1, col: 1, rows: 3, cols: 3, text: "칸", x: 140, y: 100, w: 100, h: 40 };
    const adapter = new MockAdapter({ table, cell, runs: [{ text: "칸" }], colBoundaries: [40, 140, 240, 340], pages: 1 });
    const { container } = render(<HwpWorkspace adapter={adapter} document={doc} onAiRequest={noAi} enableEditing />);
    const sheet = await sheetOf(container);
    fireEvent.pointerDown(sheet, { clientX: 160, clientY: 110, button: 0, pointerId: 1 });
    fireEvent.pointerUp(sheet, { clientX: 160, clientY: 110, button: 0, pointerId: 1 });
    const bold = await screen.findByTestId("hw-fmt-bold");
    fireEvent.click(bold);
    await waitFor(() => {
      const applied = adapter.applied.find((i) => i.intent === "SetCellRangeFmt") as (Intent & { bold: unknown; r0: number }) | undefined;
      expect(applied).toBeTruthy();
      expect(applied!.bold).toBe(true);
      expect(applied!.r0).toBe(1); // the clicked cell's row
    });
  });
});
