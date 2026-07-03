/// units.ts — the SINGLE conversion point for the editing UI's px ↔ mm ↔ column-ratio math (issue 027
/// §함정: "룰러/열너비의 px↔mm↔비율 변환을 UI에 흩뿌리지 마라 — core 유틸 한 곳"). Every ruler
/// (mm) and every column-resize (ratio) computation flows through here, so a unit slip can only ever be
/// wrong in ONE place, and node tests pin the arithmetic (no DOM).
///
/// SPACES
///  - own-render PAGE px = HWPUNIT / 75. Because 1 inch = 7200 HWPUNIT and 7200/75 = 96, a page px is
///    exactly a CSS px at 96 dpi. So mm ↔ px uses the 96 dpi / 25.4 factor (NOT an ad-hoc constant).
///  - mm — the unit `SetPageMargins` takes (INTENT-SCHEMA §6.6). The ruler shows + edits mm.
///  - column ratio — the RELATIVE integer widths `SetTableColWidths` takes (INTENT-SCHEMA §6.6): a
///    positive i32 per column, `len == 표의 열 수`. Only the ratio matters (the engine rescales to the
///    drawn table width), so we emit small coprime-ish integers derived from the px column widths.

/** CSS px per millimetre at 96 dpi (= 96 / 25.4). Page px == 96-dpi CSS px, so this is the ONE factor. */
export const PX_PER_MM = 96 / 25.4;

/** HWPUNIT per own-render PAGE px (= 7200 / 96 = 75). Mirrors hwp-session's `HWPUNIT_PER_PX`, so px→HWPUNIT
 *  for a `SetTableRowHeights` override (heights are HWPUNIT, INTENT-SCHEMA §6.6) is the ONE factor here. */
export const HWPUNIT_PER_PX = 7200 / 96;

/** Own-render PAGE px → millimetres. */
export function pxToMm(px: number): number {
  return px / PX_PER_MM;
}

/** Millimetres → own-render PAGE px. */
export function mmToPx(mm: number): number {
  return mm * PX_PER_MM;
}

/** Round a mm value to `digits` decimals (ruler display — avoids 20.0000001 noise). Default 1 dp. */
export function roundMm(mm: number, digits = 1): number {
  const f = 10 ** digits;
  return Math.round(mm * f) / f;
}

/** Adjacent differences of a `cols + 1` boundary array → the `cols` column widths (px). */
export function boundariesToWidths(boundaries: number[]): number[] {
  const w: number[] = [];
  for (let i = 1; i < boundaries.length; i++) w.push(boundaries[i] - boundaries[i - 1]);
  return w;
}

/** Column pixel widths → the RELATIVE integer ratios `SetTableColWidths` wants (INTENT-SCHEMA §6.6):
 *  positive i32s whose PROPORTIONS match the widths. We scale so the widths sum to ~1000 then round,
 *  clamping every column to ≥ 1 (a zero-width column is illegal). Idempotent up to proportion. */
export function widthsToRatios(widths: number[]): number[] {
  const total = widths.reduce((a, b) => a + Math.max(0, b), 0);
  if (total <= 0) return widths.map(() => 1); // degenerate → equal ratios
  return widths.map((w) => Math.max(1, Math.round((Math.max(0, w) / total) * 1000)));
}

/** Convenience: boundaries → column ratios (the value `setColumnWidths` applies). */
export function boundariesToRatios(boundaries: number[]): number[] {
  return widthsToRatios(boundariesToWidths(boundaries));
}

/** A `rows + 1` row-boundary y array (own-render px) → the `rows` per-row minimum-height OVERRIDE in
 *  HWPUNIT the `SetTableRowHeights` op takes (INTENT-SCHEMA §6.6). Adjacent differences × HWPUNIT_PER_PX,
 *  rounded to non-negative integers. This is the WHOLE-table variant (pass the full boundary set); a
 *  SPLIT table (per-page fragment) uses `remapFragmentHeights` so rows outside the fragment stay 0. */
export function boundariesToHeights(boundaries: number[]): number[] {
  return boundariesToWidths(boundaries).map((h) => Math.max(0, Math.round(h * HWPUNIT_PER_PX)));
}

/** Remap a SPLIT-table FRAGMENT's row-boundary y array (page-LOCAL px, `fragRows + 1` entries) to a
 *  WHOLE-table `heights` vector (length `totalRows`, HWPUNIT) for `SetTableRowHeights`. The fragment's
 *  rows — GLOBAL indices `[firstRow .. firstRow + fragRows)` (023: row indices are global, boundaries are
 *  page-local) — get their dragged min-heights; EVERY row OUTSIDE the fragment is `0` (= content-sized,
 *  INTENT-SCHEMA), so it is left untouched. For a single-fragment table (`firstRow == 0`,
 *  `totalRows == fragRows`) this equals `boundariesToHeights`. This is the v2 fix for issue 031: v1 sent
 *  the fragment-length heights straight through and the engine rejected it (len != 표의 행 수). */
export function remapFragmentHeights(fragmentBoundaries: number[], firstRow: number, totalRows: number): number[] {
  const frag = boundariesToHeights(fragmentBoundaries);
  const out = new Array<number>(Math.max(0, totalRows)).fill(0);
  for (let i = 0; i < frag.length && firstRow + i < totalRows; i++) out[firstRow + i] = frag[i];
  return out;
}

/** APPLY-VERIFY predicate (issue 031 §거짓 성공 차단): after a resize commit, re-query the boundaries and
 *  ask "did the dragged boundary actually MOVE from `before`, in the direction the drag `intended`, by at
 *  least `frac` of the intended delta?". We compare at the index of MAXIMUM intended movement (the dragged
 *  boundary) and measure MOVEMENT MAGNITUDE, NOT target proximity — when a row grows every LOWER boundary
 *  is dragged along with it, so a "did it land on the intended target" model FALSE-negatives (the landmine
 *  v1 stepped on). Returns `true` when there was no meaningful intended movement (nothing to verify), and
 *  `true` when the re-queried array changed LENGTH (the layout re-paginated — definitely not a no-op). */
export function appliedReflectsDrag(before: number[], intended: number[], applied: number[], frac = 0.5, epsilon = 0.5): boolean {
  if (before.length !== intended.length) return false; // programming error — mismatched preview
  if (applied.length !== before.length) return true; // re-paginated → the edit had an effect (not a no-op)
  let idx = -1;
  let best = 0;
  for (let i = 0; i < before.length; i++) {
    const d = Math.abs(intended[i] - before[i]);
    if (d > best) {
      best = d;
      idx = i;
    }
  }
  if (idx < 0 || best < epsilon) return true; // no real drag → nothing to verify
  const intendedDelta = intended[idx] - before[idx];
  const appliedDelta = applied[idx] - before[idx];
  return Math.sign(appliedDelta) === Math.sign(intendedDelta) && Math.abs(appliedDelta) >= frac * Math.abs(intendedDelta);
}

/** Move the INTERIOR boundary `i` (1 … len-2 — the two outer edges are the fixed table extents) to
 *  `newX` px, clamped so neither the column to its left nor to its right shrinks below `minPx`. Returns
 *  a NEW boundary array (the drag preview + the source of the committed ratios). An out-of-range `i`
 *  (an endpoint or beyond) returns the input unchanged — endpoints never move (they ARE the table box). */
export function resizeBoundary(boundaries: number[], i: number, newX: number, minPx = 8): number[] {
  if (i <= 0 || i >= boundaries.length - 1) return boundaries.slice();
  const lo = boundaries[i - 1] + minPx;
  const hi = boundaries[i + 1] - minPx;
  const clamped = Math.max(lo, Math.min(hi, newX));
  const next = boundaries.slice();
  next[i] = clamped;
  return next;
}
