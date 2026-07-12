import { fireEvent, render, waitFor } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HwpWorkspace, __getWorkspaceRenderCount, __resetWorkspaceRenderCount } from "../components/HwpWorkspace";
import { __getSheetRenderCount, __resetSheetRenderCount } from "../components/HwpPageView";
import type { CellTextHit, Intent, RunSpec } from "../types";
import { MockAdapter } from "./mockAdapter";

// issue 059 — IME inline composition. The 053 caret has NO focused editable at it, so 한글 조합이 시작조차
// 안 됐다(자모 keydown이 229 가드에 삼켜져 무입력 — 0단계 재현). This wires a caret-tracking hidden
// textarea (input capture) + a compositionView overlay: compositionstart/update draw the composing string BY
// REF (render-0); compositionend commits `end.data` as ONE SetTableCellRuns undo unit (the typed-text lane).

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

/** Cell region x ∈ [100,300]; a click there hits the cell at offset 0 of the bold run "AB". */
function imeAdapter(over: Partial<ConstructorParameters<typeof MockAdapter>[0]> = {}) {
  const runs: RunSpec[] = [{ text: "AB", bold: true }];
  return new MockAdapter({
    hit: () => null,
    cellText: (page, x): CellTextHit | null =>
      x >= 100 && x <= 300
        ? { section: 0, block: 1, row: 0, col: 0, para: 0, offset: 0, para_len: 2, caret: { page, x: 100, top: 40, height: 13 } }
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
  return render(<HwpWorkspace adapter={adapter} document={{ bytes: new Uint8Array([1]), name: "t.hwpx" }} onAiRequest={async () => []} enableEditing />);
}

/** Place a caret in the cell and return its (focused) hidden IME textarea. */
async function caretWithTextarea(container: HTMLElement) {
  const sheet = await sheetOf(container);
  click(sheet, 150, 50);
  await waitFor(() => expect(container.querySelector(".hw-caret")).toBeTruthy());
  const ta = (await waitFor(() => {
    const el = container.querySelector('[data-testid="hw-ime-input"]') as HTMLTextAreaElement | null;
    expect(el).toBeTruthy();
    return el;
  })) as HTMLTextAreaElement;
  return { sheet, ta };
}

describe("issue 059 — IME inline composition", () => {
  it("mounts a caret-tracking hidden textarea AT the caret and focuses it (input capture surface)", async () => {
    const { container } = workspace(imeAdapter());
    const { ta } = await caretWithTextarea(container);
    // Placed at the caret px (x=100, top=40 page-px × scale, derived from the caret bar's own scale).
    const caret = container.querySelector(".hw-caret") as HTMLElement;
    const s = parseFloat(caret.style.height) / 13;
    expect(parseFloat(ta.style.left)).toBeCloseTo(100 * s, 3);
    expect(parseFloat(ta.style.top)).toBeCloseTo(40 * s, 3);
    // Focused so a composition can begin (the whole point — 없으면 조합 시작 불가).
    await waitFor(() => expect(document.activeElement).toBe(ta));
  });

  it("compositionstart→update draws the composing string in the overlay and HIDES the real caret bar", async () => {
    const { container } = workspace(imeAdapter());
    const { ta } = await caretWithTextarea(container);

    fireEvent.compositionStart(ta, { data: "" });
    fireEvent.compositionUpdate(ta, { data: "ㅎ" });
    await waitFor(() => {
      const pv = container.querySelector('[data-testid="hw-ime-preview"]');
      expect(pv?.textContent).toContain("ㅎ");
    });
    // No double caret: while composing, the 053 bar is gone (the composition draws its own at the string end).
    expect(container.querySelector(".hw-caret")).toBeNull();

    fireEvent.compositionUpdate(ta, { data: "한" });
    await waitFor(() => expect(container.querySelector('[data-testid="hw-ime-preview"]')?.textContent).toContain("한"));
    // Still composing: the capture textarea is live and the real bar stays hidden until compositionend.
    expect(container.querySelector('[data-testid="hw-ime-input"]')).toBeTruthy();
    expect(container.querySelector(".hw-caret")).toBeNull();
  });

  it("compositionend commits end.data as ONE SetTableCellRuns (style-inheriting), then restores the caret", async () => {
    const adapter = imeAdapter();
    const { container } = workspace(adapter);
    const { ta } = await caretWithTextarea(container);

    fireEvent.compositionStart(ta, { data: "" });
    fireEvent.compositionUpdate(ta, { data: "ㅎ" });
    fireEvent.compositionUpdate(ta, { data: "한" });
    fireEvent.compositionEnd(ta, { data: "한" });

    await waitFor(() => expect(adapter.applied).toHaveLength(1));
    expect(adapter.applied[0]).toEqual({
      intent: "SetTableCellRuns",
      section: 0,
      index: 1,
      row: 0,
      col: 0,
      runs: [{ text: "한AB", bold: true }], // inserted at offset 0, inheriting the bold run (059 스타일 소스)
    } as Intent);
    // Overlay gone, textarea buffer cleared, real caret back (composition finished).
    await waitFor(() => expect(container.querySelector('[data-testid="hw-ime-preview"]')).toBeNull());
    expect(ta.value).toBe("");
    await waitFor(() => expect(container.querySelector(".hw-caret")).toBeTruthy());
  });

  it("an EMPTY compositionend is a no-op (도깨비불: only end.data is trusted)", async () => {
    const adapter = imeAdapter();
    const { container } = workspace(adapter);
    const { ta } = await caretWithTextarea(container);

    fireEvent.compositionStart(ta, { data: "" });
    fireEvent.compositionUpdate(ta, { data: "ㄱ" });
    fireEvent.compositionEnd(ta, { data: "" }); // cancelled composition
    await flush();
    expect(adapter.applied).toHaveLength(0);
    await waitFor(() => expect(container.querySelector(".hw-caret")).toBeTruthy()); // caret restored, nothing typed
  });

  it("the composition overlay updates are RENDER-0 (0 sheet renders, 0 workspace renders)", async () => {
    const { container } = workspace(imeAdapter());
    const { ta } = await caretWithTextarea(container);
    await flush();

    __resetSheetRenderCount();
    __resetWorkspaceRenderCount();

    fireEvent.compositionStart(ta, { data: "" });
    for (const d of ["ㅎ", "하", "한", "한ㄱ", "한그", "한글"]) fireEvent.compositionUpdate(ta, { data: d });
    await flush();
    await waitFor(() => expect(container.querySelector('[data-testid="hw-ime-preview"]')?.textContent).toContain("한글"));

    // The whole compose phase drew via refs — the SVG sheets and the workspace never re-rendered.
    expect(__getSheetRenderCount()).toBe(0);
    expect(__getWorkspaceRenderCount()).toBe(0);
  });

  it("EDITABLE-GUARD EXCEPTION: a plain key still types even though the IME textarea holds focus", async () => {
    const adapter = imeAdapter();
    const { container } = workspace(adapter);
    const { ta } = await caretWithTextarea(container);
    await waitFor(() => expect(document.activeElement).toBe(ta)); // textarea focused

    // No composition — a normal key. The window 053 typing listener must STILL fire (the exception makes
    // isEditableTarget(activeElement=our textarea) false), so a live caret keeps typing.
    fireEvent.keyDown(window, { key: "Z" });
    await waitFor(() => expect(adapter.applied).toHaveLength(1));
    expect(adapter.applied[0]).toMatchObject({ intent: "SetTableCellRuns", runs: [{ text: "ZAB", bold: true }] });
  });

  it("Escape DURING composition yields to the IME (does NOT clear the caret)", async () => {
    const adapter = imeAdapter();
    const { container } = workspace(adapter);
    const { ta } = await caretWithTextarea(container);

    fireEvent.compositionStart(ta, { data: "" });
    fireEvent.compositionUpdate(ta, { data: "한" });
    // Escape while composing → the 021/053 Escape handler must yield (composition store non-null) so the
    // caret is NOT cleared out from under the IME.
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.compositionEnd(ta, { data: "" }); // the IME cancel resolves as empty → no-op
    await flush();
    expect(adapter.applied).toHaveLength(0);
    // The caret survived (it would be gone had Escape cleared it) and reappears once composition ends.
    await waitFor(() => expect(container.querySelector(".hw-caret")).toBeTruthy());
  });

  it("clearing the caret (off-cell click) unmounts the textarea — IME session released", async () => {
    const { container } = workspace(imeAdapter());
    const { sheet } = await caretWithTextarea(container);
    click(sheet, 500, 50); // off the cell region → caret clears
    await waitFor(() => expect(container.querySelector(".hw-caret")).toBeNull());
    expect(container.querySelector('[data-testid="hw-ime-input"]')).toBeNull(); // textarea gone (blur + unmount)
  });
});
