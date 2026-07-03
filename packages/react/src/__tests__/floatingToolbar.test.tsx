import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FloatingToolbar } from "../components/FloatingToolbar";

const marks = [{ x: 100, y: 300, w: 120, h: 40 }];
const cb = () => ({
  onBold: vi.fn(),
  onItalic: vi.fn(),
  onSize: vi.fn(),
  onFont: vi.fn(),
  onColor: vi.fn(),
  onShade: vi.fn(),
  onAlign: vi.fn(),
  onSendToAi: vi.fn(),
});

describe("FloatingToolbar (issue 028) — capsule + tail + AI entry", () => {
  it("positions a capsule with a tail and fires the format callbacks for a cell selection", () => {
    const h = cb();
    render(<FloatingToolbar marks={marks} scale={1} viewportWidth={800} kind="cell" aiEnabled {...h} />);
    const bar = screen.getByTestId("hw-floating-toolbar");
    // it renders a positioned capsule with a placement + a tail.
    expect(bar.style.left).not.toBe("");
    expect(bar.getAttribute("data-placement")).toBe("above"); // y=300 is far from the top → above
    expect(screen.getByTestId("hw-floating-tail")).toBeTruthy();

    fireEvent.click(screen.getByTestId("hw-fmt-bold"));
    expect(h.onBold).toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("hw-fmt-align-center"));
    expect(h.onAlign).toHaveBeenCalledWith("center");
    fireEvent.change(screen.getByTestId("hw-fmt-shade"), { target: { value: "#00ff00" } });
    expect(h.onShade).toHaveBeenCalledWith("#00ff00");
    fireEvent.click(screen.getByTestId("hw-fmt-shade-clear"));
    expect(h.onShade).toHaveBeenCalledWith(null);
  });

  it("commits 크기 only on Enter/blur (직접입력, no per-keystroke Intent spam)", () => {
    const h = cb();
    render(<FloatingToolbar marks={marks} scale={1} viewportWidth={800} kind="cell" aiEnabled {...h} />);
    const size = screen.getByTestId("hw-fmt-size") as HTMLInputElement;
    fireEvent.change(size, { target: { value: "20" } }); // typing does NOT commit
    expect(h.onSize).not.toHaveBeenCalled();
    fireEvent.keyDown(size, { key: "Enter" });
    expect(h.onSize).toHaveBeenCalledWith(20);
  });

  it("AI에게 전달 is ALWAYS available (even when format is unsupported) and fires the callback", () => {
    const h = cb();
    render(
      <FloatingToolbar
        marks={marks}
        scale={1}
        viewportWidth={800}
        kind="paragraph"
        formatDisabledReason="표 셀/범위를 선택하면 서식을 적용할 수 있습니다"
        aiEnabled
        {...h}
      />,
    );
    // format controls DISABLED + reason tooltip (미지원 조합은 조용한 무시 금지 — 비활성+사유).
    const bold = screen.getByTestId("hw-fmt-bold") as HTMLButtonElement;
    expect(bold.disabled).toBe(true);
    expect(bold.getAttribute("title")).toContain("표 셀");
    // …but the AI entry stays enabled and fires.
    const ai = screen.getByTestId("hw-fmt-ai") as HTMLButtonElement;
    expect(ai.disabled).toBe(false);
    fireEvent.click(ai);
    expect(h.onSendToAi).toHaveBeenCalled();
  });

  it("renders nothing when there is no mark to point at", () => {
    const h = cb();
    const { container } = render(<FloatingToolbar marks={[]} scale={1} viewportWidth={800} kind="cell" aiEnabled {...h} />);
    expect(container.querySelector(".hw-floatbar")).toBeNull();
  });
});
