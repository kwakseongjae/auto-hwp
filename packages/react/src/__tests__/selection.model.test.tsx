import { fireEvent, render, waitFor } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HwpWorkspace } from "../components/HwpWorkspace";
import type { BlockHit } from "../types";
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
