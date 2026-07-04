// Glyph-caret model helpers (issue 041, FG-12 前半) — pure, DOM-free, framework-agnostic.
//
// The engine exposes a CHARACTER-precise caret through two intents (both on the rhwp glyph-box path):
//   • HitTest(page, x, y)      → HitResult { node?, block?, offset, section, para_ord, in_cell, para_len }
//   • CaretRect(page, node, offset) → CaretRect { x, top, height }  (own-render PAGE px)
// `EngineAdapter.hitTestText` / `caretRect` surface those to any UI. This module turns a pixel-space
// `HitResult` into a MODEL `TextAnchor` (the editable half), and pins the two contracts the UI must
// honor and that FG-12 後半 (issue 042) builds on:
//   1) 018 null policy — a hit off any editable text is `null`, never a throw; a `caretRect` for a
//      paragraph not on the queried page is `null`.
//   2) para_len CLAMP — the engine CLAMPS a past-end `offset` to the paragraph end and returns a rect
//      (never null), so the UI must clamp its own caret moves to `[0, para_len]` and must NEVER read a
//      null rect as "end of paragraph". `clampOffset` is that single clamp point.
//
// THE GAP (docs/CARET-GAP.md): across all three benchmarks EVERY body glyph resolves to `node == null`
// (table-cell run, or an unanchored binary-.hwp paragraph), so `hitResultToTextAnchor` returns null for
// the entire benchmark corpus. `isCaretGap` lets the UI detect that and fall back to cell/block marking.

import type { HitResult, TextAnchor } from "./types";

/** Clamp a caret char offset into the valid `[0, paraLen]` range — the `HitResult.para_len` contract.
 *  The engine's `caretRect` CLAMPS a past-end offset (it never returns null for one), so the UI clamps
 *  its own caret moves to `paraLen` and must NOT read a null rect as "end of paragraph". A negative or
 *  non-finite offset floors to 0; a fractional offset floors to an integer char index. */
export function clampOffset(offset: number, paraLen: number): number {
  if (Number.isNaN(offset) || offset <= 0) return 0;
  if (offset >= paraLen) return paraLen; // past-end (incl. +Infinity) clamps to the paragraph end
  return Math.floor(offset);
}

/** Resolve a pixel-space `HitResult` to a MODEL `TextAnchor`, or `null` when the hit has NO editable
 *  text target — a table-cell run or an unanchored binary-.hwp paragraph (`node == null`), or a null
 *  hit (off any glyph). This is the 018 null policy in one place: "no editable caret here" is `null`,
 *  never a throw. The returned anchor's `offset` is already clamped to `[0, para_len]`. Cell text is
 *  unaddressable in v1 (docs/CARET-GAP.md), so `in_cell` hits (which carry `node == null`) return null. */
export function hitResultToTextAnchor(hit: HitResult | null): TextAnchor | null {
  if (!hit || hit.node == null || hit.block == null) return null;
  return {
    section: hit.section,
    block: hit.block,
    node: hit.node,
    offset: clampOffset(hit.offset, hit.para_len),
    paraLen: hit.para_len,
  };
}

/** True when a `HitResult` landed on geometry that has NO editable text target in v1 — i.e. the caret
 *  GAP (docs/CARET-GAP.md): a table-cell run (`in_cell`) or an unanchored paragraph (`node == null`).
 *  The UI uses this to decide whether to place a text caret or fall back to cell/block marking. A NULL
 *  hit (empty space, off any glyph) is NOT a gap — it returns false, since there is nothing to caret. */
export function isCaretGap(hit: HitResult | null): boolean {
  return !!hit && hit.node == null;
}
