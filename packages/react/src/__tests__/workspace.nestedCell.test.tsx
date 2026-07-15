import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HwpWorkspace } from "../components/HwpWorkspace";
import type { CellHit, Intent, RunSpec, TableBox } from "../types";
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

const doc = { bytes: new Uint8Array([1]), name: "t.hwpx" };
const table: TableBox = { section: 0, block: 1, x: 40, y: 60, w: 300, h: 120, rows: 3, cols: 2, first_row: 0 };
// A NESTED leaf cell (issue 064 Tier-2): the engine returns a length-2 descending `path` (outer cell
// (0,0) → inner cell (1,1)). `nested:false` — the LEAF itself holds no further grid. With Tier-2 this is
// an EDITABLE target: no more "중첩표는 편집할 수 없습니다" toast.
const nestedLeaf: CellHit = {
  section: 0,
  block: 1,
  row: 1,
  col: 1,
  rows: 3,
  cols: 2,
  text: "중첩",
  x: 40,
  y: 60,
  w: 100,
  h: 40,
  nested: false,
  path: [
    { block: 1, row: 0, col: 0 },
    { block: 1, row: 1, col: 1 },
  ],
};
const runs: RunSpec[] = [{ text: "중첩" }];

const dblClick = (sheet: HTMLElement) => {
  for (let i = 0; i < 2; i++) {
    fireEvent.pointerDown(sheet, { clientX: 60, clientY: 80, button: 0, pointerId: 1 });
    fireEvent.pointerUp(sheet, { clientX: 60, clientY: 80, button: 0, pointerId: 1 });
  }
};

describe("HwpWorkspace nested-table cell (issue 064 Tier-2 — editable via CellPath)", () => {
  it("a nested cell drills + opens the in-place editor (no refusal toast); the commit carries the path", async () => {
    const adapter = new MockAdapter({ table, cell: nestedLeaf, runs, pages: 1 });
    const { container } = render(<HwpWorkspace adapter={adapter} document={doc} onAiRequest={async () => []} enableEditing />);
    const sheet = await waitFor(() => {
      const el = container.querySelector('.hw-sheet[data-page="0"]');
      expect(el?.querySelector("svg")).toBeTruthy();
      return el as HTMLElement;
    });

    // First double-click → DRILL into the nested leaf (a cell mark appears). The Tier-1 refusal toast must
    // NOT appear — a nested cell is now a real edit target.
    dblClick(sheet);
    await waitFor(() => expect(container.querySelector(".hw-mark-cell")).toBeTruthy());
    expect(container.querySelector(".hw-status")?.textContent ?? "").not.toContain("중첩표는 아직 편집할 수 없습니다");

    // Second double-click on the SAME (already-drilled) nested cell → OPEN the in-place editor. Tier-2:
    // nested cells ARE editable — `currentCell().path` matches the clicked cell's descending path.
    dblClick(sheet);
    const ed = (await screen.findByTestId("hw-inplace-editor")) as HTMLElement;

    // Edit the text and commit (Enter) → the SetTableCellRuns Intent carries the descending `path`, so the
    // op walks to the NESTED leaf (never the flat outer quad).
    ed.innerHTML = `<div>수정</div>`;
    fireEvent.keyDown(ed, { key: "Enter" });
    await waitFor(() => {
      const cellOps = adapter.applied.filter((i) => i.intent === "SetTableCellRuns") as (Intent & { path?: unknown; runs: RunSpec[] })[];
      expect(cellOps.length).toBeGreaterThan(0);
      const last = cellOps[cellOps.length - 1];
      expect(last.path).toEqual(nestedLeaf.path);
      expect(last.runs).toEqual([{ text: "수정" }]);
    });
  });
});
