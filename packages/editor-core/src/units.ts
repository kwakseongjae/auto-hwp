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

/** HWPUNIT per millimetre (= 7200 / 25.4). Because 1 inch = 7200 HWPUNIT = 25.4 mm. The image-insert
 *  size (`InsertImage.width/height`, INTENT-SCHEMA §6.5) is HWPUNIT; the drop/upload flow sizes the image
 *  in mm (display width) then converts here — the SINGLE px/mm→HWPUNIT point (§4.5, issue 050). */
export const HWPUNIT_PER_MM = 7200 / 25.4;

/** Millimetres → HWPUNIT, rounded to a whole unit (the `InsertImage` display box commit unit, §4.5). */
export function mmToHwpUnit(mm: number): number {
  return Math.round(mm * HWPUNIT_PER_MM);
}

/** Default on-page DISPLAY width (mm) for an inserted image — mirrors the desktop chat-attach default so
 *  the web drop/upload sizes an image the same way. Wide enough to read, and the height rides the image's
 *  natural aspect (issue 050). */
export const DEFAULT_IMAGE_WIDTH_MM = 120;

/** Compute an inserted image's display box in HWPUNIT (`InsertImage.width/height`) from its NATURAL pixel
 *  dimensions, preserving aspect ratio at `widthMm` (default `DEFAULT_IMAGE_WIDTH_MM`). This is the ONE
 *  px/mm→HWPUNIT conversion point for image insert (§4.5). A degenerate natural size (either dimension ≤ 0
 *  — e.g. an image that failed to decode its intrinsic size) falls back to a 4:3 box so the insert still
 *  lands at a sane size rather than 0×0. */
export function imageInsertSize(
  naturalW: number,
  naturalH: number,
  widthMm = DEFAULT_IMAGE_WIDTH_MM,
): { width: number; height: number } {
  const heightMm = naturalW > 0 && naturalH > 0 ? (widthMm * naturalH) / naturalW : (widthMm * 3) / 4;
  return { width: mmToHwpUnit(widthMm), height: mmToHwpUnit(heightMm) };
}

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

/** The mm width of column `col` (0-based) given the `cols + 1` PAGE-px boundary array (issue 047). Rounded
 *  to `digits` decimals so the 열너비 다이얼로그 shows an HONEST reading (거짓 정밀도 금지): it is derived
 *  from the ACTUAL live boundaries and never carries more precision than 0.1mm. Because the commit path is
 *  px→relative-ratios (the engine rescales to the drawn table width), a fresh re-query of the boundaries is
 *  the source of truth AFTER an apply — this readout reflects that geometry directly (적용-확인 표시).
 *  An out-of-range `col` yields 0. */
export function columnWidthMm(boundaries: number[], col: number, digits = 1): number {
  if (col < 0 || col + 1 >= boundaries.length) return 0;
  return roundMm(pxToMm(boundaries[col + 1] - boundaries[col]), digits);
}

/** Set column `col` (0-based) to `mm` millimetres by moving the boundary it shares with its RIGHT neighbour
 *  (or, for the LAST column, its LEFT boundary — stealing from the neighbour), clamped so neither the column
 *  nor the affected neighbour shrinks below `minPx` (issue 047 — mirrors the desktop `setColWidthMm`, in
 *  PAGE px here rather than fractional). Returns a NEW `cols + 1` PAGE-px boundary array — the source of the
 *  committed ratios via `boundariesToRatios`. A 1-column table (or an out-of-range `col`) returns the input
 *  unchanged (there is no neighbour to resize against — an honest no-op the apply-verify then reports). */
export function setColumnWidthMm(boundaries: number[], col: number, mm: number, minPx = 8): number[] {
  const cols = boundaries.length - 1;
  if (cols < 2 || col < 0 || col >= cols) return boundaries.slice();
  const targetPx = Math.max(minPx, mmToPx(Math.max(0, mm)));
  const next = boundaries.slice();
  if (col < cols - 1) {
    // Move the RIGHT boundary; clamp so neither this column nor the right neighbour collapses below minPx.
    const lo = boundaries[col] + minPx;
    const hi = boundaries[col + 2] - minPx;
    next[col + 1] = Math.max(lo, Math.min(hi, boundaries[col] + targetPx));
  } else {
    // Last column: move the LEFT boundary instead (steal from the left neighbour).
    const lo = boundaries[col - 1] + minPx;
    const hi = boundaries[col + 1] - minPx;
    next[col] = Math.max(lo, Math.min(hi, boundaries[col + 1] - targetPx));
  }
  return next;
}

/** 균등 분배 (issue 047): redistribute the columns in the inclusive index range `[c0 .. c1]` so each is
 *  EQUAL width, holding the two bounding boundaries (`boundaries[c0]` and `boundaries[c1 + 1]`) fixed — every
 *  OTHER column keeps its width. Returns a NEW `cols + 1` PAGE-px boundary array (mirrors the desktop
 *  `equalizeCols`, fractional there / PAGE px here). A degenerate range (`c0 >= c1`, or out of range) returns
 *  the input unchanged (equalizing one column is a no-op). */
export function equalizeColumns(boundaries: number[], c0: number, c1: number): number[] {
  const cols = boundaries.length - 1;
  if (c0 < 0 || c1 >= cols || c1 <= c0) return boundaries.slice();
  const lo = boundaries[c0];
  const hi = boundaries[c1 + 1];
  const n = c1 - c0 + 1;
  const next = boundaries.slice();
  for (let k = 0; k <= n; k++) next[c0 + k] = lo + ((hi - lo) * k) / n;
  return next;
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
