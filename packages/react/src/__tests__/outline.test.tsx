import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { OutlinePanel } from "../components/OutlinePanel";
import { StatusBar } from "../components/StatusBar";
import type { EngineAdapter } from "../EngineAdapter";
import { activeOutlineIndex, pageAtReference } from "../outline";
import type { OutlineItem } from "../types";

// Issue 046 — the outline panel + status bar + their pure helpers. The current-position highlight rides a
// SCROLL-POSITION value (pageAtReference), so it is exercised independently of the 037 visible set.

const ITEMS: OutlineItem[] = [
  { section: 0, block: 0, level: 1, text: "□ 개요", page: 0 },
  { section: 0, block: 4, level: 2, text: "1. 문제 인식", page: 2 },
  { section: 0, block: 9, level: 2, text: "2. 추진 방향", page: 5 },
];

describe("outline pure helpers (issue 046)", () => {
  it("activeOutlineIndex: the last item whose page is at/before the current page", () => {
    expect(activeOutlineIndex(ITEMS, 0)).toBe(0);
    expect(activeOutlineIndex(ITEMS, 1)).toBe(0); // still inside item 0's span (item 1 starts at page 2)
    expect(activeOutlineIndex(ITEMS, 2)).toBe(1);
    expect(activeOutlineIndex(ITEMS, 4)).toBe(1);
    expect(activeOutlineIndex(ITEMS, 5)).toBe(2);
    expect(activeOutlineIndex(ITEMS, 99)).toBe(2);
  });
  it("activeOutlineIndex: empty list / all-after-current → 0", () => {
    expect(activeOutlineIndex([], 3)).toBe(0);
    expect(activeOutlineIndex([{ page: 4 }], 1)).toBe(0);
  });
  it("pageAtReference: the last wrapper at/above the reference line; returns the wrapper's own page", () => {
    const wraps = [
      { page: 0, top: -400 },
      { page: 1, top: -50 },
      { page: 2, top: 300 },
      { page: 3, top: 700 },
    ];
    expect(pageAtReference(wraps, 100)).toBe(1); // page 2's top (300) is below the ref line → current = 1
    expect(pageAtReference(wraps, 500)).toBe(2);
    expect(pageAtReference(wraps, -1000)).toBe(0); // nothing above the ref yet → first page
    expect(pageAtReference([], 100)).toBe(0);
  });
});

describe("OutlinePanel (issue 046)", () => {
  const base = {
    items: ITEMS,
    pageCount: 8,
    currentPage: 0,
    collapsed: false,
    onToggleCollapse: () => {},
    onJump: () => {},
  };

  it("lists the headings and jumps to the clicked heading's page (reuses the scroll source)", () => {
    const onJump = vi.fn();
    render(<OutlinePanel {...base} onJump={onJump} />);
    const items = screen.getAllByTestId("hw-outline-item");
    expect(items).toHaveLength(3);
    expect(items[1].textContent).toContain("1. 문제 인식");
    fireEvent.click(items[2]);
    expect(onJump).toHaveBeenCalledWith(5); // item 2 starts on page 5 (0-based)
  });

  it("highlights the heading containing the current page (aria-current)", () => {
    const { rerender } = render(<OutlinePanel {...base} currentPage={3} />);
    let items = screen.getAllByTestId("hw-outline-item");
    expect(items[1].getAttribute("aria-current")).toBe("true"); // page 3 → item 1 (pages 2..4)
    expect(items[0].getAttribute("aria-current")).toBeNull();
    rerender(<OutlinePanel {...base} currentPage={6} />);
    items = screen.getAllByTestId("hw-outline-item");
    expect(items[2].getAttribute("aria-current")).toBe("true"); // page 6 → item 2 (page 5+)
  });

  it("collapse toggle calls onToggleCollapse; collapsed shows only the expand affordance", () => {
    const onToggleCollapse = vi.fn();
    const { rerender } = render(<OutlinePanel {...base} onToggleCollapse={onToggleCollapse} />);
    fireEvent.click(screen.getByTestId("hw-outline-toggle"));
    expect(onToggleCollapse).toHaveBeenCalledTimes(1);
    rerender(<OutlinePanel {...base} collapsed onToggleCollapse={onToggleCollapse} />);
    // Collapsed → no heading items, just the toggle.
    expect(screen.queryAllByTestId("hw-outline-item")).toHaveLength(0);
    expect(screen.getByTestId("hw-outline-toggle")).toBeTruthy();
  });

  it("falls back to a PAGE LIST when there is no heading (빈 패널 금지)", () => {
    const onJump = vi.fn();
    render(<OutlinePanel {...base} items={[]} pageCount={4} currentPage={2} onJump={onJump} />);
    const items = screen.getAllByTestId("hw-outline-item");
    expect(items).toHaveLength(4); // 4 pages
    expect(items[0].textContent).toContain("1쪽");
    expect(items[3].textContent).toContain("4쪽");
    expect(items[2].getAttribute("aria-current")).toBe("true"); // current page 2 → 3쪽 highlighted
    fireEvent.click(items[3]);
    expect(onJump).toHaveBeenCalledWith(3);
  });
});

describe("OutlinePanel — page thumbnail rail (heading-less fallback)", () => {
  // A raw page SVG carrying a hostile <script> (must be stripped) plus a viewBox (fixes the thumb ratio).
  const RAW_SVG = (p: number) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 794 1123"><script>alert(${p})</script>` +
    `<rect width="794" height="1123" fill="#fff"/><text>page ${p + 1}</text></svg>`;

  const mockAdapter = () => ({ pageSvg: vi.fn(async (p: number) => RAW_SVG(p)) }) as unknown as EngineAdapter;

  const railBase = {
    items: [] as OutlineItem[],
    pageCount: 4,
    currentPage: 0,
    collapsed: false,
    onToggleCollapse: () => {},
    onJump: () => {},
    refreshToken: 0,
  };

  const blobText = async (b: Blob) => new TextDecoder().decode(await b.arrayBuffer());

  it("renders one live thumbnail per page as a rasterized <img> — sanitized, never raw-injected (R7)", async () => {
    const createSpy = vi.spyOn(URL, "createObjectURL");
    const adapter = mockAdapter();
    const { container } = render(<OutlinePanel {...railBase} adapter={adapter} />);

    // One clickable slot per page (skeleton shown until each rasterizes).
    expect(screen.getAllByTestId("hw-outline-item")).toHaveLength(4);

    // After the async fetch → sanitize → rasterize, every page is an <img> thumbnail (no IntersectionObserver
    // in jsdom → eager load, so all four resolve).
    const thumbs = await screen.findAllByTestId("hw-outline-thumb");
    expect(thumbs).toHaveLength(4);
    thumbs.forEach((t) => expect(t.tagName).toBe("IMG"));
    expect(adapter.pageSvg).toHaveBeenCalledTimes(4);

    // R7 — no raw injection: the rail contains NO <script> and NO inline <svg> (it uses <img> raster only).
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("svg")).toBeNull();

    // sanitizeSvg WAS applied: the Blob handed to createObjectURL dropped the <script>, kept the <rect>.
    const blob = createSpy.mock.calls[0][0] as Blob;
    const text = await blobText(blob);
    expect(text).not.toContain("<script");
    expect(text).toContain("<rect");
    createSpy.mockRestore();
  });

  it("clicking a thumbnail jumps to that page; the current page is highlighted (reuses currentPage)", async () => {
    const onJump = vi.fn();
    const adapter = mockAdapter();
    const { rerender } = render(<OutlinePanel {...railBase} adapter={adapter} currentPage={2} onJump={onJump} />);
    const items = await screen.findAllByTestId("hw-outline-item");
    expect(items).toHaveLength(4);

    // Active-page highlight rides currentPage (aria-current on the 3rd thumbnail only).
    expect(items[2].getAttribute("aria-current")).toBe("true");
    expect(items[0].getAttribute("aria-current")).toBeNull();

    // Click reuses the host's scroll source with the RIGHT page.
    fireEvent.click(items[3]);
    expect(onJump).toHaveBeenCalledWith(3);

    rerender(<OutlinePanel {...railBase} adapter={adapter} currentPage={0} onJump={onJump} />);
    const after = screen.getAllByTestId("hw-outline-item");
    expect(after[0].getAttribute("aria-current")).toBe("true");
    expect(after[2].getAttribute("aria-current")).toBeNull();
  });

  it("with NO adapter (rendererless backend) page mode degrades to a plain page-number list", () => {
    render(<OutlinePanel {...railBase} adapter={undefined} />);
    expect(screen.queryAllByTestId("hw-outline-thumb")).toHaveLength(0);
    const items = screen.getAllByTestId("hw-outline-item");
    expect(items).toHaveLength(4);
    expect(items[0].textContent).toContain("1쪽");
  });
});

describe("StatusBar (issue 046)", () => {
  it("shows 1-based current page / total, the selection summary, and the edit badge — but NOT zoom", () => {
    render(<StatusBar currentPage={2} pageCount={8} selectionSummary="3행 2열" editing canEdit />);
    expect(screen.getByTestId("hw-statusbar-page").textContent).toContain("3 / 8쪽");
    expect(screen.getByTestId("hw-statusbar-selection").textContent).toContain("3행 2열");
    expect(screen.getByTestId("hw-statusbar-mode").textContent).toContain("편집 모드");
    // Zoom % is owned by the top toolbar (중복 금지) — the status bar never prints a "%".
    expect(screen.getByTestId("hw-statusbar").textContent).not.toContain("%");
  });

  it("omits the selection summary when nothing is selected, and shows read-only when not editable", () => {
    render(<StatusBar currentPage={0} pageCount={3} selectionSummary={null} editing={false} canEdit={false} />);
    expect(screen.queryByTestId("hw-statusbar-selection")).toBeNull();
    expect(screen.getByTestId("hw-statusbar-mode").textContent).toContain("읽기 전용");
  });
});
