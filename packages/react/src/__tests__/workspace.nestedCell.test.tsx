import { fireEvent, render, waitFor } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HwpWorkspace } from "../components/HwpWorkspace";
import type { CellHit, TableBox } from "../types";
import { MockAdapter } from "./mockAdapter";

// jsdom does no layout → stub getBoundingClientRect to a full A4 box so clicks map to page px
// (same approach as workspace.inlineEdit.test).
const origRect = Element.prototype.getBoundingClientRect;
beforeAll(() => {
  Element.prototype.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: 794, bottom: 1123, width: 794, height: 1123, x: 0, y: 0, toJSON() {} }) as DOMRect;
});
afterAll(() => {
  Element.prototype.getBoundingClientRect = origRect;
});

const table: TableBox = { section: 0, block: 1, x: 40, y: 60, w: 300, h: 120, rows: 3, cols: 2, first_row: 0 };
// A cell whose model blocks hold a NESTED table — the engine flags it `nested: true` (issue 064 Tier-1).
const nestedCell: CellHit = { section: 0, block: 1, row: 1, col: 1, rows: 3, cols: 2, text: "중첩", x: 190, y: 100, w: 150, h: 40, nested: true };

describe("HwpWorkspace nested-table cell (issue 064 Tier-1)", () => {
  it("double-clicking a nested-table cell shows an honest toast and does NOT drill/open the editor", async () => {
    const adapter = new MockAdapter({ table, cell: nestedCell, pages: 1 });
    const { container } = render(
      <HwpWorkspace adapter={adapter} document={{ bytes: new Uint8Array([1]), name: "t.hwpx" }} onAiRequest={async () => []} enableEditing isMock />,
    );
    const sheet = await waitFor(() => {
      const el = container.querySelector('.hw-sheet[data-page="0"]');
      expect(el?.querySelector("svg")).toBeTruthy();
      return el as HTMLElement;
    });

    // A DOUBLE-click over the nested cell (two synchronous up/down pairs within the 400ms window).
    for (let i = 0; i < 2; i++) {
      fireEvent.pointerDown(sheet, { clientX: 200, clientY: 100, button: 0, pointerId: 1 });
      fireEvent.pointerUp(sheet, { clientX: 200, clientY: 100, button: 0, pointerId: 1 });
    }

    // The honest toast appears…
    await waitFor(() => {
      expect(container.querySelector(".hw-status")?.textContent).toContain("중첩표는 아직 편집할 수 없습니다");
    });
    // …and the CELL was NOT drilled (no cell mark) and NO editor opened (no inline edit panel). The
    // whole-table selection affordance from the single click is legitimate 06x behavior — the block here
    // is that the nested CELL is not drilled/edited, so we assert the cell-level surfaces stay closed.
    expect(container.querySelector(".hw-mark-cell")).toBeNull();
    expect(container.querySelector('[data-testid="hw-inline-edit"]')).toBeNull();
    // No SetTableCell (or any op) was applied — the destruction path never fired.
    expect(adapter.applied).toHaveLength(0);
  });
});
