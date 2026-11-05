import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEditorCore, type BlockHit, type CellAddr, type CellBoxItem, type EditorCore, type RunSpec } from "@auto-hwp/editor-core";
import { HwpWorkspace, type HwpWorkspaceProps, type WorkspaceHandle } from "../components/HwpWorkspace";
import { MockAdapter } from "./mockAdapter";

vi.mock("@auto-hwp/editor-core", async (original) => {
  const actual = await original<typeof import("@auto-hwp/editor-core")>();
  return { ...actual, createEditorCore: vi.fn(actual.createEditorCore) };
});

const doc = { bytes: new Uint8Array([1]), name: "focus.hwpx" };
const addr = { section: 0, block: 1, row: 0, col: 0 };
const para = (section: number, block: number, y = 50): BlockHit =>
  ({ section, block, kind: "paragraph", x: 80, y, w: 200, h: 20, text: "", editable: true });
const cell = (row: number, col: number, text = "AB", path: CellAddr[] = [{ block: 1, row, col }]): CellBoxItem =>
  ({ section: 0, block: 1, row, col, path, text, x: 80 + col * 100, y: 200 + row * 40, w: 100, h: 40 });

function adapterFor(pages = 1) {
  return new MockAdapter({
    pages,
    blocks: [para(1, 0), para(0, 3), { ...para(0, 2), editable: false }, para(0, 0)],
    // Deliberately shuffled; a merged/split cell is represented only by its model address.
    cellBoxes: [cell(1, 0), cell(0, 1), cell(0, 0, "AB\ncd")],
    runs: (_s, _b, row, col) => row === undefined ? [{ text: "" }] : [{ text: row === 0 && col === 0 ? "AB\ncd" : "AB" }],
    cellText: null,
    cellCaret: (_s, _b, row, col, p, offset) => ({ page: pages - 1, x: 80 + col * 100 + offset * 10, top: 200 + row * 40 + p * 16, height: 13 }),
  });
}

async function mount(adapter = adapterFor(), extra: Partial<HwpWorkspaceProps> = {}) {
  const ref = createRef<WorkspaceHandle>();
  const utils = render(<HwpWorkspace adapter={adapter} document={doc} onAiRequest={async () => []} enableEditing handleRef={ref} {...extra} />);
  await waitFor(() => expect(utils.container.querySelector(".hw-sheet svg")).toBeTruthy());
  const results = vi.mocked(createEditorCore).mock.results;
  const core = results[results.length - 1]!.value as EditorCore;
  return { ...utils, ref, core, adapter };
}

async function command(run: () => Promise<boolean>) {
  let result = false;
  await act(async () => { result = await run(); });
  return result;
}

const originalRect = Element.prototype.getBoundingClientRect;
const originalScroll = Element.prototype.scrollIntoView;
beforeEach(() => {
  vi.clearAllMocks();
  Element.prototype.getBoundingClientRect = function () {
    const top = Number((this as HTMLElement).dataset?.page ?? 0) * 1123;
    return { left: 0, top, right: 794, bottom: top + 1123, width: 794, height: 1123, x: 0, y: top, toJSON() {} } as DOMRect;
  };
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  Element.prototype.getBoundingClientRect = originalRect;
  Element.prototype.scrollIntoView = originalScroll;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("#507 WorkspaceHandle address focus", () => {
  it("focusCell sets the exact anchor and focuses IME, including from a host text input", async () => {
    const { ref, core, container, adapter } = await mount();
    const host = document.createElement("input");
    document.body.append(host);
    host.focus();
    try {
      expect(await command(() => ref.current!.focusCell(addr, 1))).toBe(true);
      expect(core.cellCaret.get()?.anchor).toEqual({ ...addr, para: 0, offset: 1, selAnchor: 1, paraLen: 2 });
      expect(document.activeElement).toBe(container.querySelector("[data-hw-ime-input]"));
      expect(adapter.applied).toEqual([]);
      fireEvent.keyDown(document.activeElement!, { key: "X" });
      await waitFor(() => expect(adapter.applied[0]).toMatchObject({ intent: "SetTableCellRuns", index: 1, row: 0, col: 0, runs: [{ text: "AXB" }, { text: "\n" }, { text: "cd" }] }));
    } finally { host.remove(); }
  });

  it("offset defaults to zero, clamps, and end applies to the addressed cell paragraph", async () => {
    const { ref, core } = await mount();
    expect(await command(() => ref.current!.focusCell(addr))).toBe(true);
    expect(core.cellCaret.get()?.anchor.offset).toBe(0);
    expect(await command(() => ref.current!.focusCell({ ...addr, para: 1 }, "end"))).toBe(true);
    expect(core.cellCaret.get()?.anchor).toMatchObject({ para: 1, offset: 2, paraLen: 2 });
    expect(await command(() => ref.current!.focusCell(addr, 99))).toBe(true);
    expect(core.cellCaret.get()?.anchor.offset).toBe(2);
  });

  it("focusParagraph resolves real glyph geometry, offset=end and IME focus", async () => {
    const adapter = new MockAdapter({
      blocks: [{ ...para(0, 3, 40), text: "가나" }], runs: [{ text: "가나", bold: true }],
      svg: () => '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 794 1123"><text x="100" y="50" font-size="13">가</text><text x="113" y="50" font-size="13">나</text></svg>',
    });
    const { ref, core, container } = await mount(adapter);
    expect(await command(() => ref.current!.focusParagraph({ section: 0, block: 3 }, "end"))).toBe(true);
    expect(core.bodyCaret.get()?.anchor).toEqual({ section: 0, block: 3, offset: 2, selAnchor: 2, paraLen: 2 });
    expect(core.caret.get()?.rect.x).toBe(126);
    expect(document.activeElement).toBe(container.querySelector("[data-hw-ime-input]"));
  });

  it("policy veto preserves caret, selection, focus and lastClickVetoed", async () => {
    const { ref, core, container } = await mount(adapterFor(), { editable: (t) => t.kind === "cell" && t.col === 0 });
    await command(() => ref.current!.focusCell(addr, 1));
    await act(async () => { await core.caret.extend(1); });
    const before = core.cellCaret.get();
    const selection = core.selection.getSelection();
    expect(await command(() => ref.current!.focusCell({ ...addr, col: 1 }))).toBe(false);
    expect(await command(() => ref.current!.focusParagraph({ section: 0, block: 0 }))).toBe(false);
    expect(core.cellCaret.get()).toBe(before);
    expect(core.selection.getSelection()).toBe(selection);
    expect(core.cellCaret.lastClickVetoed).toBe(false);
    expect(document.activeElement).toBe(container.querySelector("[data-hw-ime-input]"));
  });

  it("invalid addresses, missing geometry, engine-read-only paragraphs and read errors preserve the caret", async () => {
    const { ref, core, adapter } = await mount();
    await command(() => ref.current!.focusCell(addr, 1));
    const before = core.cellCaret.get();
    for (const target of [{ ...addr, row: -1 }, { ...addr, block: NaN }, { ...addr, para: 9 }]) {
      expect(await command(() => ref.current!.focusCell(target))).toBe(false);
    }
    expect(await command(() => ref.current!.focusParagraph({ section: 0, block: 2 }))).toBe(false);
    expect(await command(() => ref.current!.focusParagraph({ section: 9, block: 999 }))).toBe(false);
    vi.spyOn(adapter, "caretRectCell").mockResolvedValue(null);
    expect(await command(() => ref.current!.focusCell({ ...addr, col: 1 }))).toBe(false);
    vi.spyOn(adapter, "blockRuns").mockRejectedValue(new Error("read failed"));
    expect(await command(() => ref.current!.focusCell(addr))).toBe(false);
    expect(core.cellCaret.get()).toBe(before);
  });

  it("nested path reads and commits the leaf, and rejects unsupported or inconsistent paths", async () => {
    const path = [{ block: 1, row: 2, col: 3 }, { block: 4, row: 0, col: 1 }];
    const adapter = adapterFor();
    const read = vi.fn(async () => [{ text: "leaf" }] as RunSpec[]);
    Object.assign(adapter, { blockRunsPath: read });
    const rect = vi.spyOn(adapter, "caretRectCell");
    const { ref, core } = await mount(adapter);
    const nested = { ...addr, col: 1, path };
    expect(await command(() => ref.current!.focusCell(nested, "end"))).toBe(true);
    expect(read).toHaveBeenCalledWith(0, path);
    expect(rect).toHaveBeenLastCalledWith(0, 1, 0, 1, 0, 4, path);
    expect(core.cellCaret.get()?.anchor).toMatchObject({ path, offset: 4, paraLen: 4 });
    fireEvent.keyDown(document.activeElement!, { key: "X" });
    await waitFor(() => expect(adapter.applied[0]).toMatchObject({ path, row: 0, col: 1, runs: [{ text: "leafX" }] }));
    const before = core.cellCaret.get();
    expect(await command(() => ref.current!.focusCell({ ...nested, row: 9 }))).toBe(false);
    Object.assign(adapter, { blockRunsPath: undefined });
    expect(await command(() => ref.current!.focusCell(nested))).toBe(false);
    expect(core.cellCaret.get()).toBe(before);
  });

  it("scrolls a distant page and the caret rectangle into this canvas", async () => {
    const { ref, container } = await mount(adapterFor(3));
    const canvas = container.querySelector(".hw-canvas") as HTMLElement;
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, right: 300, bottom: 150, width: 300, height: 150 } as DOMRect);
    expect(await command(() => ref.current!.focusCell({ ...addr, col: 1 }))).toBe(true);
    expect(canvas.scrollTop).toBeGreaterThan(0);
    expect(container.querySelector('[data-page="2"] [data-hw-ime-input]')).toBe(document.activeElement);
  });

  it("a virtualized page that never becomes drawable returns false without changing caret", async () => {
    class NoIntersections {
      observe() {} unobserve() {} disconnect() {}
    }
    vi.stubGlobal("IntersectionObserver", NoIntersections);
    const adapter = adapterFor(20);
    vi.spyOn(adapter, "caretRectCell").mockResolvedValueOnce({ page: 0, x: 100, top: 200, height: 13 });
    const { ref, core } = await mount(adapter);
    await command(() => ref.current!.focusCell(addr));
    const before = core.cellCaret.get();
    expect(await command(() => ref.current!.focusCell({ ...addr, col: 1 }))).toBe(false);
    expect(core.cellCaret.get()).toBe(before);
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
  });

  it("scrolling a virtualized page mounts it before publishing and focusing its caret", async () => {
    let intersect: IntersectionObserverCallback;
    class Intersections {
      constructor(cb: IntersectionObserverCallback) { intersect = cb; }
      observe() {} unobserve() {} disconnect() {}
    }
    vi.stubGlobal("IntersectionObserver", Intersections);
    Element.prototype.scrollIntoView = function () {
      intersect([{ target: this, isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver);
    };
    const { ref, core, container } = await mount(adapterFor(20));
    expect(container.querySelector('.hw-sheet[data-page="19"] svg')).toBeNull();
    let pending!: Promise<boolean>;
    // Let the observer's visibility update and deferred SVG injection commit while focus waits for
    // that DOM; awaiting the entire command inside act would batch those commits until after timeout.
    await act(async () => {
      pending = ref.current!.focusCell(addr, 1);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    let focused = false;
    await act(async () => { focused = await pending; });
    expect(container.querySelector('.hw-sheet[data-page="19"] svg')).toBeTruthy();
    expect(focused).toBe(true);
    expect(core.caret.get()?.rect.page).toBe(19);
    expect(container.querySelector('[data-page="19"] [data-hw-ime-input]')).toBe(document.activeElement);
  });

  it("a pending address read cannot publish after unmount", async () => {
    const { ref, adapter, core, unmount } = await mount();
    let release!: (runs: RunSpec[]) => void;
    vi.spyOn(adapter, "blockRuns").mockReturnValue(new Promise((resolve) => { release = resolve; }));
    const pending = ref.current!.focusCell(addr);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    unmount();
    release([{ text: "AB" }]);
    expect(await pending).toBe(false);
    expect(core.caret.get()).toBeNull();
  });
});

describe("#507 reading order and Tab", () => {
  it("focusNext follows section/block/row/col/paragraph order, skips vetoes, and wraps only on request", async () => {
    const { ref, core } = await mount(adapterFor(2), { editable: (t) => t.kind !== "cell" || t.col !== 1 });
    const h = ref.current!;
    const seen: string[] = [];
    for (let i = 0; i < 6; i++) {
      expect(await command(() => h.focusNext())).toBe(true);
      const c = core.cellCaret.get()?.anchor;
      const b = core.bodyCaret.get()?.anchor;
      seen.push(c ? `c${c.section}/${c.block}/${c.row}/${c.col}/${c.para}` : `p${b!.section}/${b!.block}`);
    }
    expect(seen).toEqual(["p0/0", "c0/1/0/0/0", "c0/1/0/0/1", "c0/1/1/0/0", "p0/3", "p1/0"]);
    const last = core.bodyCaret.get();
    expect(await command(() => h.focusNext())).toBe(false);
    expect(core.bodyCaret.get()).toBe(last);
    expect(await command(() => h.focusNext(1, { wrap: true }))).toBe(true);
    expect(core.bodyCaret.get()?.anchor).toMatchObject({ section: 0, block: 0 });
    expect(await command(() => h.focusNext(-1))).toBe(false);
    expect(await command(() => h.focusNext(-1, { wrap: true }))).toBe(true);
    expect(core.bodyCaret.get()?.anchor).toMatchObject({ section: 1, block: 0 });
  });

  it("nested path order stays within the containing cell before the next outer cell", async () => {
    const adapter = adapterFor();
    const path = [{ block: 1, row: 0, col: 0 }, { block: 1, row: 0, col: 0 }];
    Object.assign(adapter, {
      blockRunsPath: async () => [{ text: "nested" }],
      cellBoxes: async () => [cell(0, 1), cell(0, 0, "nested", path), { ...cell(0, 0, ""), objects: true }],
    });
    const { ref, core } = await mount(adapter);
    await command(() => ref.current!.focusCell({ ...addr, para: 1 }));
    expect(await command(() => ref.current!.focusNext())).toBe(true);
    expect(core.cellCaret.get()?.anchor.path).toEqual(path);
    expect(await command(() => ref.current!.focusNext())).toBe(true);
    expect(core.cellCaret.get()?.anchor).toMatchObject({ col: 1, para: 0 });
  });

  it("rapid focusNext calls settle in key order", async () => {
    const { ref, core } = await mount();
    await act(async () => { expect(await Promise.all([ref.current!.focusNext(), ref.current!.focusNext(), ref.current!.focusNext()])).toEqual([true, true, true]); });
    expect(core.cellCaret.get()?.anchor).toMatchObject({ row: 0, col: 0, para: 1 });
  });

  it("typing immediately after Tab enters the next paragraph", async () => {
    const { ref, adapter } = await mount(adapterFor(), { tabNavigation: true });
    await command(() => ref.current!.focusCell(addr));
    fireEvent.keyDown(document.activeElement!, { key: "Tab" });
    fireEvent.keyDown(document.activeElement!, { key: "X" });
    await waitFor(() => expect(adapter.applied[0]).toMatchObject({ runs: [{ text: "AB" }, { text: "\n" }, { text: "Xcd" }] }));
  });

  it.each([false, true])("tabNavigation=%s controls Tab and Shift+Tab interception", async (tabNavigation) => {
    const { ref, core } = await mount(adapterFor(), { tabNavigation });
    await command(() => ref.current!.focusCell(addr));
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    fireEvent(document.activeElement!, tab);
    expect(tab.defaultPrevented).toBe(tabNavigation);
    if (tabNavigation) {
      await waitFor(() => expect(core.cellCaret.get()?.anchor.para).toBe(1));
      fireEvent.keyDown(document.activeElement!, { key: "Tab", shiftKey: true });
      await waitFor(() => expect(core.cellCaret.get()?.anchor.para).toBe(0));
    } else expect(core.cellCaret.get()?.anchor.para).toBe(0);
  });

  it("IME composition (store, isComposing or 229), host inputs and absent caret keep Tab", async () => {
    const { ref, core } = await mount(adapterFor(), { tabNavigation: true });
    const noCaret = new KeyboardEvent("keydown", { key: "Tab", cancelable: true });
    fireEvent(window, noCaret);
    expect(noCaret.defaultPrevented).toBe(false);
    await command(() => ref.current!.focusCell(addr));
    const ta = document.activeElement!;
    fireEvent.compositionStart(ta);
    for (const extra of [{}, { isComposing: true }, { keyCode: 229 }]) {
      const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true, ...extra });
      fireEvent(ta, tab);
      expect(tab.defaultPrevented).toBe(false);
    }
    expect(core.cellCaret.get()?.anchor.para).toBe(0);
    expect(await command(() => ref.current!.focusNext())).toBe(false);
    fireEvent.compositionEnd(ta, { data: "" });
    // Exercise native composition flags independently of the shared composition store.
    for (const extra of [{ isComposing: true }, { keyCode: 229 }]) {
      const composingTab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true, ...extra });
      fireEvent(ta, composingTab);
      expect(composingTab.defaultPrevented).toBe(false);
    }
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    fireEvent(input, tab);
    expect(tab.defaultPrevented).toBe(false);
    input.remove();
  });

  it("onTabNavigate overrides order and null blocks fallback, using the current address", async () => {
    const onTabNavigate = vi.fn().mockReturnValue({ kind: "paragraph", section: 1, block: 0 });
    const { ref, core } = await mount(adapterFor(), { tabNavigation: true, onTabNavigate });
    await command(() => ref.current!.focusCell(addr, 1));
    fireEvent.keyDown(document.activeElement!, { key: "Tab" });
    await waitFor(() => expect(core.bodyCaret.get()?.anchor.section).toBe(1));
    expect(onTabNavigate).toHaveBeenLastCalledWith({ direction: 1, current: { kind: "cell", ...addr, para: 0 } });
    onTabNavigate.mockReturnValue(null);
    const before = core.bodyCaret.get();
    fireEvent.keyDown(document.activeElement!, { key: "Tab", shiftKey: true });
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(core.bodyCaret.get()).toBe(before);
    expect(onTabNavigate).toHaveBeenLastCalledWith({ direction: -1, current: { kind: "paragraph", section: 1, block: 0 } });
  });

  it("rapid custom Tab navigation reads current after the preceding navigation settles", async () => {
    const onTabNavigate: NonNullable<HwpWorkspaceProps["onTabNavigate"]> = ({ current }) =>
      current?.kind === "cell" && current.col === 0
        ? { kind: "cell", ...addr, col: 1 }
        : { kind: "paragraph", section: 1, block: 0 };
    const { ref, core } = await mount(adapterFor(), { tabNavigation: true, onTabNavigate });
    await command(() => ref.current!.focusCell(addr));
    fireEvent.keyDown(document.activeElement!, { key: "Tab" });
    fireEvent.keyDown(document.activeElement!, { key: "Tab" });
    await waitFor(() => expect(core.bodyCaret.get()?.anchor.section).toBe(1));
  });

  it("disabled editing makes all focus methods return false", async () => {
    const { ref } = await mount(adapterFor(), { enableEditing: false });
    expect(await command(() => ref.current!.focusCell(addr))).toBe(false);
    expect(await command(() => ref.current!.focusParagraph({ section: 0, block: 0 }))).toBe(false);
    expect(await command(() => ref.current!.focusNext())).toBe(false);
  });

  it("an absent document makes all focus methods return false", async () => {
    const ref = createRef<WorkspaceHandle>();
    render(<HwpWorkspace adapter={adapterFor()} onAiRequest={async () => []} enableEditing handleRef={ref} />);
    expect(await command(() => ref.current!.focusCell(addr))).toBe(false);
    expect(await command(() => ref.current!.focusParagraph({ section: 0, block: 0 }))).toBe(false);
    expect(await command(() => ref.current!.focusNext())).toBe(false);
  });
});
