import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FormatRibbon, type RibbonFmt } from "../components/FormatRibbon";

const baseFmt: RibbonFmt = { bold: false, italic: false, underline: false, strike: false, sizePt: 11, color: null };

function renderRibbon(overrides: Partial<React.ComponentProps<typeof FormatRibbon>> = {}) {
  const onPatch = vi.fn();
  render(<FormatRibbon fmt={baseFmt} editing={false} onPatch={onPatch} {...overrides} />);
  return { onPatch };
}

describe("FormatRibbon (issue 048) — presentational dual-mode ribbon", () => {
  it("renders the full control set + a mode hint that flips with `editing`", () => {
    const { rerender } = render(<FormatRibbon fmt={baseFmt} editing={false} onPatch={() => {}} />);
    for (const id of ["hw-ribbon-bold", "hw-ribbon-italic", "hw-ribbon-underline", "hw-ribbon-strike", "hw-ribbon-size", "hw-ribbon-color", "hw-ribbon-shade", "hw-ribbon-shade-clear", "hw-ribbon-align-left", "hw-ribbon-align-justify"]) {
      expect(screen.getByTestId(id)).toBeTruthy();
    }
    expect(screen.getByTestId("hw-ribbon-mode").textContent).toContain("선택한 칸/범위");
    rerender(<FormatRibbon fmt={baseFmt} editing onPatch={() => {}} />);
    expect(screen.getByTestId("hw-ribbon-mode").textContent).toContain("편집 중");
  });

  it("fires onPatch with EXACTLY the changed attribute (B/I/U/S toggle off the current state)", () => {
    const onPatch = vi.fn();
    render(<FormatRibbon fmt={{ ...baseFmt, bold: true }} editing onPatch={onPatch} />);
    fireEvent.click(screen.getByTestId("hw-ribbon-bold"));
    expect(onPatch).toHaveBeenLastCalledWith({ bold: false }); // toggles off (fmt.bold was true)
    fireEvent.click(screen.getByTestId("hw-ribbon-italic"));
    expect(onPatch).toHaveBeenLastCalledWith({ italic: true });
    fireEvent.click(screen.getByTestId("hw-ribbon-underline"));
    expect(onPatch).toHaveBeenLastCalledWith({ underline: true });
    fireEvent.click(screen.getByTestId("hw-ribbon-strike"));
    expect(onPatch).toHaveBeenLastCalledWith({ strike: true });
  });

  it("toggle buttons light up (aria-pressed + active class) from `fmt`", () => {
    render(<FormatRibbon fmt={{ ...baseFmt, bold: true, underline: true }} editing onPatch={() => {}} />);
    const bold = screen.getByTestId("hw-ribbon-bold");
    const italic = screen.getByTestId("hw-ribbon-italic");
    expect(bold.getAttribute("aria-pressed")).toBe("true");
    expect(bold.className).toContain("hw-ribbon-btn-active");
    expect(italic.getAttribute("aria-pressed")).toBe("false");
    expect(italic.className).not.toContain("hw-ribbon-btn-active");
    expect(screen.getByTestId("hw-ribbon-underline").getAttribute("aria-pressed")).toBe("true");
  });

  it("크기 스테퍼 ± + 직접입력(Enter/blur) fire size patches; typing alone does NOT (no per-keystroke op)", () => {
    const { onPatch } = renderRibbon({ fmt: { ...baseFmt, sizePt: 12 } });
    fireEvent.click(screen.getByTestId("hw-ribbon-size-inc"));
    expect(onPatch).toHaveBeenLastCalledWith({ sizePt: 13 });
    fireEvent.click(screen.getByTestId("hw-ribbon-size-dec"));
    expect(onPatch).toHaveBeenLastCalledWith({ sizePt: 11 });
    onPatch.mockClear();
    const size = screen.getByTestId("hw-ribbon-size") as HTMLInputElement;
    fireEvent.change(size, { target: { value: "20" } });
    expect(onPatch).not.toHaveBeenCalled(); // typing does not commit
    fireEvent.keyDown(size, { key: "Enter" });
    expect(onPatch).toHaveBeenCalledWith({ sizePt: 20 });
  });

  it("색상 피커는 onChange로만 patch (onInput 스팸 금지, R13d): 글자색 → color, 배경/배경지움 → shade", () => {
    const { onPatch } = renderRibbon();
    fireEvent.change(screen.getByTestId("hw-ribbon-color"), { target: { value: "#ff0000" } });
    expect(onPatch).toHaveBeenLastCalledWith({ color: "#ff0000" });
    fireEvent.change(screen.getByTestId("hw-ribbon-shade"), { target: { value: "#00ff00" } });
    expect(onPatch).toHaveBeenLastCalledWith({ shade: "#00ff00" });
    fireEvent.click(screen.getByTestId("hw-ribbon-shade-clear"));
    expect(onPatch).toHaveBeenLastCalledWith({ shade: null });
  });

  it("정렬 4-way fires align patches", () => {
    const { onPatch } = renderRibbon();
    fireEvent.click(screen.getByTestId("hw-ribbon-align-center"));
    expect(onPatch).toHaveBeenLastCalledWith({ align: "center" });
    fireEvent.click(screen.getByTestId("hw-ribbon-align-justify"));
    expect(onPatch).toHaveBeenLastCalledWith({ align: "justify" });
  });

  it("버튼 mousedown은 preventDefault (함정: 리본 클릭이 contentEditable 선택을 붕괴시키지 않게)", () => {
    renderRibbon();
    // fireEvent returns false when the event was cancelled (preventDefault) — the B/I/정렬 buttons must
    // swallow the mousedown so the editor keeps focus + the live selection.
    expect(fireEvent.mouseDown(screen.getByTestId("hw-ribbon-bold"))).toBe(false);
    expect(fireEvent.mouseDown(screen.getByTestId("hw-ribbon-italic"))).toBe(false);
    expect(fireEvent.mouseDown(screen.getByTestId("hw-ribbon-align-left"))).toBe(false);
    expect(fireEvent.mouseDown(screen.getByTestId("hw-ribbon-shade-clear"))).toBe(false);
  });

  it("per-mode disabled + reason: inline/live-only/cell-only 각 그룹이 사유와 함께 비활성", () => {
    render(
      <FormatRibbon
        fmt={baseFmt}
        editing={false}
        onPatch={() => {}}
        inlineDisabledReason="셀을 선택하세요"
        liveOnlyDisabledReason="편집할 때만"
        cellOnlyDisabledReason="셀 선택 필요"
      />,
    );
    const bold = screen.getByTestId("hw-ribbon-bold") as HTMLButtonElement;
    expect(bold.disabled).toBe(true);
    expect(bold.getAttribute("title")).toBe("셀을 선택하세요");
    const underline = screen.getByTestId("hw-ribbon-underline") as HTMLButtonElement;
    expect(underline.disabled).toBe(true);
    expect(underline.getAttribute("title")).toBe("편집할 때만");
    const shade = screen.getByTestId("hw-ribbon-shade") as HTMLInputElement;
    expect(shade.disabled).toBe(true);
    const alignLeft = screen.getByTestId("hw-ribbon-align-left") as HTMLButtonElement;
    expect(alignLeft.disabled).toBe(true);
    expect(alignLeft.getAttribute("title")).toBe("셀 선택 필요");
  });
});
