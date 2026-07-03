/// floatingPosition — the PURE position engine for the floating selection toolbar (issue 028 step 1).
/// Given the selection MARK boxes (own-render PAGE px, the same space SelectionOverlay draws), the page
/// `scale` (rendered px / viewBox px — the SINGLE conversion HwpPageView already computes; we never
/// re-derive it), and the viewport width in client px, it returns where to place the capsule toolbar:
/// centered above the selection, flipped BELOW when it would clip the viewport top, and clamped left/right
/// inside the viewport. No DOM, no React — unit-testable with plain boxes (issue 028 step 4).
///
/// COORDINATE CONTRACT: `marks` are page px; multiplying by `scale` yields client px (SAME as
/// SelectionOverlay's `box * scale`), so the toolbar tracks zoom exactly with no new arithmetic.

import type { PageBox } from "./coords";

/** The positioning container's client-px size. Only `width` drives the horizontal clamp; the top edge is
 *  the origin (0), so the flip decision needs no height. `height` is accepted for callers that pass a full
 *  rect but is not required. */
export interface FloatViewport {
  width: number;
  height?: number;
}

/** Toolbar geometry + spacing knobs. `toolbarWidth`/`toolbarHeight` are the measured capsule size (the
 *  component measures its own element and re-feeds them, so centering/clamping is exact). */
export interface FloatOptions {
  toolbarWidth: number;
  toolbarHeight: number;
  /** Gap in client px between the selection edge and the toolbar (default 8). */
  gap?: number;
  /** Minimum inset from the viewport edges (default 6). */
  margin?: number;
  /** Minimum inset of the tail (caret) from the toolbar's left/right edges (default 16). */
  caretInset?: number;
}

export type FloatPlacement = "above" | "below";

export interface FloatPosition {
  /** Toolbar left in the positioning space (client px). */
  x: number;
  /** Toolbar top in the positioning space (client px). */
  y: number;
  /** `above` = tail points DOWN at the selection; `below` = tail points UP (flipped). */
  placement: FloatPlacement;
  /** Tail x-offset relative to the toolbar's left edge (points at the selection center, clamped inside). */
  caretLeft: number;
}

/** The union bounding box of all mark boxes (page px). Multi-selection anchors the toolbar over the whole
 *  span (issue 028: "다중 선택은 마크들의 union bbox"). Returns null for an empty list. */
export function unionPageBox(marks: readonly PageBox[]): PageBox | null {
  if (marks.length === 0) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const m of marks) {
    x0 = Math.min(x0, m.x);
    y0 = Math.min(y0, m.y);
    x1 = Math.max(x1, m.x + m.w);
    y1 = Math.max(y1, m.y + m.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/// Compute the capsule toolbar's placement over `marks`. Returns null when there is nothing to point at.
export function computeFloatingPosition(
  marks: readonly PageBox[],
  scale: number,
  viewport: FloatViewport,
  opts: FloatOptions,
): FloatPosition | null {
  const u = unionPageBox(marks);
  if (!u) return null;

  const gap = opts.gap ?? 8;
  const margin = opts.margin ?? 6;
  const caretInset = opts.caretInset ?? 16;
  const tw = opts.toolbarWidth;
  const th = opts.toolbarHeight;

  // page px → client px via the SAME scale HwpPageView computes (SelectionOverlay uses the same product).
  const sx = u.x * scale;
  const sy = u.y * scale;
  const sw = u.w * scale;
  const sh = u.h * scale;
  const centerX = sx + sw / 2;

  // Horizontal: center over the selection, then clamp the whole toolbar inside the viewport.
  const maxX = Math.max(margin, viewport.width - tw - margin);
  const x = Math.min(Math.max(centerX - tw / 2, margin), maxX);

  // Vertical: prefer ABOVE; flip BELOW when the toolbar would clip the viewport top.
  let placement: FloatPlacement = "above";
  let y = sy - th - gap;
  if (y < margin) {
    placement = "below";
    y = sy + sh + gap;
  }

  // The tail points at the selection center, clamped so it stays on the toolbar body.
  const caretLeft = Math.min(Math.max(centerX - x, caretInset), Math.max(caretInset, tw - caretInset));

  return { x, y, placement, caretLeft };
}
