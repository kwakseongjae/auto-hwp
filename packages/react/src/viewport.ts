// viewport.ts — the PURE pan/zoom math for HwpWorkspace (issue 035). No DOM, no React: just the
// cursor-anchored zoom algebra + the grab-hand pan delta, so the fixed-point behaviour can be unit-tested
// without a browser. The workspace owns the DOM wiring (wheel/keydown/pointer, the CSS transform transient
// and the debounced real-zoom commit); this module owns the arithmetic those handlers call.
//
// Coordinate contract (matches the workspace's scroll container `.hw-canvas`):
//  · `pointerX/Y` = the cursor's position measured from the TOP-LEFT of the container's VISIBLE content
//    area (i.e. `clientX - contentBoxLeft`). It is the on-screen offset that must stay fixed under the zoom.
//  · `scrollLeft/Top` = the container's current scroll offset.
// The document point under the cursor sits at content coordinate `C = scroll + pointer` (in the current
// zoom's px). After scaling the content by `ratio`, that point moves to `C*ratio`; to keep it under the same
// on-screen offset we set `newScroll = C*ratio - pointer = (scroll + pointer)*ratio - pointer`.

/** Zoom clamp — 25%…400% (issue 035 §목표). Matches Figma's practical range. */
export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 4;

/** Default multiplicative step for the ⌘+/⌘- keys and the toolbar ±. */
export const ZOOM_STEP = 1.1;

/** Clamp a zoom factor into [min,max]; a non-finite input falls back to `min` (never NaN-propagates). */
export function clampZoom(zoom: number, min: number = ZOOM_MIN, max: number = ZOOM_MAX): number {
  if (Number.isNaN(zoom)) return min; // ±Infinity clamps naturally via Math.min/max below
  return Math.min(max, Math.max(min, zoom));
}

export interface ZoomAtInput {
  /** Current committed zoom (z0, > 0). */
  zoom: number;
  /** Desired MULTIPLICATIVE change (z1 = clamp(z0 * factor)). > 0. */
  factor: number;
  /** Cursor offset from the scroll container's visible content top-left, px (the fixed point). */
  pointerX: number;
  pointerY: number;
  /** Current scroll offset of the container, px. */
  scrollLeft: number;
  scrollTop: number;
  min?: number;
  max?: number;
}

export interface ZoomAtResult {
  /** The clamped new zoom (z1). */
  zoom: number;
  /** Corrected scroll so the document point under the cursor keeps its on-screen position. */
  scrollLeft: number;
  scrollTop: number;
  /** The effective scale ratio z1/z0 (after clamping) — the CSS-transform transient uses this too. */
  ratio: number;
}

/// zoomAt — cursor-anchored zoom. Returns the new (clamped) zoom AND the scroll offset that keeps the
/// document point under the cursor pinned in place. The scroll is returned RAW (may be negative near the
/// content origin); the caller assigns it to `element.scrollLeft`, which the browser clamps to [0, max].
/// The clamp on zoom feeds straight into `ratio`, so the fixed point still holds exactly when zoom saturates
/// at 25%/400% (only the magnitude of the change is limited, never the anchor).
export function zoomAt(i: ZoomAtInput): ZoomAtResult {
  const min = i.min ?? ZOOM_MIN;
  const max = i.max ?? ZOOM_MAX;
  const z0 = i.zoom > 0 ? i.zoom : min;
  const z1 = clampZoom(z0 * i.factor, min, max);
  const ratio = z1 / z0;
  return {
    zoom: z1,
    scrollLeft: (i.scrollLeft + i.pointerX) * ratio - i.pointerX,
    scrollTop: (i.scrollTop + i.pointerY) * ratio - i.pointerY,
    ratio,
  };
}

/** The on-screen X of the document point that was under the cursor, AFTER a zoomAt result is applied.
 *  Equal to `pointerX` when the fixed point holds (used by the unit test to assert < 1px error). */
export function fixedPointScreenX(before: Pick<ZoomAtInput, "scrollLeft" | "pointerX">, res: ZoomAtResult): number {
  const contentCoord = before.scrollLeft + before.pointerX; // C in z0 px
  return contentCoord * res.ratio - res.scrollLeft; // screen offset of C after zoom
}

/** Twin of {@link fixedPointScreenX} for the vertical axis. */
export function fixedPointScreenY(before: Pick<ZoomAtInput, "scrollTop" | "pointerY">, res: ZoomAtResult): number {
  const contentCoord = before.scrollTop + before.pointerY;
  return contentCoord * res.ratio - res.scrollTop;
}

export interface ScrollOffset {
  scrollLeft: number;
  scrollTop: number;
}

/// panBy — grab-hand pan. Dragging the CONTENT by (dx,dy) moves the viewport the opposite way, so the
/// document tracks the finger (Figma/Space-drag semantics). The caller assigns the result to the scroll
/// container; negatives are clamped to 0 by the browser at the edges.
export function panBy(scroll: ScrollOffset, dx: number, dy: number): ScrollOffset {
  return { scrollLeft: scroll.scrollLeft - dx, scrollTop: scroll.scrollTop - dy };
}

/// wheelToZoomFactor — a smooth, always-positive multiplicative factor from a wheel/pinch `deltaY`. macOS
/// trackpad pinch arrives as a ctrlKey wheel: pinch-open → deltaY<0 → factor>1 (zoom in); pinch-close →
/// deltaY>0 → factor<1 (zoom out). ⌘/Ctrl + wheel-up (deltaY<0) zooms in likewise. `exp` keeps the factor
/// strictly positive and makes successive ticks compose multiplicatively (constant felt sensitivity).
export function wheelToZoomFactor(deltaY: number, sensitivity: number = 0.0015): number {
  if (!Number.isFinite(deltaY)) return 1;
  return Math.exp(-deltaY * sensitivity);
}

/// isEditableTarget — whether a keydown target is a TEXT-entry surface that Space must never be stolen from
/// (in-place cell editor / chat composer / format-size input / contentEditable). Non-text inputs
/// (button/checkbox/file/color/range…) do NOT block panning — Space over them yields a pan, which is the
/// Figma behaviour. Pure enough to unit-test with a jsdom element.
export function isEditableTarget(el: Element | null | undefined): boolean {
  if (!el) return false;
  // 059 EXCEPTION — the caret-tracking hidden IME textarea (ImeCompositionLayer) is a CAPTURE surface,
  // not a user text field: while it holds focus the window keydown ecosystem (035 zoom/Space · 036
  // cell-nav · 053 typing · ⌘F) must keep owning the keys exactly as it did when nothing was focused, so
  // a live caret still types/navigates. Only the IME's own composition events (handled on the textarea)
  // route through it. Marked with `data-hw-ime-input`; anything else here is a real editable surface.
  if (el.getAttribute?.("data-hw-ime-input") === "1") return false;
  const he = el as HTMLElement;
  if (he.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    const type = ((el as HTMLInputElement).type || "text").toLowerCase();
    // Only the typeable input kinds block the pan; the rest (button-like / picker) let Space pass through.
    const nonText = ["button", "submit", "reset", "checkbox", "radio", "file", "range", "color", "image"];
    return !nonText.includes(type);
  }
  return false;
}
