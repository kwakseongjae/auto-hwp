import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TableInsertButton } from "../components/TableInsertButton";
import { FormatToolbar } from "../components/FormatToolbar";
import { CellTextPopover } from "../components/CellTextPopover";
import { Ruler } from "../components/Ruler";
import { ColumnResizeOverlay } from "../components/ColumnResizeOverlay";

describe("TableInsertButton (issue 027 step 2)", () => {
  it("opens the grid picker and fires onPick(rows, cols) on a cell click", () => {
    const picks: [number, number][] = [];
    render(<TableInsertButton onPick={(r, c) => picks.push([r, c])} />);
    fireEvent.click(screen.getByTestId("hw-table-insert"));
    expect(screen.getByTestId("hw-table-picker")).toBeTruthy();
    // hover then click the 2×3 cell.
    const cell = screen.getByTestId("hw-table-cell-2-3");
    fireEvent.mouseEnter(cell);
    expect(screen.getByTestId("hw-table-picker-label").textContent).toContain("2 × 3");
    fireEvent.click(cell);
    expect(picks).toEqual([[2, 3]]);
  });
});

describe("FormatToolbar (issue 027 step 5)", () => {
  const cb = {
    onBold: vi.fn(),
    onItalic: vi.fn(),
    onSize: vi.fn(),
    onFont: vi.fn(),
    onColor: vi.fn(),
    onShade: vi.fn(),
  };
  it("enables format controls for a cell selection and fires callbacks", () => {
    render(<FormatToolbar box={{ x: 0, y: 40, w: 100, h: 20 }} scale={1} kind="cell" {...cb} />);
    const bold = screen.getByTestId("hw-fmt-bold") as HTMLButtonElement;
    expect(bold.disabled).toBe(false);
    fireEvent.click(bold);
    expect(cb.onBold).toHaveBeenCalled();
    fireEvent.change(screen.getByTestId("hw-fmt-shade"), { target: { value: "#00ff00" } });
    expect(cb.onShade).toHaveBeenCalledWith("#00ff00");
    fireEvent.click(screen.getByTestId("hw-fmt-shade-clear"));
    expect(cb.onShade).toHaveBeenCalledWith(null);
  });
  it("DISABLES controls for a paragraph selection (미지원 비활성 — never silent)", () => {
    render(<FormatToolbar box={{ x: 0, y: 40, w: 100, h: 20 }} scale={1} kind="paragraph" {...cb} />);
    const bold = screen.getByTestId("hw-fmt-bold") as HTMLButtonElement;
    expect(bold.disabled).toBe(true);
    expect(bold.getAttribute("title")).toContain("표 셀");
  });
});

describe("CellTextPopover (issue 027 step 4) — IME-safe", () => {
  it("renders the current text and commits on 저장", () => {
    const onCommit = vi.fn();
    render(<CellTextPopover box={{ x: 0, y: 0, w: 120, h: 20 }} scale={1} initialText="원래" onCommit={onCommit} onCancel={() => {}} />);
    const ta = screen.getByTestId("hw-cell-textarea") as HTMLTextAreaElement;
    expect(ta.value).toBe("원래");
    fireEvent.change(ta, { target: { value: "바뀜" } });
    fireEvent.click(screen.getByTestId("hw-cell-save"));
    expect(onCommit).toHaveBeenCalledWith("바뀜");
  });
  it("REFUSES to commit while an IME composition is in flight (compositionend 전 커밋 금지)", () => {
    const onCommit = vi.fn();
    render(<CellTextPopover box={{ x: 0, y: 0, w: 120, h: 20 }} scale={1} initialText="" onCommit={onCommit} onCancel={() => {}} />);
    const ta = screen.getByTestId("hw-cell-textarea");
    fireEvent.compositionStart(ta);
    fireEvent.change(ta, { target: { value: "한" } });
    fireEvent.click(screen.getByTestId("hw-cell-save")); // mid-composition → ignored
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.compositionEnd(ta);
    fireEvent.click(screen.getByTestId("hw-cell-save"));
    expect(onCommit).toHaveBeenCalledWith("한");
  });
});

describe("Ruler (issue 027 step 3)", () => {
  const geom = { w: 794, h: 1123, ml: 90, mt: 90, mr: 90, mb: 90 };
  it("display-only shows margins/width in mm and has no drag class", () => {
    render(<Ruler geom={geom} scale={1} />);
    // 90px @ 96dpi = 23.8mm.
    expect(screen.getByTestId("hw-ruler-readout").textContent).toContain("23.8mm");
    const l = screen.getByTestId("hw-ruler-margin-l");
    expect(l.className).not.toContain("hw-ruler-margin-drag");
  });
  it("editable ruler marks margin handles draggable", () => {
    render(<Ruler geom={geom} scale={1} onCommitMargins={() => {}} />);
    expect(screen.getByTestId("hw-ruler-margin-l").className).toContain("hw-ruler-margin-drag");
  });
});

describe("ColumnResizeOverlay (issue 027 step 1)", () => {
  it("renders an interior grip per interior boundary (endpoints excluded)", () => {
    render(<ColumnResizeOverlay boundaries={[0, 100, 200, 300]} top={10} height={50} scale={1} onCommit={() => {}} />);
    // 4 boundaries → 2 interior grips (index 1 and 2).
    expect(screen.getByTestId("hw-col-grip-1")).toBeTruthy();
    expect(screen.getByTestId("hw-col-grip-2")).toBeTruthy();
    expect(screen.queryByTestId("hw-col-grip-0")).toBeNull();
    expect(screen.queryByTestId("hw-col-grip-3")).toBeNull();
  });
  it("hides when there is no interior boundary (single column)", () => {
    const { container } = render(<ColumnResizeOverlay boundaries={[0, 300]} top={0} height={10} scale={1} onCommit={() => {}} />);
    expect(container.querySelector(".hw-col-resize")).toBeNull();
  });
});
