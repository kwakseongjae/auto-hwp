import { describe, expect, it } from "vitest";
import { clampOffset, hitResultToTextAnchor, isCaretGap } from "../caret";
import type { CaretRect, HitResult } from "../types";
import { MockAdapter } from "./mockAdapter";

// Issue 041 (FG-12 前半) — the glyph-caret MODEL: HitResult → TextAnchor, the para_len CLAMP regime, and
// the 018 null policy on the two new EngineAdapter methods. No wasm, no DOM. The empirical gap these
// tests pin (every benchmark body glyph resolves to node == null) is measured live by
// scripts/caret-geometry-smoke.mjs and written up in docs/CARET-GAP.md.

/** A body-anchored hit (an editable paragraph — `node` present). */
const bodyHit = (over: Partial<HitResult> = {}): HitResult => ({
  node: 7,
  block: 2,
  offset: 3,
  section: 0,
  para_ord: 5,
  in_cell: false,
  para_len: 10,
  ...over,
});

/** A table-cell hit — the primary gap: `in_cell` true, `node`/`block` null (no editable target in v1). */
const cellHit = (over: Partial<HitResult> = {}): HitResult => ({
  node: null,
  block: null,
  offset: 4,
  section: 0,
  para_ord: 0,
  in_cell: true,
  para_len: 0,
  ...over,
});

/** An unanchored body hit — the second gap: a binary-.hwp paragraph with no NodeId (`node` null, NOT in
 *  a cell). */
const unanchoredHit = (over: Partial<HitResult> = {}): HitResult => ({
  node: null,
  block: null,
  offset: 2,
  section: 0,
  para_ord: 1,
  in_cell: false,
  para_len: 0,
  ...over,
});

describe("clampOffset (para_len clamp regime)", () => {
  it("keeps an in-range offset unchanged", () => {
    expect(clampOffset(3, 10)).toBe(3);
    expect(clampOffset(0, 10)).toBe(0);
    expect(clampOffset(10, 10)).toBe(10);
  });
  it("clamps a PAST-END offset down to para_len (never past it)", () => {
    expect(clampOffset(11, 10)).toBe(10);
    expect(clampOffset(9999, 10)).toBe(10);
  });
  it("floors a negative / fractional / non-finite offset to a valid char index", () => {
    expect(clampOffset(-5, 10)).toBe(0);
    expect(clampOffset(3.9, 10)).toBe(3);
    expect(clampOffset(Number.NaN, 10)).toBe(0);
    expect(clampOffset(Number.POSITIVE_INFINITY, 10)).toBe(10);
  });
  it("clamps everything to 0 for an empty paragraph (para_len 0)", () => {
    expect(clampOffset(0, 0)).toBe(0);
    expect(clampOffset(5, 0)).toBe(0);
  });
});

describe("hitResultToTextAnchor (editable half — 018 null policy)", () => {
  it("resolves a body-anchored hit to a TextAnchor, carrying node/section/block + paraLen", () => {
    const a = hitResultToTextAnchor(bodyHit());
    expect(a).toEqual({ section: 0, block: 2, node: 7, offset: 3, paraLen: 10 });
    expect(a?.cell).toBeUndefined(); // v1: cell field reserved for 042, never populated
  });
  it("clamps the anchor offset to para_len (past-end hit → end-of-paragraph anchor, not null)", () => {
    const a = hitResultToTextAnchor(bodyHit({ offset: 99, para_len: 10 }));
    expect(a?.offset).toBe(10);
  });
  it("returns null for a table-cell hit (the gap: node null, no editable target in v1)", () => {
    expect(hitResultToTextAnchor(cellHit())).toBeNull();
  });
  it("returns null for an unanchored binary-.hwp paragraph (node null, not in a cell)", () => {
    expect(hitResultToTextAnchor(unanchoredHit())).toBeNull();
  });
  it("returns null for a null hit (off any glyph) — never throws", () => {
    expect(hitResultToTextAnchor(null)).toBeNull();
  });
});

describe("isCaretGap (which hits have no editable text target)", () => {
  it("is true for a table-cell hit and an unanchored hit", () => {
    expect(isCaretGap(cellHit())).toBe(true);
    expect(isCaretGap(unanchoredHit())).toBe(true);
  });
  it("is false for a body-anchored hit (it HAS a text target)", () => {
    expect(isCaretGap(bodyHit())).toBe(false);
  });
  it("is false for a null hit (empty space is not a gap — nothing to caret)", () => {
    expect(isCaretGap(null)).toBe(false);
  });
});

describe("EngineAdapter.hitTestText / caretRect (optional-method + null policy)", () => {
  it("OMITS both methods when the backend can't answer (reference TauriAdapter parity)", () => {
    const a = new MockAdapter({});
    expect(a.hitTestText).toBeUndefined();
    expect(a.caretRect).toBeUndefined();
  });

  it("exposes hitTestText when configured; returns null off any glyph (018)", async () => {
    const a = new MockAdapter({
      hitText: (_p, x) => (x < 100 ? null : bodyHit()),
    });
    expect(typeof a.hitTestText).toBe("function");
    expect(await a.hitTestText!(0, 10, 10)).toBeNull(); // off-glyph → null, not a throw
    expect(await a.hitTestText!(0, 200, 10)).toMatchObject({ node: 7, in_cell: false });
  });

  it("round-trips hit → anchor → caretRect and CLAMPS a past-end offset to a non-null rect", async () => {
    const rect: CaretRect = { x: 120, top: 90, height: 13 };
    const a = new MockAdapter({
      hitText: bodyHit(),
      // Model the engine contract: a valid page ALWAYS yields a rect (past-end is clamped), a wrong
      // page yields null (paragraph not rendered there).
      caret: (page, _node, _offset) => (page === 0 ? rect : null),
    });
    const hit = await a.hitTestText!(0, 150, 100);
    const anchor = hitResultToTextAnchor(hit);
    expect(anchor).not.toBeNull();
    // In-range and past-end BOTH return a rect (clamp = never null for a valid page).
    expect(await a.caretRect!(0, anchor!.node, anchor!.offset)).toEqual(rect);
    expect(await a.caretRect!(0, anchor!.node, anchor!.paraLen + 50)).toEqual(rect);
    // A page the paragraph does not render on → null (not a throw).
    expect(await a.caretRect!(9, anchor!.node, anchor!.offset)).toBeNull();
  });
});
