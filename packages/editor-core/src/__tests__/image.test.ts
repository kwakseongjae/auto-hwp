import { describe, expect, it } from "vitest";
import { EditorCore } from "../core";
import { DocSession } from "../session";
import {
  HWPUNIT_PER_PX,
  imageSizeToHwpunit,
  resizeImageBox,
  appliedReflectsResize,
  type XYWH,
} from "../units";
import type { ImageBox } from "../types";
import { MockAdapter } from "./mockAdapter";

// Image move/resize SDK (issue 049): the pure geometry (px→HWPUNIT unit conversion, the 8-handle resize
// math with corner aspect lock, the resize apply-verify predicate) + the session read facade + the edit
// commit commands. All DOM-free — the react overlay is a thin binding over exactly these.

const START: XYWH = { x: 100, y: 100, w: 200, h: 100 }; // aspect 2:1

describe("units.imageSizeToHwpunit — the SINGLE px→HWPUNIT point (issue 049)", () => {
  it("converts each axis px × HWPUNIT_PER_PX, rounded, clamped ≥ 1", () => {
    expect(imageSizeToHwpunit(200, 100)).toEqual({ width: 200 * HWPUNIT_PER_PX, height: 100 * HWPUNIT_PER_PX });
    // sub-pixel never emits a zero/negative size (the op-bus SetImageSize refuses those).
    expect(imageSizeToHwpunit(0, 0)).toEqual({ width: 1, height: 1 });
    expect(imageSizeToHwpunit(-5, -5)).toEqual({ width: 1, height: 1 });
  });
});

describe("units.resizeImageBox — 8-handle resize (edges free, corners aspect-locked)", () => {
  it("east edge grows width only, origin fixed", () => {
    expect(resizeImageBox(START, "e", 40, 999)).toEqual({ x: 100, y: 100, w: 240, h: 100 });
  });
  it("south edge grows height only", () => {
    expect(resizeImageBox(START, "s", 999, 30)).toEqual({ x: 100, y: 100, w: 200, h: 130 });
  });
  it("west edge moves origin so the east edge stays put", () => {
    const b = resizeImageBox(START, "w", 50, 0); // drag left edge right by 50 → w shrinks 50
    expect(b.w).toBe(150);
    expect(b.x).toBe(150);
    expect(b.x + b.w).toBe(START.x + START.w); // east edge fixed
  });
  it("north edge moves origin so the south edge stays put", () => {
    const b = resizeImageBox(START, "n", 0, 20); // drag top edge down by 20 → h shrinks 20
    expect(b.h).toBe(80);
    expect(b.y).toBe(120);
    expect(b.y + b.h).toBe(START.y + START.h); // south edge fixed
  });

  it("SE corner PRESERVES the 2:1 aspect (dominant axis wins)", () => {
    // Drag right by 100 (relW 1.5) more than down by 10 (relH 1.1) → width dominates, height = w/2.
    const b = resizeImageBox(START, "se", 100, 10);
    expect(b.w).toBe(300);
    expect(b.h).toBe(150); // 300 / aspect(2) — ratio held, NOT the raw 110
    expect(b.w / b.h).toBeCloseTo(START.w / START.h, 6);
    expect(b.x).toBe(100); // origin fixed (NW corner is the anchor)
    expect(b.y).toBe(100);
  });

  it("NW corner keeps aspect AND re-anchors to the fixed SE corner", () => {
    const b = resizeImageBox(START, "nw", -100, -10); // pull NW out → grow
    expect(b.w / b.h).toBeCloseTo(2, 6);
    expect(b.x + b.w).toBe(START.x + START.w); // SE corner x fixed
    expect(b.y + b.h).toBe(START.y + START.h); // SE corner y fixed
  });

  it("Shift (free=true) releases the corner aspect lock — raw both-axis resize", () => {
    const b = resizeImageBox(START, "se", 100, 10, true);
    expect(b.w).toBe(300);
    expect(b.h).toBe(110); // NOT snapped to the ratio
  });

  it("never shrinks below minPx on the driven axis", () => {
    const b = resizeImageBox(START, "e", -1000, 0, false, 8);
    expect(b.w).toBe(8);
  });
});

describe("units.appliedReflectsResize — 적용-확인 (issue 049)", () => {
  it("true when the applied box changed size toward the intended dims", () => {
    const before = { w: 200, h: 100 };
    const intended = { w: 300, h: 150 };
    const applied = { w: 296, h: 148 }; // HWPUNIT round-trip lands a couple px short — still verified
    expect(appliedReflectsResize(before, intended, applied)).toBe(true);
  });
  it("false when a FROZEN engine returns the unchanged box (false-success guard)", () => {
    const before = { w: 200, h: 100 };
    const intended = { w: 300, h: 150 };
    expect(appliedReflectsResize(before, intended, before)).toBe(false);
  });
  it("false when it moved the WRONG way", () => {
    expect(appliedReflectsResize({ w: 200, h: 100 }, { w: 300, h: 150 }, { w: 150, h: 75 })).toBe(false);
  });
  it("true (nothing to verify) when there was no real intended change", () => {
    expect(appliedReflectsResize({ w: 200, h: 100 }, { w: 200, h: 100 }, { w: 200, h: 100 })).toBe(true);
  });
});

const box = (over: Partial<ImageBox> = {}): ImageBox => ({ x: 100, y: 100, w: 200, h: 100, section: 0, block: 3, ...over });

describe("DocSession.imageAt/imageBbox — read facade (issue 049)", () => {
  it("delegates to the adapter when supported", async () => {
    const adapter = new MockAdapter({ image: box(), imageBox: box({ w: 260 }) });
    const s = new DocSession(adapter);
    expect(await s.imageAt(0, 150, 130)).toEqual(box());
    expect(await s.imageBbox(0, 0, 3)).toEqual(box({ w: 260 }));
  });
  it("returns null (never throws) when the backend OMITS the methods (TauriAdapter-style parity)", async () => {
    const adapter = new MockAdapter({}); // no image opts → imageAt/imageBbox omitted
    expect(adapter.imageAt).toBeUndefined();
    expect(adapter.imageBbox).toBeUndefined();
    const s = new DocSession(adapter);
    expect(await s.imageAt(0, 1, 1)).toBeNull();
    expect(await s.imageBbox(0, 0, 3)).toBeNull();
  });
});

describe("EditController.resizeImage/moveImage — one Intent = one undo batch (issue 049)", () => {
  it("resizeImage emits SetImageSize with HWPUNIT dims and undoes as ONE unit", async () => {
    const adapter = new MockAdapter({});
    const core = new EditorCore(adapter);
    await core.session.open(new Uint8Array([1]), "t.hwpx");
    const { width, height } = imageSizeToHwpunit(260, 130);
    await core.edit.resizeImage(0, 3, width, height);
    expect(adapter.applied).toEqual([{ intent: "SetImageSize", section: 0, index: 3, width, height }]);
    // one applyBatch(size 1) → a single undo reverts it (ONE adapter.undo()).
    expect(await core.session.undo()).toBe(true);
    expect(adapter.undos).toBe(1);
  });

  it("moveImage emits MoveImage {section,from,to,width,height} (anchor reorder — NOT a free offset)", async () => {
    const adapter = new MockAdapter({});
    const core = new EditorCore(adapter);
    await core.session.open(new Uint8Array([1]), "t.hwpx");
    const { width, height } = imageSizeToHwpunit(200, 100);
    await core.edit.moveImage(0, 3, 7, width, height);
    expect(adapter.applied).toEqual([{ intent: "MoveImage", section: 0, from: 3, to: 7, width, height }]);
    expect(await core.session.undo()).toBe(true);
    expect(adapter.undos).toBe(1);
  });
});
