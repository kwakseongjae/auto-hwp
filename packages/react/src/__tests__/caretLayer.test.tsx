import { fireEvent, render, waitFor } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HwpWorkspace, __getWorkspaceRenderCount, __resetWorkspaceRenderCount } from "../components/HwpWorkspace";
import { __getSheetRenderCount, __resetSheetRenderCount } from "../components/HwpPageView";
import type { CellTextHit, Intent, RunSpec } from "../types";
import { MockAdapter } from "./mockAdapter";

// issue 053 — the cell text caret: click → `.hw-caret` appears at the hit geometry; arrow moves are
// READ-ONLY re-queries drawn by ref (render-0, the 030 counter harness); typing commits ONE
// SetTableCellRuns per keystroke; Escape/off-cell click clears; a composing (IME) keydown is ignored.

const origRect = Element.prototype.getBoundingClientRect;
beforeAll(() => {
  Element.prototype.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: 794, bottom: 1123, width: 794, height: 1123, x: 0, y: 0, toJSON() {} }) as DOMRect;
});
afterAll(() => {
  Element.prototype.getBoundingClientRect = origRect;
});

const click = (el: Element, x: number, y: number) => {
  fireEvent.pointerDown(el, { clientX: x, clientY: y, button: 0, buttons: 1, pointerId: 1 });
  fireEvent.pointerUp(el, { clientX: x, clientY: y, button: 0, buttons: 0, pointerId: 1 });
};

const flush = () => new Promise((r) => setTimeout(r, 0));

/** The cell region is x ∈ [100, 300]: inside → a hit whose caret x tracks the offset; outside → null. */
function caretAdapter(over: Partial<ConstructorParameters<typeof MockAdapter>[0]> = {}) {
  const runs: RunSpec[] = [{ text: "AB", bold: true }];
  return new MockAdapter({
    hit: () => null,
    cellText: (page, x, _y): CellTextHit | null =>
      x >= 100 && x <= 300
        ? { section: 0, block: 1, row: 0, col: 0, para: 0, offset: 1, para_len: 2, caret: { page, x: 110, top: 40, height: 13 } }
        : null,
    cellCaret: (_s, _b, _r, _c, _p, offset) => ({ page: 0, x: 100 + offset * 10, top: 40, height: 13 }),
    runs,
    ...over,
  });
}

async function sheetOf(container: HTMLElement): Promise<HTMLElement> {
  return waitFor(() => {
    const el = container.querySelector('.hw-sheet[data-page="0"]') as HTMLElement | null;
    expect(el?.querySelector("svg")).toBeTruthy();
    return el as HTMLElement;
  });
}

function workspace(adapter: MockAdapter) {
  return render(
    <HwpWorkspace
      adapter={adapter}
      document={{ bytes: new Uint8Array([1]), name: "t.hwpx" }}
      onAiRequest={async () => []}
      enableEditing
    />,
  );
}

describe("cell text caret (issue 053)", () => {
  it("a plain click on cell text shows the caret; a click off any cell text clears it", async () => {
    const adapter = caretAdapter();
    const { container } = workspace(adapter);
    const sheet = await sheetOf(container);

    click(sheet, 150, 50);
    await waitFor(() => expect(container.querySelector(".hw-caret")).toBeTruthy());
    const caret = container.querySelector(".hw-caret") as HTMLElement;
    // Scale-agnostic: the layer multiplies every coordinate by the SAME page scale, so derive it from
    // the height (13 page-px) and check left/top against the HIT geometry (110, 40) at that scale.
    const s = parseFloat(caret.style.height) / 13;
    expect(s).toBeGreaterThan(0);
    expect(parseFloat(caret.style.left)).toBeCloseTo(110 * s, 3);
    expect(parseFloat(caret.style.top)).toBeCloseTo(40 * s, 3);

    click(sheet, 500, 50); // off the cell region → the controller clears (018)
    await waitFor(() => expect(container.querySelector(".hw-caret")).toBeNull());
  });

  it("Escape clears the caret", async () => {
    const adapter = caretAdapter();
    const { container } = workspace(adapter);
    const sheet = await sheetOf(container);
    click(sheet, 150, 50);
    await waitFor(() => expect(container.querySelector(".hw-caret")).toBeTruthy());
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(container.querySelector(".hw-caret")).toBeNull());
  });

  it("arrow moves re-position the caret by REF — 0 sheet renders, 0 workspace renders", async () => {
    const adapter = caretAdapter();
    const { container } = workspace(adapter);
    const sheet = await sheetOf(container);
    click(sheet, 150, 50);
    await waitFor(() => expect(container.querySelector(".hw-caret")).toBeTruthy());
    await flush();

    __resetSheetRenderCount();
    __resetWorkspaceRenderCount();

    // 5 arrow moves that stay INSIDE the text (offset alternates 1↔2 — a boundary arrow would
    // fall through to cell-nav and clear the caret). Read-only geometry re-queries; the controller
    // chains them; each emits a caret change the CaretLayer writes straight to the DOM.
    for (const key of ["ArrowRight", "ArrowLeft", "ArrowRight", "ArrowLeft", "ArrowRight"]) {
      fireEvent.keyDown(window, { key });
      await flush();
    }
    await waitFor(() => {
      const el = container.querySelector(".hw-caret") as HTMLElement;
      const s = parseFloat(el.style.height) / 13; // scale-agnostic (see the click test)
      // Final offset 2 → the mock's x = 100 + 2*10 = 120 page-px.
      expect(parseFloat(el.style.left)).toBeCloseTo(120 * s, 3);
    });

    expect(__getSheetRenderCount()).toBe(0);
    expect(__getWorkspaceRenderCount()).toBe(0);
    expect(adapter.applied).toHaveLength(0); // arrows are read-only — no intent, no undo unit
  });

  it("an arrow at the text boundary CLEARS the caret (한글식 fall-through to cell-nav)", async () => {
    const adapter = caretAdapter(); // click hit: offset 1 of para_len 2
    const { container } = workspace(adapter);
    const sheet = await sheetOf(container);
    click(sheet, 150, 50);
    await waitFor(() => expect(container.querySelector(".hw-caret")).toBeTruthy());

    fireEvent.keyDown(window, { key: "ArrowRight" }); // 1 → 2 (the paragraph end)
    await flush();
    expect(container.querySelector(".hw-caret")).toBeTruthy();
    fireEvent.keyDown(window, { key: "ArrowRight" }); // at the boundary → caret clears, cell-nav takes it
    await waitFor(() => expect(container.querySelector(".hw-caret")).toBeNull());
    expect(adapter.applied).toHaveLength(0); // pure navigation — never an edit
  });

  it("typing commits ONE SetTableCellRuns per keystroke (스타일 보존 splice); Backspace at start no-ops", async () => {
    const adapter = caretAdapter({
      cellText: (page, x): CellTextHit | null =>
        x >= 100 && x <= 300
          ? { section: 0, block: 1, row: 0, col: 0, para: 0, offset: 0, para_len: 2, caret: { page, x: 100, top: 40, height: 13 } }
          : null,
    });
    const { container } = workspace(adapter);
    const sheet = await sheetOf(container);
    click(sheet, 150, 50);
    await waitFor(() => expect(container.querySelector(".hw-caret")).toBeTruthy());

    fireEvent.keyDown(window, { key: "Backspace" }); // caret at the very start → graceful no-op
    await flush();
    expect(adapter.applied).toHaveLength(0);

    fireEvent.keyDown(window, { key: "X" });
    await waitFor(() => expect(adapter.applied).toHaveLength(1));
    expect(adapter.applied[0]).toEqual({
      intent: "SetTableCellRuns",
      section: 0,
      index: 1,
      row: 0,
      col: 0,
      runs: [{ text: "XAB", bold: true }], // inherits the bold run's style — never a plain-text collapse
    } as Intent);
  });

  it("a composing (IME) keydown is IGNORED — no half-composed jamo commit (FG-13 가드)", async () => {
    const adapter = caretAdapter();
    const { container } = workspace(adapter);
    const sheet = await sheetOf(container);
    click(sheet, 150, 50);
    await waitFor(() => expect(container.querySelector(".hw-caret")).toBeTruthy());

    fireEvent.keyDown(window, { key: "ㄱ", isComposing: true, keyCode: 229 });
    await flush();
    expect(adapter.applied).toHaveLength(0);
    expect(container.querySelector(".hw-caret")).toBeTruthy(); // the caret stays put
  });

  it("a backend WITHOUT the cell caret queries never shows a caret (018 feature-off)", async () => {
    const adapter = new MockAdapter({ hit: () => null, runs: [{ text: "AB" }] }); // no cellText/cellCaret
    const { container } = workspace(adapter);
    const sheet = await sheetOf(container);
    click(sheet, 150, 50);
    await flush();
    await flush();
    expect(container.querySelector(".hw-caret")).toBeNull();
  });
});
