import { fireEvent, render, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { HwpWorkspace } from "../components/HwpWorkspace";
import type { OutlineItem } from "../types";
import { MockAdapter } from "./mockAdapter";

// Issue 046 — the outline panel + status bar WIRED into HwpWorkspace (hw-body left + bottom slots). The
// selection-summary / current-page come from the workspace; the panel click reuses the EXISTING scroll
// source (jumpToPage → scrollIntoView). 045 owns the keydown/toolbar — these tests only touch the new
// layout containers.

const OUTLINE: OutlineItem[] = [
  { section: 0, block: 0, level: 1, text: "□ 추진 개요", page: 0 },
  { section: 0, block: 5, level: 2, text: "1. 문제 인식", page: 1 },
  { section: 0, block: 9, level: 2, text: "2. 추진 방향", page: 2 },
];

const origRect = Element.prototype.getBoundingClientRect;
const origScrollIntoView = Element.prototype.scrollIntoView;
beforeAll(() => {
  Element.prototype.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: 794, bottom: 1123, width: 794, height: 1123, x: 0, y: 0, toJSON() {} }) as DOMRect;
});
afterAll(() => {
  Element.prototype.getBoundingClientRect = origRect;
  Element.prototype.scrollIntoView = origScrollIntoView;
});
afterEach(() => {
  try {
    window.localStorage.clear();
  } catch {
    /* ignore */
  }
});

const noAi = async () => [];

async function openWorkspace(opts: ConstructorParameters<typeof MockAdapter>[0]) {
  const adapter = new MockAdapter(opts);
  const utils = render(
    <HwpWorkspace adapter={adapter} document={{ bytes: new Uint8Array([1]), name: "t.hwpx" }} onAiRequest={noAi} enableEditing />,
  );
  await waitFor(() => {
    expect(utils.container.querySelector('.hw-sheet[data-page="0"] svg')).toBeTruthy();
  });
  return utils;
}

describe("HwpWorkspace outline + status bar (issue 046)", () => {
  it("renders the outline panel from the engine headings and the bottom status bar", async () => {
    const { getByTestId } = await openWorkspace({ outline: OUTLINE, pages: 3 });
    await waitFor(() => {
      const items = within(getByTestId("hw-outline")).getAllByTestId("hw-outline-item");
      expect(items).toHaveLength(3);
      expect(items[1].textContent).toContain("1. 문제 인식");
    });
    // Status bar shows total pages + an edit badge (편집 모드, since enableEditing + editable mock).
    expect(getByTestId("hw-statusbar-page").textContent).toContain("/ 3쪽");
    expect(getByTestId("hw-statusbar-mode").textContent).toContain("편집 모드");
  });

  it("clicking an outline item scrolls to that heading's page (existing scroll source)", async () => {
    const scrollSpy = vi.fn();
    Element.prototype.scrollIntoView = scrollSpy;
    const { getByTestId } = await openWorkspace({ outline: OUTLINE, pages: 3 });
    const items = within(getByTestId("hw-outline")).getAllByTestId("hw-outline-item");
    fireEvent.click(items[2]); // page 2
    expect(scrollSpy).toHaveBeenCalled();
  });

  it("falls back to a page list when the doc has no heading (빈 패널 금지)", async () => {
    const { getByTestId } = await openWorkspace({ outline: [], pages: 4 });
    await waitFor(() => {
      const items = within(getByTestId("hw-outline")).getAllByTestId("hw-outline-item");
      expect(items).toHaveLength(4);
      expect(items[0].textContent).toContain("1쪽");
    });
  });

  it("remembers the outline collapse state across sessions (localStorage)", async () => {
    const first = await openWorkspace({ outline: OUTLINE, pages: 3 });
    // Expanded by default → the heading list is present.
    expect(within(first.getByTestId("hw-outline")).queryAllByTestId("hw-outline-item")).toHaveLength(3);
    fireEvent.click(within(first.getByTestId("hw-outline")).getByTestId("hw-outline-toggle"));
    await waitFor(() => {
      expect(within(first.getByTestId("hw-outline")).queryAllByTestId("hw-outline-item")).toHaveLength(0);
    });
    expect(window.localStorage.getItem("tf-hwp:outline-collapsed")).toBe("1");
    first.unmount();

    // A fresh mount reads the persisted "collapsed" → starts collapsed.
    const second = await openWorkspace({ outline: OUTLINE, pages: 3 });
    expect(within(second.getByTestId("hw-outline")).queryAllByTestId("hw-outline-item")).toHaveLength(0);
  });
});
