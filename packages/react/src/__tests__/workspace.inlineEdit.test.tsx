import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HwpWorkspace } from "../components/HwpWorkspace";
import type { CellHit, Intent, TableBox } from "../types";
import { MockAdapter } from "./mockAdapter";

// jsdom does no layout, so getBoundingClientRect returns zeros → clicks can't map to page px. Stub it to a
// full A4 box so the coordinate math (coords.ts) resolves a real page point in tests (same as flow test).
const origRect = Element.prototype.getBoundingClientRect;
beforeAll(() => {
  Element.prototype.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: 794, bottom: 1123, width: 794, height: 1123, x: 0, y: 0, toJSON() {} }) as DOMRect;
});
afterAll(() => {
  Element.prototype.getBoundingClientRect = origRect;
});

// A table + a fixed cell hit. Under the 06x drill model a single click marks the WHOLE table and a
// DOUBLE-click drills into the exact CELL — the helper below drills so the inline panel targets the cell.
const table: TableBox = { section: 0, block: 1, x: 40, y: 60, w: 300, h: 120, rows: 3, cols: 2, first_row: 0 };
const cell: CellHit = { section: 0, block: 1, row: 1, col: 1, rows: 3, cols: 2, text: "옛 값", x: 190, y: 100, w: 150, h: 40 };
const cannedIntent: Intent = { intent: "SetTableCell", section: 0, index: 1, row: 1, col: 1, text: "여명거리" };

async function openDocAndSelectCell() {
  const adapter = new MockAdapter({ table, cell, pages: 1 });
  // The host AI bridge — a deterministic canned Intent (no LLM, no network). Mirrors the chat's onAiRequest.
  const onAiRequest = async () => [cannedIntent];
  const view = render(
    <HwpWorkspace adapter={adapter} document={{ bytes: new Uint8Array([1]), name: "t.hwpx" }} onAiRequest={onAiRequest} enableEditing isMock />,
  );
  const container = view.container;
  const sheet = await waitFor(() => {
    const el = container.querySelector('.hw-sheet[data-page="0"]');
    expect(el?.querySelector("svg")).toBeTruthy();
    return el as HTMLElement;
  });
  // 06x drill: a DOUBLE-click (two synchronous up/down pairs within the 400ms window) drills into the exact
  // CELL — single-click would mark the whole table. Mirrors selection.model.test's drill() helper.
  fireEvent.pointerDown(sheet, { clientX: 200, clientY: 100, button: 0, pointerId: 1 });
  fireEvent.pointerUp(sheet, { clientX: 200, clientY: 100, button: 0, pointerId: 1 });
  fireEvent.pointerDown(sheet, { clientX: 200, clientY: 100, button: 0, pointerId: 1 });
  fireEvent.pointerUp(sheet, { clientX: 200, clientY: 100, button: 0, pointerId: 1 });
  await waitFor(() => expect(container.querySelector(".hw-mark-cell")).toBeTruthy());
  return { adapter, container, sheet };
}

describe("HwpWorkspace inline per-element edit (apply-then-revert)", () => {
  it("select cell → ✨ affordance → inline panel → submit → applied summary → 되돌리기 undoes the batch", async () => {
    const { adapter, container } = await openDocAndSelectCell();

    // The affordance appears for the lone selection; open the inline panel.
    const affordance = await waitFor(() => {
      const el = container.querySelector('[data-testid="hw-inline-open"]');
      expect(el).toBeTruthy();
      return el as HTMLButtonElement;
    });
    fireEvent.click(affordance);

    const panel = await screen.findByTestId("hw-inline-edit");
    expect(panel).toBeTruthy();
    // Opening the panel hides the affordance (one AI surface at a time).
    expect(container.querySelector('[data-testid="hw-inline-open"]')).toBeNull();

    // Type an instruction and submit (Enter) — APPLY IS IMMEDIATE (apply-then-revert).
    const textarea = panel.querySelector(".hw-inline-textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "이 칸을 '여명거리'로 바꿔줘" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    // The mock Intent was applied as ONE batch through the adapter…
    await waitFor(() => {
      expect(adapter.applied).toHaveLength(1);
      expect(adapter.applied[0]).toEqual(cannedIntent);
    });
    // …and the panel switched to the APPLIED state with a human summary (describeIntent renderer). The panel
    // is STILL open here — proving the apply's OWN re-flow did not trip the external-edit guard (shield works).
    const applied = await screen.findByTestId("hw-inline-applied");
    expect(applied.textContent).toContain("적용됨");
    expect(applied.querySelector(".hw-inline-card")?.textContent).toContain("여명거리");

    // 되돌리기 → core.session.undo() → adapter.undo() pops exactly that batch (size 1 → one adapter.undo).
    expect(adapter.undos).toBe(0);
    fireEvent.click(screen.getByText("되돌리기"));
    await waitFor(() => {
      expect(adapter.undos).toBe(1); // the batch was reverted
      expect(container.querySelector('[data-testid="hw-inline-edit"]')).toBeNull(); // panel closed after revert
    });
  });

  it("적용 유지 keeps the change and closes the panel WITHOUT undoing", async () => {
    const { adapter, container } = await openDocAndSelectCell();
    fireEvent.click(await screen.findByTestId("hw-inline-open"));
    const textarea = (await screen.findByTestId("hw-inline-edit")).querySelector(".hw-inline-textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "채워줘" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await screen.findByTestId("hw-inline-applied");

    fireEvent.click(screen.getByText("적용 유지"));
    await waitFor(() => expect(container.querySelector('[data-testid="hw-inline-edit"]')).toBeNull());
    expect(adapter.applied).toHaveLength(1); // still applied
    expect(adapter.undos).toBe(0); // keep never undoes
  });

  it("a click on the page sheet closes the panel KEEPING the change (revert guard)", async () => {
    const { container, sheet } = await openDocAndSelectCell();
    fireEvent.click(await screen.findByTestId("hw-inline-open"));
    expect(await screen.findByTestId("hw-inline-edit")).toBeTruthy();

    // A press on the page sheet is an external gesture → the panel closes (keeping any applied change). Here
    // we are still in compose state (nothing applied), so it simply closes without offering a stale revert.
    fireEvent.pointerDown(sheet, { clientX: 500, clientY: 500, button: 0, pointerId: 2 });
    fireEvent.pointerUp(sheet, { clientX: 500, clientY: 500, button: 0, pointerId: 2 });
    await waitFor(() => expect(container.querySelector('[data-testid="hw-inline-edit"]')).toBeNull());
  });

  it("the affordance is hidden when nothing is selected", async () => {
    const adapter = new MockAdapter({ table, cell, pages: 1 });
    const { container } = render(
      <HwpWorkspace adapter={adapter} document={{ bytes: new Uint8Array([1]), name: "t.hwpx" }} onAiRequest={async () => []} enableEditing />,
    );
    await waitFor(() => expect(container.querySelector(".hw-sheet svg")).toBeTruthy());
    // No selection yet → no affordance.
    expect(container.querySelector('[data-testid="hw-inline-open"]')).toBeNull();
  });
});
