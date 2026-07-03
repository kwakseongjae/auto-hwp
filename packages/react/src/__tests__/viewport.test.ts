import { describe, expect, it } from "vitest";
import {
  ZOOM_MAX,
  ZOOM_MIN,
  clampZoom,
  fixedPointScreenX,
  fixedPointScreenY,
  isEditableTarget,
  panBy,
  wheelToZoomFactor,
  zoomAt,
} from "../viewport";

// issue 035 — the cursor-anchored zoom math is a PURE function so the fixed-point guarantee is proven
// without a browser: the document point under the cursor must stay put (< 1px) and the zoom must clamp to
// 25%…400%.

describe("zoomAt — cursor-anchored fixed point (issue 035)", () => {
  it("keeps the document point under the cursor fixed (error < 1px) across a range of pointers/scrolls", () => {
    const cases = [
      { zoom: 0.9, factor: 1.2, pointerX: 300, pointerY: 220, scrollLeft: 0, scrollTop: 0 },
      { zoom: 1.0, factor: 0.8, pointerX: 120, pointerY: 640, scrollLeft: 450, scrollTop: 1200 },
      { zoom: 1.4, factor: 1.35, pointerX: 40, pointerY: 15, scrollLeft: 999, scrollTop: 30 },
      { zoom: 0.5, factor: 2.0, pointerX: 500, pointerY: 500, scrollLeft: 20, scrollTop: 8000 },
      { zoom: 2.2, factor: 0.55, pointerX: 733, pointerY: 91, scrollLeft: 3000, scrollTop: 60 },
    ];
    for (const c of cases) {
      const res = zoomAt(c);
      // The on-screen offset of the cursor's document point BEFORE = pointer (by definition). AFTER, we
      // recompute it from the returned scroll; the two must agree within a sub-pixel.
      expect(Math.abs(fixedPointScreenX(c, res) - c.pointerX)).toBeLessThan(1);
      expect(Math.abs(fixedPointScreenY(c, res) - c.pointerY)).toBeLessThan(1);
    }
  });

  it("clamps zoom to [25%, 400%] and the fixed point STILL holds when saturated", () => {
    const zoomedOut = zoomAt({ zoom: 0.3, factor: 0.1, pointerX: 200, pointerY: 100, scrollLeft: 10, scrollTop: 10 });
    expect(zoomedOut.zoom).toBeCloseTo(ZOOM_MIN, 10); // 0.3*0.1=0.03 → clamped to 0.25
    expect(Math.abs(fixedPointScreenX({ scrollLeft: 10, pointerX: 200 }, zoomedOut) - 200)).toBeLessThan(1);

    const zoomedIn = zoomAt({ zoom: 3.5, factor: 5, pointerX: 200, pointerY: 100, scrollLeft: 10, scrollTop: 10 });
    expect(zoomedIn.zoom).toBeCloseTo(ZOOM_MAX, 10); // 3.5*5=17.5 → clamped to 4
    expect(Math.abs(fixedPointScreenY({ scrollTop: 10, pointerY: 100 }, zoomedIn) - 100)).toBeLessThan(1);
  });

  it("factor 1 is a no-op (zoom + scroll unchanged)", () => {
    const res = zoomAt({ zoom: 1.1, factor: 1, pointerX: 123, pointerY: 456, scrollLeft: 78, scrollTop: 90 });
    expect(res.zoom).toBe(1.1);
    expect(res.ratio).toBe(1);
    expect(res.scrollLeft).toBeCloseTo(78, 10);
    expect(res.scrollTop).toBeCloseTo(90, 10);
  });

  it("zooming IN grows scroll, zooming OUT shrinks it (about a positive pointer)", () => {
    const base = { pointerX: 400, pointerY: 300, scrollLeft: 1000, scrollTop: 800 };
    const inn = zoomAt({ zoom: 1, factor: 1.5, ...base });
    const out = zoomAt({ zoom: 1, factor: 0.5, ...base });
    expect(inn.scrollLeft).toBeGreaterThan(base.scrollLeft);
    expect(out.scrollLeft).toBeLessThan(base.scrollLeft);
  });
});

describe("clampZoom", () => {
  it("clamps and survives NaN/Infinity", () => {
    expect(clampZoom(0.1)).toBe(ZOOM_MIN);
    expect(clampZoom(9)).toBe(ZOOM_MAX);
    expect(clampZoom(1)).toBe(1);
    expect(clampZoom(Number.NaN)).toBe(ZOOM_MIN);
    expect(clampZoom(Number.POSITIVE_INFINITY)).toBe(ZOOM_MAX);
  });
});

describe("panBy — grab-hand delta", () => {
  it("moves the viewport opposite to the drag (content follows the finger)", () => {
    // Drag right+down by (30,40) → the content tracks the finger → scroll DECREASES by the same amount.
    expect(panBy({ scrollLeft: 100, scrollTop: 200 }, 30, 40)).toEqual({ scrollLeft: 70, scrollTop: 160 });
    // Drag up (dy<0) → scrollTop INCREASES (reveals content below).
    expect(panBy({ scrollLeft: 0, scrollTop: 0 }, 0, -50)).toEqual({ scrollLeft: 0, scrollTop: 50 });
  });
});

describe("wheelToZoomFactor", () => {
  it("deltaY<0 (pinch-open / ⌘wheel-up) zooms IN, deltaY>0 zooms OUT, and 0 is neutral", () => {
    expect(wheelToZoomFactor(-120)).toBeGreaterThan(1);
    expect(wheelToZoomFactor(120)).toBeLessThan(1);
    expect(wheelToZoomFactor(0)).toBe(1);
    expect(wheelToZoomFactor(Number.NaN)).toBe(1);
    // Opposite ticks compose back to ~identity (multiplicative symmetry).
    expect(wheelToZoomFactor(-100) * wheelToZoomFactor(100)).toBeCloseTo(1, 10);
  });
});

describe("isEditableTarget — Space guard", () => {
  it("blocks pan over text inputs / textarea / select / contentEditable, allows it elsewhere", () => {
    const mk = (tag: string, type?: string) => {
      const el = document.createElement(tag);
      if (type) (el as HTMLInputElement).type = type;
      return el;
    };
    expect(isEditableTarget(mk("textarea"))).toBe(true);
    expect(isEditableTarget(mk("select"))).toBe(true);
    expect(isEditableTarget(mk("input", "text"))).toBe(true);
    expect(isEditableTarget(mk("input", "number"))).toBe(true);
    expect(isEditableTarget(mk("input", "search"))).toBe(true);
    // non-text inputs let Space pass through to pan
    expect(isEditableTarget(mk("input", "checkbox"))).toBe(false);
    expect(isEditableTarget(mk("input", "file"))).toBe(false);
    expect(isEditableTarget(mk("input", "color"))).toBe(false);
    // plain elements / null
    expect(isEditableTarget(mk("div"))).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
    // contentEditable
    const ce = mk("div");
    ce.setAttribute("contenteditable", "true");
    // jsdom does not compute isContentEditable from the attribute; force the getter for the test.
    Object.defineProperty(ce, "isContentEditable", { value: true });
    expect(isEditableTarget(ce)).toBe(true);
  });
});
