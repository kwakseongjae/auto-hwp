import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  HwpPageView,
  __getPageInjectCount,
  __resetPageRefreshCounts,
  __getSheetRenderCount,
  __resetSheetRenderCount,
} from "../components/HwpPageView";
import { MockAdapter } from "./mockAdapter";

// issue 037 — page virtualization. On a large doc HwpPageView keeps only the pages near the viewport (±
// buffer) mounted as heavy SVG sheets and turns every other page into a same-size blank placeholder
// (`.hw-sheet` + data-page + exact height, but NO svg). These tests prove, with a mock IntersectionObserver
// driving the visible set, that:
//   • a 20-page doc mounts ≤ 6 SVG sheets (the seed) while ALL 20 `.hw-sheet` DOM slots survive (contract);
//   • the placeholders keep data-page + the EXACT rendered height (so scroll geometry never jumps), and that
//     height scales with zoom;
//   • scrolling a far page into view sanitizes+injects it exactly once (re-entry restore);
//   • an edit to an OFF-SCREEN page defers the inject (dirty) and re-entry pays exactly one inject;
//   • the 034 inject counter still means "real injection" throughout.
//
// jsdom ships no IntersectionObserver, so we install a controllable mock: it records the observed
// `.hw-sheet-wrap` elements and lets a test fire synthetic intersections for chosen pages.

const VB_W = 794;
const VB_H = 1123;
const svgFor = (page: number, ver: number) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VB_W} ${VB_H}" width="${VB_W}" height="${VB_H}"><rect width="${VB_W}" height="${VB_H}" fill="#fff"/><text x="10" y="20">p${page}v${ver}</text></svg>`;

// ── controllable IntersectionObserver mock ──────────────────────────────────────────────────────────
class MockIO {
  static instances: MockIO[] = [];
  cb: IntersectionObserverCallback;
  targets = new Set<Element>();
  constructor(cb: IntersectionObserverCallback) {
    this.cb = cb;
    MockIO.instances.push(this);
  }
  observe(el: Element) {
    this.targets.add(el);
  }
  unobserve(el: Element) {
    this.targets.delete(el);
  }
  disconnect() {
    this.targets.clear();
  }
  takeRecords() {
    return [] as IntersectionObserverEntry[];
  }
  fire(entries: Array<{ target: Element; isIntersecting: boolean }>) {
    this.cb(entries as unknown as IntersectionObserverEntry[], this as unknown as IntersectionObserver);
  }
}

/** Fire an intersection change for a set of pages across every live observer, wrapped in act() so React
 *  flushes the resulting state + the deferred-sanitize effect. */
function setVisiblePages(pages: number[], isIntersecting: boolean) {
  act(() => {
    for (const io of MockIO.instances) {
      const entries: Array<{ target: Element; isIntersecting: boolean }> = [];
      io.targets.forEach((t) => {
        const p = Number((t as HTMLElement).getAttribute("data-page"));
        if (pages.includes(p)) entries.push({ target: t, isIntersecting });
      });
      if (entries.length) io.fire(entries);
    }
  });
}

function svgCount(c: HTMLElement) {
  return c.querySelectorAll(".hw-sheet svg").length;
}
function sheetCount(c: HTMLElement) {
  return c.querySelectorAll(".hw-sheet").length;
}
function placeholder(c: HTMLElement, page: number) {
  return c.querySelector(`.hw-sheet-placeholder[data-page="${page}"]`) as HTMLElement | null;
}

describe("page virtualization (issue 037)", () => {
  beforeEach(() => {
    MockIO.instances = [];
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = MockIO as unknown as typeof IntersectionObserver;
    __resetPageRefreshCounts();
    __resetSheetRenderCount();
  });
  afterEach(() => {
    delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
  });

  it("mounts ≤ 6 SVG sheets on a 20-page doc while keeping all 20 .hw-sheet slots", async () => {
    const N = 20;
    const versions = Array(N).fill(0);
    const adapter = new MockAdapter({ pages: N, svg: (p) => svgFor(p, versions[p] ?? 0) });
    const { container } = render(<HwpPageView adapter={adapter} pageCount={N} refreshToken={0} />);

    // Seed = first 6 pages → exactly those get an SVG; the far pages are placeholders (no svg).
    await waitFor(() => expect(__getPageInjectCount()).toBe(6));
    expect(svgCount(container)).toBeLessThanOrEqual(6);
    expect(svgCount(container)).toBe(6);
    // The DOM contract holds: every page still owns a `.hw-sheet` slot (placeholders included).
    expect(sheetCount(container)).toBe(N);
    // A far page (19) is a placeholder with NO svg.
    const ph = placeholder(container, 19);
    expect(ph).toBeTruthy();
    expect(ph!.querySelector("svg")).toBeNull();
  });

  it("placeholder keeps data-page + the exact rendered height, and it scales with zoom", async () => {
    const N = 20;
    const versions = Array(N).fill(0);
    const adapter = new MockAdapter({ pages: N, svg: (p) => svgFor(p, versions[p] ?? 0) });

    // zoom = 1 → sheet width 794 → placeholder height = 794 × (1123/794) = 1123.
    const { container, rerender } = render(<HwpPageView adapter={adapter} pageCount={N} zoom={1} refreshToken={0} />);
    await waitFor(() => expect(placeholder(container, 19)?.style.height).toBe(`${VB_H}px`));

    // zoom = 2 → sheet width 1588 → placeholder height doubles to 2246 (tracks the scroll geometry exactly).
    rerender(<HwpPageView adapter={adapter} pageCount={N} zoom={2} refreshToken={0} />);
    await waitFor(() => expect(placeholder(container, 19)?.style.height).toBe(`${VB_H * 2}px`));
  });

  it("scrolling a far page into view sanitizes + injects it exactly once (re-entry restore)", async () => {
    const N = 20;
    const versions = Array(N).fill(0);
    const adapter = new MockAdapter({ pages: N, svg: (p) => svgFor(p, versions[p] ?? 0) });
    const { container } = render(<HwpPageView adapter={adapter} pageCount={N} refreshToken={0} />);
    await waitFor(() => expect(__getPageInjectCount()).toBe(6));
    const farPh = placeholder(container, 18); // far page = placeholder, and it carries NO svg
    expect(farPh).toBeTruthy();
    expect(farPh!.querySelector("svg")).toBeNull();

    // Scroll page 18 into the buffer → the observer reports it visible → it injects (6 → 7) with its content.
    setVisiblePages([18], true);
    await waitFor(() => expect(__getPageInjectCount()).toBe(7));
    const sheet18 = container.querySelector(`.hw-sheet[data-page="18"]`) as HTMLElement;
    expect(sheet18.querySelector("svg")).toBeTruthy();
    expect(sheet18.textContent).toContain("p18v0");
    // It is no longer a placeholder.
    expect(container.querySelector(`.hw-sheet-placeholder[data-page="18"]`)).toBeNull();

    // Scroll it back OUT → it becomes a placeholder again, but NO new inject (the cache holds).
    setVisiblePages([18], false);
    await waitFor(() => expect(placeholder(container, 18)).toBeTruthy());
    expect(__getPageInjectCount()).toBe(7); // unchanged — re-entry didn't re-fetch/re-sanitize
  });

  it("an edit to an OFF-SCREEN page defers the inject (dirty); re-entry pays exactly one inject with the new content", async () => {
    const N = 20;
    const versions = Array(N).fill(0);
    const adapter = new MockAdapter({ pages: N, svg: (p) => svgFor(p, versions[p] ?? 0) });
    const { container, rerender } = render(<HwpPageView adapter={adapter} pageCount={N} refreshToken={0} />);
    await waitFor(() => expect(__getPageInjectCount()).toBe(6)); // seed 0..5 injected

    // Edit page 15 (off-screen). The refresh diffs every page (034 contract) but must NOT inject 15 — it is
    // off-screen, so its sanitize is DEFERRED (dirty). Zero new injects.
    __resetPageRefreshCounts();
    versions[15] = 1;
    rerender(<HwpPageView adapter={adapter} pageCount={N} refreshToken={1} />);
    // Give the async refresh time to run; page 15 stays a placeholder and nothing is injected.
    await waitFor(() => expect(placeholder(container, 15)?.style.height).toBe(`${VB_H}px`));
    expect(__getPageInjectCount()).toBe(0);
    expect(placeholder(container, 15)).toBeTruthy();

    // Now scroll page 15 into view → exactly ONE inject, and it shows the EDITED content (v1), not v0.
    setVisiblePages([15], true);
    await waitFor(() => expect(__getPageInjectCount()).toBe(1));
    const sheet15 = container.querySelector(`.hw-sheet[data-page="15"]`) as HTMLElement;
    expect(sheet15.textContent).toContain("p15v1");
  });

  it("shrinking a doc back UNDER the threshold flushes every still-deferred page (no blank sheets)", async () => {
    const N = 20;
    const versions = Array(N).fill(0);
    const adapter = new MockAdapter({ pages: N, svg: (p) => svgFor(p, versions[p] ?? 0) });
    const { container, rerender } = render(<HwpPageView adapter={adapter} pageCount={N} refreshToken={0} />);
    await waitFor(() => expect(__getPageInjectCount()).toBe(6)); // seed 0..5; 6..19 deferred (dirty)
    expect(placeholder(container, 8)).toBeTruthy(); // page 8 is a deferred placeholder

    // Edit deletes content down to 10 pages (< VIRTUALIZE_MIN_PAGES) → virtualization turns OFF, so EVERY
    // remaining page must be a real sheet. The formerly-deferred pages 6..9 (raw unchanged → the refresh
    // skips them) must be flushed by the visibility effect, not left blank.
    rerender(<HwpPageView adapter={adapter} pageCount={10} refreshToken={1} />);
    await waitFor(() => expect(sheetCount(container)).toBe(10));
    await waitFor(() => {
      for (let p = 0; p < 10; p++) expect(container.querySelector(`.hw-sheet[data-page="${p}"] svg`)).toBeTruthy();
    });
    // No placeholders remain once virtualization is off.
    expect(container.querySelectorAll(".hw-sheet-placeholder").length).toBe(0);
    expect(container.querySelector(`.hw-sheet[data-page="8"]`)!.textContent).toContain("p8v0");
  });

  it("re-entering an unchanged page that was already sanitized does NOT re-inject (instant restore)", async () => {
    const N = 20;
    const versions = Array(N).fill(0);
    const adapter = new MockAdapter({ pages: N, svg: (p) => svgFor(p, versions[p] ?? 0) });
    const { container } = render(<HwpPageView adapter={adapter} pageCount={N} refreshToken={0} />);
    await waitFor(() => expect(__getPageInjectCount()).toBe(6));

    // Page 2 is in the seed (already sanitized). Scroll it out then back in — the SVG is retained the whole
    // time, so re-entry pays NO inject (issue 037: "스크롤 재진입 시 즉시 복원").
    setVisiblePages([2], false);
    await waitFor(() => expect(placeholder(container, 2)).toBeTruthy());
    setVisiblePages([2], true);
    await waitFor(() => expect(container.querySelector(`.hw-sheet[data-page="2"] svg`)).toBeTruthy());
    expect(__getPageInjectCount()).toBe(6); // still 6 — no re-inject on a clean re-entry
  });
});
