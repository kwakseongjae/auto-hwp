import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SelectionOverlay } from "../components/SelectionOverlay";

// 072 — "위치 보기" 플래시: AI 카드의 대상 블록 박스를 같은 page-px→client-px 스케일로 잠시 그린다.
describe("SelectionOverlay flash (072 위치 보기)", () => {
  it("flash 박스를 스케일 적용해 그리고, 다른 페이지에는 그리지 않는다", () => {
    const flash = { page: 1, box: { x: 10, y: 20, w: 100, h: 40 }, label: "편집 대상", kind: "reveal" };
    const { container } = render(<SelectionOverlay marks={[]} page={1} scale={2} flash={flash} />);
    const el = container.querySelector('[data-testid="hw-reveal-flash"]') as HTMLElement;
    expect(el).toBeTruthy();
    expect(el.style.left).toBe("20px"); // 10 × scale 2
    expect(el.style.width).toBe("200px");
    expect(el.textContent).toContain("편집 대상");
    // 다른 페이지 레이어에는 안 그린다(마크 0 + 플래시 타 페이지 → null 렌더).
    const other = render(<SelectionOverlay marks={[]} page={0} scale={2} flash={flash} />);
    expect(other.container.querySelector('[data-testid="hw-reveal-flash"]')).toBeNull();
  });
});
