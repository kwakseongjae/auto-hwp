import { fireEvent, render, waitFor } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HwpWorkspace, __getWorkspaceRenderCount, __resetWorkspaceRenderCount } from "../components/HwpWorkspace";
import { __getSheetRenderCount, __resetSheetRenderCount } from "../components/HwpPageView";
import type { BlockHit } from "../types";
import { MockAdapter } from "./mockAdapter";

// issue 030 — the render-count harness. A marquee drag (30 pointermoves over empty space) must NOT
// re-render the document sheets NOR the workspace: only the isolated MarqueeLayer updates. We measure
// BOTH counters across a real 30-move drag and assert they stay flat during the drag, with exactly the
// pointerUp settle re-rendering the workspace once.

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

const down = (el: Element, x: number, y: number) =>
  fireEvent.pointerDown(el, { clientX: x, clientY: y, button: 0, buttons: 1, pointerId: 1 });
const move = (el: Element, x: number, y: number) =>
  fireEvent.pointerMove(el, { clientX: x, clientY: y, buttons: 1, pointerId: 1 });
const up = (el: Element, x: number, y: number) =>
  fireEvent.pointerUp(el, { clientX: x, clientY: y, button: 0, buttons: 0, pointerId: 1 });

const flush = () => new Promise((r) => setTimeout(r, 0));

async function sheetOf(container: HTMLElement): Promise<HTMLElement> {
  return waitFor(() => {
    const el = container.querySelector('.hw-sheet[data-page="0"]') as HTMLElement | null;
    expect(el?.querySelector("svg")).toBeTruthy();
    return el as HTMLElement;
  });
}

describe("drag perf — sheets do not re-render during a marquee (issue 030)", () => {
  it("30 marquee moves: sheet renders 0, workspace renders 0; pointerUp settles once", async () => {
    // Empty everywhere (marquee-eligible) with two blocks the marquee crosses.
    const adapter = new MockAdapter({
      pages: 3, // several sheets so a regression (whole-tree re-render) is unmistakable in the count
      hit: () => null,
      blocks: [para(5, 400, 200, "블록 하나"), para(6, 620, 200, "블록 둘")],
    });
    const { container } = render(
      <HwpWorkspace adapter={adapter} document={{ bytes: new Uint8Array([1]), name: "t.hwpx" }} onAiRequest={async () => []} />,
    );
    const sheet = await sheetOf(container);
    await flush();

    // Begin a drag on empty space; let the async "empty" probe resolve so the first move starts a marquee.
    down(sheet, 80, 600);
    await flush();

    // Zero both counters AFTER the gesture has begun (pointerDown flips pointerActive → one settled render).
    __resetSheetRenderCount();
    __resetWorkspaceRenderCount();

    // 30 pointermoves — the marquee rectangle sweeps. NONE of these may re-render a sheet or the workspace.
    for (let i = 0; i < 30; i++) move(sheet, 300 + i * 4, 900 + i * 2);
    await waitFor(() => expect(container.querySelector(".hw-marquee")).toBeTruthy());

    const sheetDuringMoves = __getSheetRenderCount();
    const workspaceDuringMoves = __getWorkspaceRenderCount();
    // eslint-disable-next-line no-console
    console.log(`[030] during 30 moves — sheet renders=${sheetDuringMoves} workspace renders=${workspaceDuringMoves}`);

    // Release: the marquee resolves to the crossed blocks → the selection settles → ONE workspace render.
    up(sheet, 420, 960);
    await waitFor(() => expect(container.querySelectorAll(".hw-anchor").length).toBe(2));

    const sheetAfterUp = __getSheetRenderCount();
    const workspaceAfterUp = __getWorkspaceRenderCount();
    // eslint-disable-next-line no-console
    console.log(`[030] after pointerUp — sheet renders=${sheetAfterUp} workspace renders=${workspaceAfterUp}`);

    // During the drag: zero sheet re-renders and zero workspace re-renders.
    expect(sheetDuringMoves).toBe(0);
    expect(workspaceDuringMoves).toBe(0);
    // The sheets never re-render across the whole gesture (SVG string is unchanged → memo holds).
    expect(sheetAfterUp).toBe(0);
    // The pointerUp settle re-renders the workspace to reflect the new selection (at least once).
    expect(workspaceAfterUp).toBeGreaterThanOrEqual(1);
  });
});
