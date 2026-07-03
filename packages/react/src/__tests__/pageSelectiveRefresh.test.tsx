import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import {
  HwpPageView,
  __getPageInjectCount,
  __getPageSkipCount,
  __resetPageRefreshCounts,
  __getSheetRenderCount,
  __resetSheetRenderCount,
} from "../components/HwpPageView";
import { MockAdapter } from "./mockAdapter";

// issue 034 — page-selective refresh. The regression this kills: every edit re-fetches, re-sanitizes and
// re-injects ALL pages (measure-browser.mjs: 25p → ~107ms DOM tax). The fix compares each page's RAW svg
// string to its previous value and only sanitizes+injects the pages that actually changed. These tests
// PROVE that with the dev inject/skip counters:
//   • a single-page edit  → exactly 1 page injected, the rest skipped, and only 1 sheet re-renders;
//   • a reflow edit (content pushed down) → only the shifted tail re-injects;
//   • a font swap (all pages change) → every page re-injects;
//   • page-count increase/decrease → new pages inject / excess pages are removed;
//   • undo/redo go through the SAME selective path.
//
// A per-page svg embeds a version marker, so bumping a page's version yields a DIFFERENT raw string
// (an edit that re-renders THAT page). viewBox is present so parseViewBox succeeds.
const svgFor = (page: number, ver: number) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 794 1123" width="794" height="1123"><rect width="794" height="1123" fill="#fff"/><text x="10" y="20">p${page}v${ver}</text></svg>`;

/** Wait until the async refresh effect has processed every page exactly once (inject+skip === processed). */
async function settled(processed: number) {
  await waitFor(() => expect(__getPageInjectCount() + __getPageSkipCount()).toBe(processed));
}

function sheetCount(container: HTMLElement): number {
  return container.querySelectorAll(".hw-sheet").length;
}

describe("page-selective refresh (issue 034)", () => {
  beforeEach(() => {
    __resetPageRefreshCounts();
    __resetSheetRenderCount();
  });

  it("initial mount injects every page; a single-page edit injects ONLY the changed page", async () => {
    const N = 5;
    const versions = Array(N).fill(0);
    const adapter = new MockAdapter({ pages: N, svg: (p) => svgFor(p, versions[p] ?? 0) });

    // Initial render: every page is brand-new → all injected, none skipped.
    const { rerender, container } = render(<HwpPageView adapter={adapter} pageCount={N} refreshToken={0} />);
    await settled(N);
    expect(__getPageInjectCount()).toBe(N);
    expect(__getPageSkipCount()).toBe(0);
    await waitFor(() => expect(sheetCount(container)).toBe(N));

    // Edit page 2 only (bump its version); bump refreshToken to signal a refresh.
    __resetPageRefreshCounts();
    __resetSheetRenderCount();
    versions[2] += 1;
    rerender(<HwpPageView adapter={adapter} pageCount={N} refreshToken={1} />);
    await settled(N);

    // ONLY page 2 changed → 1 injected, 4 skipped.
    expect(__getPageInjectCount()).toBe(1);
    expect(__getPageSkipCount()).toBe(N - 1);
    // §구현 5 / 030 interaction: the 4 skipped pages' sheets must NOT re-render — exactly one sheet does.
    expect(__getSheetRenderCount()).toBe(1);
  });

  it("a reflow edit (content pushed down) re-injects only the shifted tail", async () => {
    const N = 5;
    const versions = Array(N).fill(0);
    const adapter = new MockAdapter({ pages: N, svg: (p) => svgFor(p, versions[p] ?? 0) });
    const { rerender } = render(<HwpPageView adapter={adapter} pageCount={N} refreshToken={0} />);
    await settled(N);

    // An edit on page 2 that grows a row pushes 2,3,4 down → those three svgs change; 0,1 are untouched.
    __resetPageRefreshCounts();
    versions[2] += 1;
    versions[3] += 1;
    versions[4] += 1;
    rerender(<HwpPageView adapter={adapter} pageCount={N} refreshToken={1} />);
    await settled(N);
    expect(__getPageInjectCount()).toBe(3);
    expect(__getPageSkipCount()).toBe(2);
  });

  it("a font swap (every page changes) re-injects all pages", async () => {
    const N = 5;
    const versions = Array(N).fill(0);
    const adapter = new MockAdapter({ pages: N, svg: (p) => svgFor(p, versions[p] ?? 0) });
    const { rerender } = render(<HwpPageView adapter={adapter} pageCount={N} refreshToken={0} />);
    await settled(N);

    // Registering a font re-lays-out the whole document → every page's svg changes.
    __resetPageRefreshCounts();
    for (let p = 0; p < N; p++) versions[p] += 1;
    rerender(<HwpPageView adapter={adapter} pageCount={N} refreshToken={1} />);
    await settled(N);
    expect(__getPageInjectCount()).toBe(N);
    expect(__getPageSkipCount()).toBe(0);
  });

  it("page-count INCREASE injects only the appended pages; unchanged pages are skipped", async () => {
    const versions = Array(8).fill(0);
    const adapter = new MockAdapter({ pages: 8, svg: (p) => svgFor(p, versions[p] ?? 0) });
    const { rerender, container } = render(<HwpPageView adapter={adapter} pageCount={5} refreshToken={0} />);
    await settled(5);
    await waitFor(() => expect(sheetCount(container)).toBe(5));

    // Grow to 7 pages (edit appended 2). Pages 0..4 raw unchanged → skipped; 5,6 are new → injected.
    __resetPageRefreshCounts();
    rerender(<HwpPageView adapter={adapter} pageCount={7} refreshToken={1} />);
    await settled(7);
    expect(__getPageInjectCount()).toBe(2);
    expect(__getPageSkipCount()).toBe(5);
    await waitFor(() => expect(sheetCount(container)).toBe(7));
  });

  it("page-count DECREASE removes the excess sheets and skips the remaining unchanged pages", async () => {
    const versions = Array(8).fill(0);
    const adapter = new MockAdapter({ pages: 8, svg: (p) => svgFor(p, versions[p] ?? 0) });
    const { rerender, container } = render(<HwpPageView adapter={adapter} pageCount={7} refreshToken={0} />);
    await settled(7);
    await waitFor(() => expect(sheetCount(container)).toBe(7));

    // Shrink to 4 pages (edit deleted content). Remaining pages 0..3 are unchanged → 0 injected, 4 skipped,
    // and the 3 trailing sheets are unmounted.
    __resetPageRefreshCounts();
    rerender(<HwpPageView adapter={adapter} pageCount={4} refreshToken={1} />);
    await settled(4);
    expect(__getPageInjectCount()).toBe(0);
    expect(__getPageSkipCount()).toBe(4);
    await waitFor(() => expect(sheetCount(container)).toBe(4));
  });

  it("undo/redo take the same selective path (only the reverted page re-injects)", async () => {
    const N = 5;
    const versions = Array(N).fill(0);
    const adapter = new MockAdapter({ pages: N, svg: (p) => svgFor(p, versions[p] ?? 0) });
    const { rerender } = render(<HwpPageView adapter={adapter} pageCount={N} refreshToken={0} />);
    await settled(N);

    // Edit page 1 (v0 → v1).
    __resetPageRefreshCounts();
    versions[1] = 1;
    rerender(<HwpPageView adapter={adapter} pageCount={N} refreshToken={1} />);
    await settled(N);
    expect(__getPageInjectCount()).toBe(1);
    expect(__getPageSkipCount()).toBe(N - 1);

    // Undo (page 1 reverts v1 → v0). The raw string differs from the cached v1 → exactly page 1 re-injects.
    __resetPageRefreshCounts();
    versions[1] = 0;
    rerender(<HwpPageView adapter={adapter} pageCount={N} refreshToken={2} />);
    await settled(N);
    expect(__getPageInjectCount()).toBe(1);
    expect(__getPageSkipCount()).toBe(N - 1);

    // Redo (page 1 back to v1) — same selective path.
    __resetPageRefreshCounts();
    versions[1] = 1;
    rerender(<HwpPageView adapter={adapter} pageCount={N} refreshToken={3} />);
    await settled(N);
    expect(__getPageInjectCount()).toBe(1);
    expect(__getPageSkipCount()).toBe(N - 1);
  });

  it("re-rendering with the SAME token/pages (no content change) injects nothing", async () => {
    const N = 4;
    const versions = Array(N).fill(0);
    const adapter = new MockAdapter({ pages: N, svg: (p) => svgFor(p, versions[p] ?? 0) });
    const { rerender } = render(<HwpPageView adapter={adapter} pageCount={N} refreshToken={0} />);
    await settled(N);

    // A refresh where nothing changed (e.g. a spurious layout signal) skips every page — zero DOM tax.
    __resetPageRefreshCounts();
    __resetSheetRenderCount();
    rerender(<HwpPageView adapter={adapter} pageCount={N} refreshToken={1} />);
    await settled(N);
    expect(__getPageInjectCount()).toBe(0);
    expect(__getPageSkipCount()).toBe(N);
    expect(__getSheetRenderCount()).toBe(0);
  });
});
