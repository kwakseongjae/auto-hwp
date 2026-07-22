import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { RunSpec } from "@auto-hwp/editor-core";
import { InPlaceCellEditor, PAGE_PX_PER_PT, computeInPlaceEditorStyle } from "../components/InPlaceCellEditor";
import { applyLiveStyle } from "../richedit";

// Keep the REAL runsToHtml/serializeEditor (the commit path serializes the live DOM), but SPY applyLiveStyle
// so a ⌘B keystroke can be asserted without a real execCommand (jsdom has none). `...actual` re-exports the
// real helpers so the round-trip commit tests below run the genuine serialize.
vi.mock("../richedit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../richedit")>();
  return { ...actual, applyLiveStyle: vi.fn() };
});

// ── issue 032: the pure positioning math (unit-tested — this is what the e2e <4px assert measures) ──────
describe("computeInPlaceEditorStyle (issue 032 — font size × zoom + exact rect)", () => {
  it("is 4/3 page px per point (100 HWPUNIT/pt ÷ 75 HWPUNIT/px)", () => {
    expect(PAGE_PX_PER_PT).toBeCloseTo(4 / 3, 12);
  });

  it("maps the cell page-px rect × scale to the editor box and size_pt × 4/3 × scale to the font size", () => {
    const s = computeInPlaceEditorStyle({ x: 10, y: 20, w: 100, h: 30 }, 2, 12);
    expect(s.left).toBe(20);
    expect(s.top).toBe(40);
    expect(s.width).toBe(200);
    expect(s.minHeight).toBe(60);
    // 12pt × (4/3) × 2 = 32 client px.
    expect(s.fontSize).toBeCloseTo(32, 9);
  });

  it("tracks zoom: the SAME cell at scale 1 vs 0.5 scales left/top/width/fontSize together", () => {
    const a = computeInPlaceEditorStyle({ x: 40, y: 60, w: 100, h: 40 }, 1, 9);
    const b = computeInPlaceEditorStyle({ x: 40, y: 60, w: 100, h: 40 }, 0.5, 9);
    expect(b.left).toBe(a.left * 0.5);
    expect(b.top).toBe(a.top * 0.5);
    expect(b.width).toBe(a.width * 0.5);
    expect(b.fontSize!).toBeCloseTo(a.fontSize! * 0.5, 9);
  });

  it("omits fontSize when the run size is unknown (0 or undefined → inherit the sheet default)", () => {
    expect(computeInPlaceEditorStyle({ x: 0, y: 0, w: 10, h: 10 }, 1).fontSize).toBeUndefined();
    expect(computeInPlaceEditorStyle({ x: 0, y: 0, w: 10, h: 10 }, 1, 0).fontSize).toBeUndefined();
  });
});

const box = { x: 40, y: 60, w: 100, h: 40 };
const one = (text: string, extra: Partial<RunSpec> = {}): RunSpec[] => [{ text, ...extra }];
const editorEl = () => screen.getByTestId("hw-inplace-editor") as HTMLDivElement;
/** Replace the contentEditable's live content (an approximation of a browser edit). */
function setContent(html: string) {
  editorEl().innerHTML = html;
}

describe("InPlaceCellEditor (issues 032 + 040) — chrome-less contentEditable rich editor", () => {
  it("renders a contentEditable div over the cell rect at the cell's own font size (no card/buttons/hints)", () => {
    render(<InPlaceCellEditor box={box} scale={1} initialRuns={one("원래")} fontSizePt={9} onCommit={() => {}} onCancel={() => {}} />);
    const el = editorEl();
    expect(el.tagName).toBe("DIV");
    expect(el.getAttribute("contenteditable")).toBe("true");
    expect(el.getAttribute("data-inline-edit")).not.toBeNull(); // applyLiveStyle finds it by this attribute
    expect(el.textContent).toBe("원래");
    expect(el.style.left).toBe("40px");
    expect(el.style.top).toBe("60px");
    expect(el.style.width).toBe("100px");
    expect(el.style.fontSize).toBe("12px"); // 9pt × 4/3 × 1
    // chrome-less: no popover card, no 저장/취소 buttons, no hint text.
    expect(screen.queryByTestId("hw-cell-save")).toBeNull();
    expect(screen.queryByTestId("hw-cell-popover")).toBeNull();
  });

  it("renders EXISTING per-run formatting: a bold run becomes a bold span (issue 040 부분 서식)", () => {
    render(<InPlaceCellEditor box={box} scale={1} initialRuns={[{ text: "보통" }, { text: "굵게", bold: true }]} onCommit={() => {}} onCancel={() => {}} />);
    const bolds = Array.from(editorEl().querySelectorAll("span")).filter((s) => s.style.fontWeight === "700" || s.style.fontWeight === "bold");
    expect(bolds.map((s) => s.textContent)).toContain("굵게");
  });

  it("Enter=저장 commits the SERIALIZED runs (run-preserving); a bold run stays bold", () => {
    const onCommit = vi.fn();
    render(<InPlaceCellEditor box={box} scale={1} initialRuns={one("굵게", { bold: true })} onCommit={onCommit} onCancel={() => {}} />);
    // Edit inside the bold span (the browser keeps the span when typing into the selection) → still bold.
    setContent(`<div><span style="font-weight:700">바뀐값</span></div>`);
    fireEvent.keyDown(editorEl(), { key: "Enter" });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0][0]).toEqual([{ text: "바뀐값", bold: true }]);
  });

  it("Shift+Enter=개행 (does NOT commit — a newline)", () => {
    const onCommit = vi.fn();
    render(<InPlaceCellEditor box={box} scale={1} initialRuns={one("a")} onCommit={onCommit} onCancel={() => {}} />);
    fireEvent.keyDown(editorEl(), { key: "Enter", shiftKey: true });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("Esc=취소 (cancels, never commits)", () => {
    const onCommit = vi.fn();
    const onCancel = vi.fn();
    render(<InPlaceCellEditor box={box} scale={1} initialRuns={one("a")} onCommit={onCommit} onCancel={onCancel} />);
    fireEvent.keyDown(editorEl(), { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("blur=저장 (외부 클릭 commits the serialized runs)", () => {
    const onCommit = vi.fn();
    render(<InPlaceCellEditor box={box} scale={1} initialRuns={one("x")} onCommit={onCommit} onCancel={() => {}} />);
    fireEvent.blur(editorEl());
    expect(onCommit).toHaveBeenCalledTimes(1);
    // Committed WITHOUT an edit → the round-tripped runs (the rendered spans carry the DEFAULT_PT size, which
    // the host's no-op check treats as the inherit default). The text is intact.
    const runs = onCommit.mock.calls[0][0] as RunSpec[];
    expect(runs.map((r) => r.text).join("")).toBe("x");
  });

  it("commits ONCE — the trailing blur after Enter does not double-fire (latched)", () => {
    const onCommit = vi.fn();
    render(<InPlaceCellEditor box={box} scale={1} initialRuns={one("x")} onCommit={onCommit} onCancel={() => {}} />);
    const el = editorEl();
    fireEvent.keyDown(el, { key: "Enter" });
    fireEvent.blur(el);
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("REFUSES to commit while an IME composition is in flight, then commits after compositionend (가드)", () => {
    const onCommit = vi.fn();
    render(<InPlaceCellEditor box={box} scale={1} initialRuns={[{ text: "" }]} onCommit={onCommit} onCancel={() => {}} />);
    const el = editorEl();
    fireEvent.compositionStart(el);
    setContent(`<div><span>한</span></div>`);
    fireEvent.keyDown(el, { key: "Enter" }); // this Enter CONFIRMS the IME candidate → must NOT commit
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.compositionEnd(el);
    fireEvent.keyDown(el, { key: "Enter" });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0][0]).toEqual([{ text: "한" }]);
  });

  it("a FAILED commit un-latches so the user can retry (issue 032 step 2 — 저장 실패 시 에디터 유지)", async () => {
    const onCommit = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce(undefined);
    render(<InPlaceCellEditor box={box} scale={1} initialRuns={one("v")} onCommit={onCommit} onCancel={() => {}} />);
    const el = editorEl();
    fireEvent.keyDown(el, { key: "Enter" }); // rejects → the editor un-latches (stays open)
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.keyDown(el, { key: "Enter" }); // retry → resolves
    expect(onCommit).toHaveBeenCalledTimes(2);
  });

  it("⌘B / ⌘I / ⌘U / ⌘⇧S format the LIVE selection (applyLiveStyle) and NEVER commit (issue 040)", () => {
    const onCommit = vi.fn();
    render(<InPlaceCellEditor box={box} scale={1} initialRuns={one("서식")} onCommit={onCommit} onCancel={() => {}} />);
    const el = editorEl();
    const spy = vi.mocked(applyLiveStyle);
    spy.mockClear();
    fireEvent.keyDown(el, { key: "b", metaKey: true });
    fireEvent.keyDown(el, { key: "i", metaKey: true });
    fireEvent.keyDown(el, { key: "u", metaKey: true });
    fireEvent.keyDown(el, { key: "s", metaKey: true, shiftKey: true });
    expect(spy.mock.calls.map((c) => c[0])).toEqual([{ bold: true }, { italic: true }, { underline: true }, { strike: true }]);
    expect(onCommit).not.toHaveBeenCalled(); // a format shortcut is never a commit
  });

  it("Tab commits+moves with the serialized runs (issue 036 onCommitMove)", () => {
    const onCommitMove = vi.fn();
    render(<InPlaceCellEditor box={box} scale={1} initialRuns={one("칸")} onCommit={() => {}} onCancel={() => {}} onCommitMove={onCommitMove} />);
    setContent(`<div><span>다음</span></div>`);
    fireEvent.keyDown(editorEl(), { key: "Tab" });
    expect(onCommitMove).toHaveBeenCalledTimes(1);
    expect(onCommitMove.mock.calls[0][0]).toBe("right");
    expect(onCommitMove.mock.calls[0][1]).toEqual([{ text: "다음" }]);
  });
});
