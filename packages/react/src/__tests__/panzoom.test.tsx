import { fireEvent, render, waitFor } from "@testing-library/react";
import { act } from "react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HwpWorkspace, __getWorkspaceRenderCount, __resetWorkspaceRenderCount } from "../components/HwpWorkspace";
import { __getSheetRenderCount, __resetSheetRenderCount } from "../components/HwpPageView";
import { MockAdapter } from "./mockAdapter";

// issue 035 — the workspace half of pan/zoom: (1) Space toggles pan-mode but is NEVER stolen from a
// focused text-entry surface; (2) a continuous ⌘/pinch-zoom gesture does NOT re-render the document sheets
// per tick — it mutates a CSS transform directly and commits the real scale ONCE after a 150ms idle.

const origRect = Element.prototype.getBoundingClientRect;
beforeAll(() => {
  // jsdom has no layout — give the layer/canvas a finite rect so the zoom math has real inputs.
  Element.prototype.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: 794, bottom: 1123, width: 794, height: 1123, x: 0, y: 0, toJSON() {} }) as DOMRect;
});
afterAll(() => {
  Element.prototype.getBoundingClientRect = origRect;
});

const flush = () => new Promise((r) => setTimeout(r, 0));

async function mount() {
  const adapter = new MockAdapter({ pages: 3, hit: () => null });
  const { container } = render(
    <HwpWorkspace adapter={adapter} document={{ bytes: new Uint8Array([1]), name: "t.hwpx" }} onAiRequest={async () => []} />,
  );
  await waitFor(() => {
    const el = container.querySelector('.hw-sheet[data-page="0"]') as HTMLElement | null;
    expect(el?.querySelector("svg")).toBeTruthy();
  });
  await flush();
  return container;
}

describe("Space pan-mode gating (issue 035)", () => {
  it("Space enters pan-mode (grab) when nothing text-y is focused, and releases on keyup", async () => {
    const container = await mount();
    const canvas = container.querySelector(".hw-canvas") as HTMLElement;
    expect(canvas.classList.contains("hw-pan")).toBe(false);

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { code: "Space", bubbles: true }));
    });
    await waitFor(() => expect(canvas.classList.contains("hw-pan")).toBe(true));

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keyup", { code: "Space", bubbles: true }));
    });
    await waitFor(() => expect(canvas.classList.contains("hw-pan")).toBe(false));
  });

  it("Space is IGNORED while a text input (the chat composer) is focused — never hijacks typing", async () => {
    const container = await mount();
    const canvas = container.querySelector(".hw-canvas") as HTMLElement;
    const composer = container.querySelector(".hw-textarea") as HTMLTextAreaElement;
    composer.focus();
    expect(document.activeElement).toBe(composer);

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { code: "Space", bubbles: true }));
    });
    // Give any (erroneous) state flip a chance to land, then assert pan-mode stayed OFF.
    await flush();
    expect(canvas.classList.contains("hw-pan")).toBe(false);
  });
});

describe("continuous ⌘-wheel zoom: no per-tick re-render, one settle commit (issue 035)", () => {
  it("6 zoom ticks re-render 0 sheets and 0 workspaces; the debounced commit lands once and changes zoom", async () => {
    const container = await mount();
    const canvas = container.querySelector(".hw-canvas") as HTMLElement;
    const readout = () => (container.querySelector(".hw-zoom") as HTMLElement).textContent;
    const zoomBefore = readout(); // "90%"

    __resetSheetRenderCount();
    __resetWorkspaceRenderCount();

    // 6 ⌘-wheel ticks (zoom in). Each mutates ONLY the layer transform — no React state, no re-render.
    for (let i = 0; i < 6; i++) {
      fireEvent.wheel(canvas, { ctrlKey: true, deltaY: -100, clientX: 300, clientY: 300 });
    }
    const sheetDuring = __getSheetRenderCount();
    const wsDuring = __getWorkspaceRenderCount();
    // eslint-disable-next-line no-console
    console.log(`[035] during 6 zoom ticks — sheet renders=${sheetDuring} workspace renders=${wsDuring}`);
    expect(sheetDuring).toBe(0);
    expect(wsDuring).toBe(0);

    // The layer carries a live CSS transform during the gesture (instant visual feedback).
    const layer = container.querySelector(".hw-zoom-layer") as HTMLElement;
    expect(layer.style.transform).toMatch(/scale\(/);

    // Settle: after the 150ms idle debounce, ONE real-scale commit lands (zoom % changes).
    await act(async () => {
      await new Promise((r) => setTimeout(r, 220));
    });
    await waitFor(() => expect(readout()).not.toBe(zoomBefore));
    // eslint-disable-next-line no-console
    console.log(`[035] after settle — zoom ${zoomBefore} → ${readout()} · sheet renders=${__getSheetRenderCount()} workspace renders=${__getWorkspaceRenderCount()}`);

    // The heavy SVG sheets NEVER re-render (their string is unchanged → PageSheet memo holds); only the
    // lightweight wrapper widths + overlays re-layout at the new scale.
    expect(__getSheetRenderCount()).toBe(0);
    // Exactly the settle re-renders the workspace (accumulated ≥ 1, not per-tick).
    expect(__getWorkspaceRenderCount()).toBeGreaterThanOrEqual(1);
    // The transform is reset once the real scale lands (no lingering double-scale).
    expect(layer.style.transform).toBe("");
  });
});
