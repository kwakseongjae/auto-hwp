import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { InPlaceCellEditor, PAGE_PX_PER_PT, computeInPlaceEditorStyle } from "../components/InPlaceCellEditor";

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

describe("InPlaceCellEditor (issue 032) — chrome-less in-place editor", () => {
  it("renders a textarea over the cell rect at the cell's own font size (no card/buttons/hints)", () => {
    render(<InPlaceCellEditor box={box} scale={1} initialText="원래" fontSizePt={9} onCommit={() => {}} onCancel={() => {}} />);
    const ta = screen.getByTestId("hw-inplace-editor") as HTMLTextAreaElement;
    expect(ta.tagName).toBe("TEXTAREA");
    expect(ta.value).toBe("원래");
    expect(ta.style.left).toBe("40px");
    expect(ta.style.top).toBe("60px");
    expect(ta.style.width).toBe("100px");
    expect(ta.style.fontSize).toBe("12px"); // 9pt × 4/3 × 1
    // chrome-less: no popover card, no 저장/취소 buttons, no hint text.
    expect(screen.queryByTestId("hw-cell-save")).toBeNull();
    expect(screen.queryByTestId("hw-cell-popover")).toBeNull();
  });

  it("Enter=저장 (commits the current text)", () => {
    const onCommit = vi.fn();
    render(<InPlaceCellEditor box={box} scale={1} initialText="a" onCommit={onCommit} onCancel={() => {}} />);
    const ta = screen.getByTestId("hw-inplace-editor");
    fireEvent.change(ta, { target: { value: "바뀜" } });
    fireEvent.keyDown(ta, { key: "Enter" });
    expect(onCommit).toHaveBeenCalledWith("바뀜");
  });

  it("Shift+Enter=개행 (does NOT commit — a newline)", () => {
    const onCommit = vi.fn();
    render(<InPlaceCellEditor box={box} scale={1} initialText="a" onCommit={onCommit} onCancel={() => {}} />);
    fireEvent.keyDown(screen.getByTestId("hw-inplace-editor"), { key: "Enter", shiftKey: true });
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("Esc=취소 (cancels, never commits)", () => {
    const onCommit = vi.fn();
    const onCancel = vi.fn();
    render(<InPlaceCellEditor box={box} scale={1} initialText="a" onCommit={onCommit} onCancel={onCancel} />);
    fireEvent.keyDown(screen.getByTestId("hw-inplace-editor"), { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("blur=저장 (외부 클릭 commits)", () => {
    const onCommit = vi.fn();
    render(<InPlaceCellEditor box={box} scale={1} initialText="x" onCommit={onCommit} onCancel={() => {}} />);
    fireEvent.blur(screen.getByTestId("hw-inplace-editor"));
    expect(onCommit).toHaveBeenCalledWith("x");
  });

  it("commits ONCE — the trailing blur after Enter does not double-fire (latched)", () => {
    const onCommit = vi.fn();
    render(<InPlaceCellEditor box={box} scale={1} initialText="x" onCommit={onCommit} onCancel={() => {}} />);
    const ta = screen.getByTestId("hw-inplace-editor");
    fireEvent.keyDown(ta, { key: "Enter" });
    fireEvent.blur(ta);
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("REFUSES to commit while an IME composition is in flight, then commits after compositionend (가드)", () => {
    const onCommit = vi.fn();
    render(<InPlaceCellEditor box={box} scale={1} initialText="" onCommit={onCommit} onCancel={() => {}} />);
    const ta = screen.getByTestId("hw-inplace-editor");
    fireEvent.compositionStart(ta);
    fireEvent.change(ta, { target: { value: "한" } });
    fireEvent.keyDown(ta, { key: "Enter" }); // this Enter CONFIRMS the IME candidate → must NOT commit
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.compositionEnd(ta);
    fireEvent.keyDown(ta, { key: "Enter" });
    expect(onCommit).toHaveBeenCalledWith("한");
  });

  it("a FAILED commit un-latches so the user can retry (issue 032 step 2 — 저장 실패 시 에디터 유지)", async () => {
    const onCommit = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce(undefined);
    render(<InPlaceCellEditor box={box} scale={1} initialText="v" onCommit={onCommit} onCancel={() => {}} />);
    const ta = screen.getByTestId("hw-inplace-editor");
    fireEvent.keyDown(ta, { key: "Enter" }); // rejects → the editor un-latches (stays open)
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.keyDown(ta, { key: "Enter" }); // retry → resolves
    expect(onCommit).toHaveBeenCalledTimes(2);
  });
});
