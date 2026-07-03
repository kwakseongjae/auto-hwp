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
