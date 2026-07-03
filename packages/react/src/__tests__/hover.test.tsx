import { fireEvent, render, waitFor } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HwpWorkspace, __getWorkspaceRenderCount, __resetWorkspaceRenderCount } from "../components/HwpWorkspace";
import { __getSheetRenderCount, __resetSheetRenderCount } from "../components/HwpPageView";
import { cursorForContext, __getHoverLayerRenderCount, __resetHoverLayerRenderCount } from "../hover";
import type { BlockHit, CellHit } from "../types";
import { MockAdapter } from "./mockAdapter";

// issue 038 — hover pre-highlight (FG-09) + cursor system (FG-06). We prove: (1) a hover outline appears
// over the block under the cursor at the right box; (2) a hover SWEEP across blocks re-renders neither the
// sheets nor the workspace (030 discipline, ref-mutation only); (3) the target dedup skips the wasm query
// while the pointer stays in one block; (4) suppression (drag/pan/editor) kills the highlight; (5) the
// cursor reflects the hit kind (text over a paragraph, default over a cell / when editing is off).

const origRect = Element.prototype.getBoundingClientRect;
beforeAll(() => {
  // Mock so the injected SVG's rect == its 794×1123 viewBox → screenToPage is the identity (page px == client px).
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

// Two stacked paragraphs: A over y∈[100,300), B over y∈[300,500). Everything else misses.
const paraHit = (_page: number, _x: number, y: number): BlockHit | null => {
  if (y >= 100 && y < 300) return para(1, 100, 200, "문단 A");
  if (y >= 300 && y < 500) return para(2, 300, 200, "문단 B");
  return null;
};

const cell = (row: number, col: number, y: number, h: number): CellHit => ({
  section: 0,
  block: 9,
  row,
  col,
  rows: 2,
  cols: 2,
  text: `${row}행`,
  x: 0,
  y,
  w: 400,
  h,
});

const move = (el: Element, x: number, y: number, buttons = 0) =>
  fireEvent.pointerMove(el, { clientX: x, clientY: y, buttons, pointerId: 1 });

const flush = () => new Promise((r) => setTimeout(r, 0));

async function sheetOf(container: HTMLElement): Promise<HTMLElement> {
  return waitFor(() => {
    const el = container.querySelector('.hw-sheet[data-page="0"]') as HTMLElement | null;
    expect(el?.querySelector("svg")).toBeTruthy();
    return el as HTMLElement;
  });
}

const renderWs = (adapter: MockAdapter, editing: boolean) =>
  render(
    <HwpWorkspace
      adapter={adapter}
      document={{ bytes: new Uint8Array([1]), name: "t.hwpx" }}
      onAiRequest={async () => []}
      enableEditing={editing}
    />,
  );

describe("cursorForContext — the single FG-06 cursor policy (pure)", () => {
  const base = { panning: false, panMode: false, overGrip: null as "col" | "row" | null, hitKind: null as string | null, editing: true };
  it("pan drag → grabbing; pan armed → grab (035 wins over everything)", () => {
    expect(cursorForContext({ ...base, panning: true })).toBe("grabbing");
    expect(cursorForContext({ ...base, panMode: true })).toBe("grab");
    // pan beats a paragraph/grip underneath
    expect(cursorForContext({ ...base, panning: true, hitKind: "paragraph", overGrip: "col" })).toBe("grabbing");
  });
  it("editing paragraph → text; col/row grip → col/row-resize; else default", () => {
    expect(cursorForContext({ ...base, hitKind: "paragraph" })).toBe("text");
    expect(cursorForContext({ ...base, overGrip: "col" })).toBe("col-resize");
    expect(cursorForContext({ ...base, overGrip: "row" })).toBe("row-resize");
    expect(cursorForContext({ ...base, hitKind: "table" })).toBe("default");
    expect(cursorForContext({ ...base, hitKind: null })).toBe("default");
  });
  it("editing OFF → always default (highlight-only mode), even over a paragraph or grip", () => {
    expect(cursorForContext({ ...base, editing: false, hitKind: "paragraph" })).toBe("default");
    expect(cursorForContext({ ...base, editing: false, overGrip: "col" })).toBe("default");
    // …but pan still wins even when editing is off (pan works in read mode)
    expect(cursorForContext({ ...base, editing: false, panMode: true })).toBe("grab");
  });
});

describe("hover pre-highlight + cursor (issue 038)", () => {
  it("hovering a paragraph shows the outline at its box + a text cursor; a block→block sweep renders 0", async () => {
    const adapter = new MockAdapter({ pages: 1, hit: paraHit });
    const { container } = renderWs(adapter, true);
    const sheet = await sheetOf(container);
    await flush();
    const canvas = container.querySelector(".hw-canvas") as HTMLElement;

    // Hover paragraph A (page y=150 ∈ [100,300)).
    move(sheet, 100, 150);
    const hover = await waitFor(() => {
      const el = container.querySelector(".hw-hover") as HTMLElement | null;
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    // scale = (794*0.9)/794 = 0.9 → box {0,100,794,200} draws at {0,90,·,180}. (위치 근사 assert)
    await waitFor(() => expect(hover.style.top).toBe("90px"));
    expect(hover.style.left).toBe("0px");
    expect(hover.style.height).toBe("180px");
    // Editable paragraph → text I-beam cursor on the sheet host.
    await waitFor(() => expect(canvas.dataset.hoverCursor).toBe("text"));

    // Zero every counter, then sweep across blocks A→B→A→B on the SAME page.
    __resetSheetRenderCount();
    __resetWorkspaceRenderCount();
    __resetHoverLayerRenderCount();
    move(sheet, 100, 350); // → B
    await waitFor(() => expect(container.querySelector(".hw-hover")?.getAttribute("style")).toContain("270px")); // 300*0.9
    move(sheet, 100, 150); // → A
    await waitFor(() => expect((container.querySelector(".hw-hover") as HTMLElement).style.top).toBe("90px"));
    move(sheet, 100, 350); // → B
    await waitFor(() => expect((container.querySelector(".hw-hover") as HTMLElement).style.top).toBe("270px"));

    // The heavy layers never re-render during the sweep — only the highlight div moved (by ref).
    expect(__getSheetRenderCount(), "sheets do not re-render on hover").toBe(0);
    expect(__getWorkspaceRenderCount(), "workspace does not re-render on hover").toBe(0);
    expect(__getHoverLayerRenderCount(), "HoverLayer moves by ref, no re-render across same-page blocks").toBe(0);
  });

  it("target dedup: staying inside one block does NOT re-query; crossing does", async () => {
    let calls = 0;
    const adapter = new MockAdapter({
      pages: 1,
      hit: (p, x, y) => {
        calls++;
        return paraHit(p, x, y);
      },
    });
    const { container } = renderWs(adapter, true);
    const sheet = await sheetOf(container);
    await flush();

    move(sheet, 100, 150); // → A (query #1)
    await waitFor(() => expect(container.querySelector(".hw-hover")).toBeTruthy());
    const afterA = calls;
    expect(afterA).toBeGreaterThanOrEqual(1);

    // Two more moves STILL inside A's box (y∈[100,300)) → no new hit-test (box-containment dedup).
    move(sheet, 120, 180);
    move(sheet, 200, 250);
    await flush();
    expect(calls, "moves within the same block are deduped (no re-query)").toBe(afterA);

    // Cross into B → exactly one more query.
    move(sheet, 100, 350);
    await waitFor(() => expect((container.querySelector(".hw-hover") as HTMLElement).style.top).toBe("270px"));
    expect(calls).toBe(afterA + 1);
  });

  it("over a table cell → emerald cell hint + default cursor (cells are not I-beam targets)", async () => {
    const adapter = new MockAdapter({
      pages: 1,
      hit: () => null,
      cell: (_p, _x, y) => (y >= 100 && y < 300 ? cell(1, 1, 100, 200) : null),
    });
    const { container } = renderWs(adapter, true);
    const sheet = await sheetOf(container);
    await flush();
    const canvas = container.querySelector(".hw-canvas") as HTMLElement;

    move(sheet, 50, 150);
    const hover = await waitFor(() => {
      const el = container.querySelector(".hw-hover") as HTMLElement | null;
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    await waitFor(() => expect(hover.className).toContain("hw-hover-cell"));
    // A cell is not a paragraph → cursor stays default (attribute cleared to "").
    expect(canvas.dataset.hoverCursor ?? "").toBe("");
  });

  it("suppression: a drag (button held) shows no highlight and no text cursor", async () => {
    const adapter = new MockAdapter({ pages: 1, hit: paraHit });
    const { container } = renderWs(adapter, true);
    const sheet = await sheetOf(container);
    await flush();
    const canvas = container.querySelector(".hw-canvas") as HTMLElement;

    move(sheet, 100, 150, 1); // buttons=1 → a drag; hover is suppressed
    await flush();
    expect(container.querySelector(".hw-hover")).toBeFalsy();
    expect(canvas.dataset.hoverCursor ?? "").toBe("");
  });

  it("suppression: Space pan-mode kills the highlight (035 owns the grab cursor)", async () => {
    const adapter = new MockAdapter({ pages: 1, hit: paraHit });
    const { container } = renderWs(adapter, true);
    const sheet = await sheetOf(container);
    await flush();

    move(sheet, 100, 150); // establish a highlight first
    await waitFor(() => expect(container.querySelector(".hw-hover")).toBeTruthy());

    // Arm pan mode (Space) — the batched suppression effect clears the highlight immediately.
    fireEvent.keyDown(window, { code: "Space", key: " " });
    await waitFor(() => expect(container.querySelector(".hw-hover")).toBeFalsy());
    // A hover while panning stays suppressed.
    move(sheet, 100, 350);
    await flush();
    expect(container.querySelector(".hw-hover")).toBeFalsy();
    fireEvent.keyUp(window, { code: "Space", key: " " });
  });

  it("editing OFF → highlight still shows, but the cursor stays default", async () => {
    const adapter = new MockAdapter({ pages: 1, hit: paraHit });
    const { container } = renderWs(adapter, false); // enableEditing off
    const sheet = await sheetOf(container);
    await flush();
    const canvas = container.querySelector(".hw-canvas") as HTMLElement;

    move(sheet, 100, 150);
    await waitFor(() => expect(container.querySelector(".hw-hover")).toBeTruthy());
    expect(canvas.dataset.hoverCursor ?? "").toBe(""); // no I-beam in read mode
  });
});
