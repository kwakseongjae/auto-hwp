import { describe, expect, it } from "vitest";
import { computeFloatingPosition, unionPageBox } from "../floatingPosition";
import type { PageBox } from "../coords";

// Issue 028 step 4 — the PURE position engine. All page px; `scale=1` keeps the arithmetic legible. A
// wide viewport + a fixed toolbar size so we can assert exact numbers.
const TW = 200;
const TH = 40;
const OPTS = { toolbarWidth: TW, toolbarHeight: TH, gap: 8, margin: 6, caretInset: 16 };
const WIDE = { width: 1000 };

describe("computeFloatingPosition (issue 028 위치 엔진)", () => {
  it("기본: centers ABOVE the selection with the tail at the selection center", () => {
    const mark: PageBox = { x: 400, y: 300, w: 100, h: 40 };
    const pos = computeFloatingPosition([mark], 1, WIDE, OPTS)!;
    expect(pos).not.toBeNull();
    expect(pos.placement).toBe("above");
    // center of the mark = 450; toolbar left = 450 - 200/2 = 350.
    expect(pos.x).toBe(350);
    // above ⇒ toolbar bottom sits `gap` above the mark top: y = 300 - 40 - 8 = 252.
    expect(pos.y).toBe(252);
    // tail points at the mark center relative to the toolbar left: 450 - 350 = 100.
    expect(pos.caretLeft).toBe(100);
  });

  it("상단 플립: a selection near the viewport top flips BELOW (tail direction reverses)", () => {
    const mark: PageBox = { x: 400, y: 5, w: 100, h: 40 };
    const pos = computeFloatingPosition([mark], 1, WIDE, OPTS)!;
    expect(pos.placement).toBe("below");
    // below ⇒ toolbar sits `gap` under the mark bottom: y = 5 + 40 + 8 = 53.
    expect(pos.y).toBe(53);
  });

  it("좌우 클램프: clamps into the viewport at both edges and re-aims the tail", () => {
    // Hard LEFT: center 30 → wants x = -70, clamps to margin 6; tail = 30 - 6 = 24.
    const left = computeFloatingPosition([{ x: 10, y: 300, w: 40, h: 20 }], 1, WIDE, OPTS)!;
    expect(left.x).toBe(6);
    expect(left.caretLeft).toBe(24);

    // Hard RIGHT: viewport 1000, maxX = 1000 - 200 - 6 = 794; a mark at the far right clamps to 794.
    const right = computeFloatingPosition([{ x: 970, y: 300, w: 25, h: 20 }], 1, WIDE, OPTS)!;
    expect(right.x).toBe(794);
    // tail clamps to the toolbar's right inset: min(center - x, TW - caretInset) = min(982.5-794, 184) = 184.
    expect(right.caretLeft).toBe(184);
  });

  it("다중 마크 union: anchors over the union bbox of all marks", () => {
    const marks: PageBox[] = [
      { x: 100, y: 300, w: 50, h: 20 },
      { x: 300, y: 360, w: 50, h: 20 },
    ];
    const u = unionPageBox(marks)!;
    expect(u).toEqual({ x: 100, y: 300, w: 250, h: 80 });
    const pos = computeFloatingPosition(marks, 1, WIDE, OPTS)!;
    // union center x = 100 + 250/2 = 225 → toolbar left = 225 - 100 = 125.
    expect(pos.x).toBe(125);
    // above the union top (y=300): 300 - 40 - 8 = 252.
    expect(pos.placement).toBe("above");
    expect(pos.y).toBe(252);
  });

  it("scale: applies the SAME rendered/viewBox scale as SelectionOverlay (zoom-exact)", () => {
    const mark: PageBox = { x: 400, y: 300, w: 100, h: 40 };
    const pos = computeFloatingPosition([mark], 0.5, WIDE, OPTS)!;
    // center = (400 + 50) * 0.5 = 225 → x = 225 - 100 = 125; top = 300*0.5 - 40 - 8 = 102.
    expect(pos.x).toBe(125);
    expect(pos.y).toBe(102);
  });

  it("empty selection → null (nothing to point at)", () => {
    expect(computeFloatingPosition([], 1, WIDE, OPTS)).toBeNull();
    expect(unionPageBox([])).toBeNull();
  });
});
