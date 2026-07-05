/// Pure helpers for the document outline panel + status-bar page tracking (issue 046). DOM-free so they
/// unit-test in isolation (like viewport.ts / floatingPosition.ts) and the component stays a thin binding.

/** The index of the outline item that CONTAINS `currentPage` — the LAST item whose start page is at or
 *  before `currentPage` (items are in document order, page-ascending). Returns 0 when the list is empty or
 *  every item starts AFTER `currentPage` (the first item is the closest approximation). Drives the panel's
 *  current-position highlight; the input page number comes from {@link pageAtReference} (a scroll-position
 *  calc), so the highlight is INDEPENDENT of the 037 virtualization visible set (issue 046 §함정). */
export function activeOutlineIndex(items: readonly { page: number }[], currentPage: number): number {
  let active = 0;
  for (let i = 0; i < items.length; i++) {
    if (items[i].page <= currentPage) active = i;
    else break; // page-ascending → the first item past currentPage ends the search
  }
  return active;
}

/** Which page is at the top of the viewport, computed from each page-wrapper's `top` offset relative to a
 *  fixed `reference` line near the viewport top. The current page = the LAST wrapper whose top is at/above
 *  the reference line (wrappers passed in document order, top-ascending). This is a SCROLL-POSITION calc
 *  over the page wrappers' own geometry — it deliberately does NOT read the 037 IntersectionObserver
 *  visible set (issue 046 §함정): every page (a real SVG sheet OR a virtualization placeholder) has an
 *  exact-height wrapper, so the answer is correct even while pages are virtualized. Returns the wrapper's
 *  own `page` value (not its array index), so a non-contiguous / reordered list still maps correctly. */
export function pageAtReference(wraps: readonly { page: number; top: number }[], reference: number): number {
  if (wraps.length === 0) return 0;
  let current = wraps[0].page;
  for (const w of wraps) {
    if (w.top <= reference) current = w.page;
    else break;
  }
  return current;
}
