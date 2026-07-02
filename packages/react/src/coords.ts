/// Pure coordinate-map helpers — copied from crates/hwp-viewer/ui/src/caret.ts (the DOM-free subset
/// the components need) so the package owns the SVG viewBox ↔ client-px conversion in ONE place
/// (common contract §4.1-5: the COMPONENT does the coordinate math, not the adapter — hit-test args
/// are page-local px).
///
/// COORDINATE SPACES
///  - PAGE units: the injected <svg>'s viewBox space (own-render px page units). The adapter's
///    hitTest/tableAt take page-local (x,y) in THIS space; boxes come back in it too.
///  - CLIENT px: on-screen pixels relative to the page's <svg> box (getBoundingClientRect()), folding
///    in scroll and the current zoom scale.
/// The two scale by the live rect/viewBox ratio, so overlays and hit-tests track zoom exactly.

/** A rectangle's on-screen geometry — only the fields the math needs. */
export type RectLike = { left: number; top: number; width: number; height: number };
/** A viewBox's page-unit dimensions. */
export type VbLike = { width: number; height: number };
/** An on-screen box in CSS px relative to the page's <svg>. */
export type ScreenBox = { left: number; top: number; width: number; height: number };

/** Forward map: an on-screen click (clientX/clientY) → PAGE-unit (x,y) to feed adapter.hitTest /
 *  adapter.tableAt. Returns null when the page isn't laid out yet (any zero dimension → guard). */
export function screenToPage(
  clientX: number,
  clientY: number,
  rect: RectLike,
  vb: VbLike,
): { x: number; y: number } | null {
  if (rect.width === 0 || rect.height === 0 || vb.width === 0 || vb.height === 0) return null;
  return {
    x: ((clientX - rect.left) / rect.width) * vb.width,
    y: ((clientY - rect.top) / rect.height) * vb.height,
  };
}

/** A box in PAGE units (own-render px). */
export type PageBox = { x: number; y: number; w: number; h: number };

/** Map a PAGE-unit box → CSS-px {left,top,width,height} relative to the page's <svg> box — the
 *  inverse-scale the SelectionOverlay uses (same rect/viewBox ratio as the forward map, so the mark
 *  tracks the SVG zoom exactly). Returns null on any zero dimension (page not laid out). */
export function pageBoxToScreen(box: PageBox, rect: { width: number; height: number }, vb: VbLike): ScreenBox | null {
  if (rect.width === 0 || rect.height === 0 || vb.width === 0 || vb.height === 0) return null;
  const sx = rect.width / vb.width;
  const sy = rect.height / vb.height;
  return { left: box.x * sx, top: box.y * sy, width: box.w * sx, height: box.h * sy };
}

/** Read the page-unit viewBox off a live <svg>, falling back to its width/height attrs (own-render
 *  SVGs carry an explicit viewBox; the fallback keeps a hand-rolled SVG working in the demo). */
export function readViewBox(svg: SVGSVGElement): VbLike {
  const vb = svg.viewBox && svg.viewBox.baseVal;
  if (vb && vb.width > 0 && vb.height > 0) return { width: vb.width, height: vb.height };
  return {
    width: parseFloat(svg.getAttribute("width") || "") || svg.clientWidth || 0,
    height: parseFloat(svg.getAttribute("height") || "") || svg.clientHeight || 0,
  };
}
