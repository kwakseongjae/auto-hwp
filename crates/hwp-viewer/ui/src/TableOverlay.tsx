import { useCallback, useEffect, useRef, useState } from "react";

/// The drag-to-move + quick-edit overlay drawn over a selected table's placed OUTER box (own-render
/// only). The table twin of `ImageOverlay`, but a table is MOVED (not resized): press the body and
/// drag vertically to relocate the table to a new position in the document.
///
/// DIRECT MANIPULATION: a live drag updates ONLY this overlay's local geometry (a CSS box, no
/// re-layout / no repaint) for a smooth gesture; on pointerup it commits ONE undoable op (`MoveBlock`
/// via `onCommitMove`, the parent decides the target block from the drag sign) and the parent
/// repaints from the engine. A floating toolbar surfaces the light table verbs (행 추가 / 행 삭제 /
/// 표 삭제), each ONE undoable op through the existing table ops. The box is positioned in CSS px
/// (already scaled from page units by the caller, so it tracks the SVG zoom); move reports the px delta.

/** Screen-px box relative to the page's `.page-svg` wrapper. */
export type ScreenBox = { left: number; top: number; width: number; height: number };

type Props = {
  /** The table's outer box in CSS px relative to the page wrapper (already zoom-scaled by the caller). */
  box: ScreenBox;
  /** Fractional column boundaries (0..1 across the table width), length = cols + 1. Inner boundaries
   *  (1..cols-1) get a draggable divider handle; empty = no handles (geometry not loaded yet). */
  colFracs: number[];
  /** Commit a column resize: the new fractional boundaries (same shape as `colFracs`). */
  onCommitColWidths: (fracs: number[]) => void;
  /** Fractional row boundaries (0..1 down the table height), length = rows + 1. Inner boundaries
   *  (1..rows-1) get a draggable horizontal divider; empty = no handles (geometry not loaded yet). */
  rowFracs?: number[];
  /** Commit a row resize: the new fractional boundaries (same shape as `rowFracs`). */
  onCommitRowHeights?: (fracs: number[]) => void;
  /** Commit a move: the DROP point in client (screen) px. The parent resolves which block that point
   *  lands on (own_hit_test) and relocates the table THERE — so it drops where you point, not a ±1
   *  nudge. A drop that didn't move beyond jitter never fires this (a select doesn't relocate). */
  onCommitMove: (dropClientX: number, dropClientY: number) => void;
  /** Append one empty body row to the table (행 추가). */
  onAddRow: () => void;
  /** Edit a cell — opens the cell editor (칸 편집). */
  onEditCell: () => void;
  /** Delete the whole table block (표 삭제). */
  onDeleteTable: () => void;
  /** Apply/clear a background color (배경색) to the active cell's row/col/cell or the whole table. */
  onShade: (sel: "row" | "col" | "cell" | "all", color: string | null) => void;
  /** The single-clicked reference cell (0-based row/col) the shade applies to — null = none clicked. */
  activeCell?: { row: number; col: number } | null;
  /** The table's logical row/column counts — for clamping the drag-selected cell range. */
  rows: number;
  cols: number;
  /** The table's real width/height in millimetres — for the numeric (mm) width/height readout+entry. */
  tableWidthMm: number;
  tableHeightMm: number;
  /** The committed multi-cell range on THIS table (inclusive, normalized), or null. Drives the
   *  persistent highlight + the batch toolbar; the live drag is tracked locally. */
  range: { r0: number; c0: number; r1: number; c1: number } | null;
  /** Commit/clear the dragged cell range (normalized inclusive bounds, or null to clear). */
  onRangeChange: (bounds: { r0: number; c0: number; r1: number; c1: number } | null) => void;
  /** A plain CLICK (no drag) on a cell — select THAT cell as the active cell (the overlay otherwise
   *  swallows clicks, so clicking a different cell couldn't move the selection). Client px. */
  onCellPick: (clientX: number, clientY: number) => void;
  /** Batch character/alignment format for the current range (볼드/이태릭/크기/글꼴/글자색/정렬). */
  onRangeFmt: (fmt: { bold?: boolean; italic?: boolean; sizePt?: number; font?: string; color?: string; align?: string }) => void;
  /** Batch background for the current range — "#RRGGBB" or null to clear. */
  onRangeShade: (color: string | null) => void;
  /** Snapshot the current range as a chat anchor chip (issue #009) + open the chat. Optional. */
  onSendRangeToChat?: () => void;
  /** When false (e.g. the cell-editor modal is open), Delete/Backspace is ignored so we don't delete
   *  the table behind a modal. Defaults to deletable. */
  deletable?: boolean;
  /** Live drag feedback: the current pointer (client px) while dragging, so the parent can show a
   *  "drops here" insertion line at the resolved target block. Cleared via `onMoveEnd`. */
  onMovePoint?: (clientX: number, clientY: number) => void;
  /** The drag ended (drop or cancel) — clear any drop indicator. */
  onMoveEnd?: () => void;
  /** Deselect (Escape / click-away handled by the parent; this is the overlay's own dismiss). */
  onDismiss: () => void;
};

/** Minimum drag distance (px) before a press is treated as a MOVE (vs. a click that just selected). */
const MIN_DRAG_PX = 16;

/** A live drag in progress: the pointer-down screen coords + the box at the gesture start. */
type Drag = { startX: number; startY: number; start: ScreenBox; moved: boolean };

export default function TableOverlay({
  box,
  colFracs,
  onCommitColWidths,
  rowFracs = [],
  onCommitRowHeights,
  onCommitMove,
  onAddRow,
  onEditCell,
  onDeleteTable,
  onShade,
  activeCell = null,
  rows,
  cols,
  tableWidthMm,
  tableHeightMm,
  range,
  onRangeChange,
  onCellPick,
  onRangeFmt,
  onRangeShade,
  onSendRangeToChat,
  deletable = true,
  onMovePoint,
  onMoveEnd,
  onDismiss,
}: Props) {
  // 배경색 palette popover (toggled by the toolbar button) + the chosen apply SCOPE.
  const [shadeOpen, setShadeOpen] = useState(false);
  const [shadeScope, setShadeScope] = useState<"cell" | "row" | "col">("cell");
  const SWATCHES = ["#D8D8D8", "#CCCCCC", "#EEEEEE", "#E3F2FD", "#E8F5E9", "#FFF9C4", "#FCE4EC"];
  // `live` is the box the overlay RENDERS while dragging (local-only, no parent repaint); null = idle.
  // Reset whenever the committed box changes (a repaint re-places it from the fresh bbox).
  const [live, setLive] = useState<ScreenBox | null>(null);
  const drag = useRef<Drag | null>(null);
  useEffect(() => setLive(null), [box.left, box.top, box.width, box.height]);

  const onPointerMove = useCallback((e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (Math.abs(dy) > MIN_DRAG_PX || Math.abs(dx) > MIN_DRAG_PX) d.moved = true;
    // Only the vertical translation matters (the table keeps its width); show it dragging up/down.
    setLive({ ...d.start, top: d.start.top + dy });
    if (d.moved) onMovePoint?.(e.clientX, e.clientY); // live "drops here" feedback
  }, [onMovePoint]);

  const onPointerUp = useCallback((e: PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    if (!d) return;
    setLive(null); // the parent repaint will re-place the overlay from the fresh bbox
    onMoveEnd?.(); // clear the drop indicator
    const dyPx = e.clientY - d.startY;
    const dxPx = e.clientX - d.startX;
    // Ignore a trivial jitter (a click that didn't really drag) so a select doesn't relocate; otherwise
    // hand the parent the DROP point so it can relocate the table to whatever block lands there.
    if (d.moved && (Math.abs(dyPx) > MIN_DRAG_PX || Math.abs(dxPx) > MIN_DRAG_PX)) onCommitMove(e.clientX, e.clientY);
  }, [onPointerMove, onCommitMove, onMoveEnd]);

  const startDrag = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    drag.current = { startX: e.clientX, startY: e.clientY, start: live ?? box, moved: false };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  }, [box, live, onPointerMove, onPointerUp]);

  // Clean up any straggling window listeners if the overlay unmounts mid-drag.
  useEffect(() => () => {
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
  }, [onPointerMove, onPointerUp]);

  // Escape dismisses the selection; Delete/Backspace removes the whole table (normal doc-app gesture).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Ignore when typing in a field (cell editor / chat) so we don't eat their Backspace.
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.key === "Escape") onDismiss();
      else if (deletable && (e.key === "Delete" || e.key === "Backspace")) { e.preventDefault(); onDeleteTable(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDismiss, onDeleteTable, deletable]);

  // A toolbar button: stop the press from starting a move-drag, run the verb on click.
  const verb = (run: () => void) => ({
    onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
    onClick: (e: React.MouseEvent) => {
      e.stopPropagation();
      run();
    },
  });

  // ---- Column resize: drag an inner column divider. `liveFracs` is the in-drag fractional boundary set
  // (local-only); on pointerup it commits. Each handle stops propagation so it never starts the table
  // MOVE drag. A boundary is clamped between its neighbors with a small minimum column width. ----
  const MIN_FRAC = 0.04;
  const [liveFracs, setLiveFracs] = useState<number[] | null>(null);
  const colDrag = useRef<{ i: number; startX: number; startFracs: number[]; latest: number[] } | null>(null);
  useEffect(() => setLiveFracs(null), [box.left, box.top, box.width, box.height]);
  const onColMove = useCallback((e: PointerEvent) => {
    const d = colDrag.current;
    if (!d) return;
    const delta = (e.clientX - d.startX) / Math.max(1, box.width);
    const lo = d.startFracs[d.i - 1] + MIN_FRAC;
    const hi = d.startFracs[d.i + 1] - MIN_FRAC;
    if (hi <= lo) return; // flanking columns too narrow to resize without inverting — ignore the drag
    const nf = Math.min(hi, Math.max(lo, d.startFracs[d.i] + delta));
    const next = [...d.startFracs];
    next[d.i] = nf;
    d.latest = next;
    setLiveFracs(next);
  }, [box.width]);
  const onColUp = useCallback(() => {
    const d = colDrag.current;
    colDrag.current = null;
    window.removeEventListener("pointermove", onColMove);
    window.removeEventListener("pointerup", onColUp);
    setLiveFracs(null);
    if (d && d.latest.some((v, i) => Math.abs(v - d.startFracs[i]) > 1e-4)) onCommitColWidths(d.latest);
  }, [onColMove, onCommitColWidths]);
  const startColDrag = useCallback((i: number) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation(); // never trigger the table MOVE drag
    const base = liveFracs ?? colFracs;
    colDrag.current = { i, startX: e.clientX, startFracs: base, latest: base };
    window.addEventListener("pointermove", onColMove);
    window.addEventListener("pointerup", onColUp);
  }, [colFracs, liveFracs, onColMove, onColUp]);
  useEffect(() => () => {
    window.removeEventListener("pointermove", onColMove);
    window.removeEventListener("pointerup", onColUp);
  }, [onColMove, onColUp]);

  // ---- Row resize: drag an inner row divider VERTICALLY. The exact twin of the column logic, but on
  // the Y axis (fraction of the box HEIGHT). Dragging the boundary below row 0 sets the header-row
  // height. Commits SetTableRowHeights on pointerup. ----
  const MIN_ROW_FRAC = 0.03;
  const [liveRowFracs, setLiveRowFracs] = useState<number[] | null>(null);
  const rowDrag = useRef<{ i: number; startY: number; startFracs: number[]; latest: number[] } | null>(null);
  useEffect(() => setLiveRowFracs(null), [box.left, box.top, box.width, box.height]);
  const onRowMove = useCallback((e: PointerEvent) => {
    const d = rowDrag.current;
    if (!d) return;
    const delta = (e.clientY - d.startY) / Math.max(1, box.height);
    const lo = d.startFracs[d.i - 1] + MIN_ROW_FRAC;
    const hi = d.startFracs[d.i + 1] - MIN_ROW_FRAC;
    if (hi <= lo) return; // flanking rows too short to resize without inverting — ignore
    const nf = Math.min(hi, Math.max(lo, d.startFracs[d.i] + delta));
    const next = [...d.startFracs];
    next[d.i] = nf;
    d.latest = next;
    setLiveRowFracs(next);
  }, [box.height]);
  const onRowUp = useCallback(() => {
    const d = rowDrag.current;
    rowDrag.current = null;
    window.removeEventListener("pointermove", onRowMove);
    window.removeEventListener("pointerup", onRowUp);
    setLiveRowFracs(null);
    if (d && d.latest.some((v, i) => Math.abs(v - d.startFracs[i]) > 1e-4)) onCommitRowHeights?.(d.latest);
  }, [onRowMove, onCommitRowHeights]);
  const startRowDrag = useCallback((i: number) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation(); // never trigger the table MOVE drag
    const base = liveRowFracs ?? rowFracs;
    rowDrag.current = { i, startY: e.clientY, startFracs: base, latest: base };
    window.addEventListener("pointermove", onRowMove);
    window.addEventListener("pointerup", onRowUp);
  }, [rowFracs, liveRowFracs, onRowMove, onRowUp]);
  useEffect(() => () => {
    window.removeEventListener("pointermove", onRowMove);
    window.removeEventListener("pointerup", onRowUp);
  }, [onRowMove, onRowUp]);

  // ---- Multi-cell RANGE select: drag across the table body to select a rectangular block of cells
  // (한컴식 표 블록 선택). The logical (row,col) under a pointer is resolved LOCALLY from the fractional
  // col/row boundaries (no IPC per move), so dragging is smooth. On pointerup a >1-cell range commits to
  // the parent (which restyles it via batch ops); a no-drag click clears any range. The MOVE gesture is
  // moved to the grab pill so a plain body drag is unambiguously a SELECTION. ----
  const [liveRange, setLiveRange] = useState<{ r0: number; c0: number; r1: number; c1: number } | null>(null);
  const rangeDrag = useRef<{ ar: number; ac: number; moved: boolean } | null>(null);
  // The col/row band index a fraction (0..1 across/down the box) falls into, clamped to the grid.
  const bandAt = useCallback((frac: number, bounds: number[], n: number): number => {
    if (bounds.length < 2 || n <= 0) return 0;
    let i = 0;
    while (i + 1 < bounds.length && bounds[i + 1] <= frac) i += 1;
    return Math.min(Math.max(i, 0), n - 1);
  }, []);
  const cellAtClient = useCallback((clientX: number, clientY: number): { row: number; col: number } | null => {
    const cf = liveFracs ?? colFracs;
    const rf = liveRowFracs ?? rowFracs;
    if (cf.length < 2 || rf.length < 2) return null;
    const r0box = live ?? box;
    const fx = (clientX - rangeBoxLeftRef.current) / Math.max(1, r0box.width);
    const fy = (clientY - rangeBoxTopRef.current) / Math.max(1, r0box.height);
    // Derive the grid size from the BOUNDARY arrays (cf/rf), NOT the `cols`/`rows` props — those come
    // from the placed OUTER table and can disagree (a 1×1 frame wrapper around the 자가진단표 reports
    // cols=rows=1 while the boundaries describe the real inner grid the batch op actually addresses).
    return { col: bandAt(fx, cf, cf.length - 1), row: bandAt(fy, rf, rf.length - 1) };
  }, [bandAt, colFracs, rowFracs, liveFracs, liveRowFracs, live, box]);
  // The overlay box's client-space top-left, captured at drag start (so move math needs no getBoundingRect per move).
  const rangeBoxLeftRef = useRef(0);
  const rangeBoxTopRef = useRef(0);
  const onRangeMove = useCallback((e: PointerEvent) => {
    const d = rangeDrag.current;
    if (!d) return;
    const cur = cellAtClient(e.clientX, e.clientY);
    if (!cur) return;
    if (cur.row !== d.ar || cur.col !== d.ac) d.moved = true;
    setLiveRange({
      r0: Math.min(d.ar, cur.row), c0: Math.min(d.ac, cur.col),
      r1: Math.max(d.ar, cur.row), c1: Math.max(d.ac, cur.col),
    });
  }, [cellAtClient]);
  const onRangeUp = useCallback((e: PointerEvent) => {
    const d = rangeDrag.current;
    rangeDrag.current = null;
    window.removeEventListener("pointermove", onRangeMove);
    window.removeEventListener("pointerup", onRangeUp);
    const wasClick = !!d && !d.moved;
    const cx = e.clientX, cy = e.clientY;
    setLiveRange((lr) => {
      // A real multi-cell drag commits the range; a plain click (no move) clears any existing range.
      if (d && d.moved && lr && (lr.r0 !== lr.r1 || lr.c0 !== lr.c1)) onRangeChange(lr);
      else onRangeChange(null);
      return null;
    });
    // A plain click selects THAT cell (so clicking a different cell moves the active selection — the
    // overlay swallows the click so onPageClick can't do it).
    if (wasClick) onCellPick(cx, cy);
  }, [onRangeMove, onRangeChange, onCellPick]);
  const startRangeDrag = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const cf = liveFracs ?? colFracs;
    const rf = liveRowFracs ?? rowFracs;
    // Just need the grid boundaries (load shortly after selection). SPLIT tables (incl. the frame-wrapped
    // 자가진단표, which spans pages) now work too: the bands here are FRAGMENT-local, and the parent adds
    // the fragment's `first_row` offset before the batch op so global rows are targeted correctly.
    if (cf.length < 2 || rf.length < 2) return;
    e.preventDefault();
    e.stopPropagation();
    const box0 = (e.currentTarget as HTMLElement).getBoundingClientRect();
    rangeBoxLeftRef.current = box0.left;
    rangeBoxTopRef.current = box0.top;
    const start = cellAtClient(e.clientX, e.clientY);
    if (!start) return;
    rangeDrag.current = { ar: start.row, ac: start.col, moved: false };
    setLiveRange({ r0: start.row, c0: start.col, r1: start.row, c1: start.col });
    window.addEventListener("pointermove", onRangeMove);
    window.addEventListener("pointerup", onRangeUp);
  }, [colFracs, rowFracs, liveFracs, liveRowFracs, cellAtClient, onRangeMove, onRangeUp]);
  useEffect(() => () => {
    window.removeEventListener("pointermove", onRangeMove);
    window.removeEventListener("pointerup", onRangeUp);
  }, [onRangeMove, onRangeUp]);
  // The range to render (live drag wins); clear local live when the committed range is dropped externally.
  const shownRange = liveRange ?? range;
  const isMultiRange = !!shownRange && (shownRange.r0 !== shownRange.r1 || shownRange.c0 !== shownRange.c1);

  // Batch toolbar popovers (font / 글자색) for the selected range.
  const [rangeMenu, setRangeMenu] = useState<null | "font" | "color" | "bg" | "size">(null);
  const RANGE_FONTS = ["맑은 고딕", "바탕", "굴림", "돋움", "함초롬바탕", "함초롬돋움", "궁서"];
  const RANGE_COLORS = ["#000000", "#C00000", "#1F4E79", "#2E7D32", "#7030A0", "#BF9000", "#FFFFFF"];
  const RANGE_BG = ["#D8D8D8", "#CCCCCC", "#EEEEEE", "#E3F2FD", "#E8F5E9", "#FFF9C4", "#FCE4EC"];
  // Batch font size (pt) for the range — a local stepper applied to every selected cell on each change.
  const [rangeSizePt, setRangeSizePt] = useState(10);
  useEffect(() => { if (!isMultiRange) setRangeMenu(null); }, [isMultiRange]);

  // ---- Precise table sizing for the selection (진단 #3: complex-grid 열 너비 보조) ----
  // 균등 분배: redistribute the boundaries WITHIN the selected columns/rows so each is equal (others
  // hold) — reuses the existing SetTableColWidths / SetTableRowHeights commit (fractional boundaries).
  const equalizeCols = useCallback(() => {
    if (!shownRange) return;
    const cf = liveFracs ?? colFracs;
    if (cf.length !== cols + 1) return;
    const { c0, c1 } = shownRange;
    const lo = cf[c0], hi = cf[c1 + 1];
    const n = c1 - c0 + 1;
    const next = [...cf];
    for (let k = 0; k <= n; k++) next[c0 + k] = lo + ((hi - lo) * k) / n;
    onCommitColWidths(next);
  }, [shownRange, liveFracs, colFracs, cols, onCommitColWidths]);
  const equalizeRows = useCallback(() => {
    if (!shownRange || !onCommitRowHeights) return;
    const rf = liveRowFracs ?? rowFracs;
    if (rf.length !== rows + 1) return;
    const { r0, r1 } = shownRange;
    const lo = rf[r0], hi = rf[r1 + 1];
    const n = r1 - r0 + 1;
    const next = [...rf];
    for (let k = 0; k <= n; k++) next[r0 + k] = lo + ((hi - lo) * k) / n;
    onCommitRowHeights(next);
  }, [shownRange, liveRowFracs, rowFracs, rows, onCommitRowHeights]);
  // mm width/height of the (single-line) selection, and a setter that moves ONE boundary numerically
  // (stealing from the neighbour, clamped), mirroring a precise drag — no fiddly handle hunting.
  const singleCol = !!shownRange && shownRange.c0 === shownRange.c1;
  const singleRow = !!shownRange && shownRange.r0 === shownRange.r1;
  const colWidthMm = shownRange ? ((liveFracs ?? colFracs)[shownRange.c1 + 1] - (liveFracs ?? colFracs)[shownRange.c0]) * tableWidthMm : 0;
  const rowHeightMm = shownRange ? ((liveRowFracs ?? rowFracs)[shownRange.r1 + 1] - (liveRowFracs ?? rowFracs)[shownRange.r0]) * tableHeightMm : 0;
  const MIN_MM = 2;
  const setColWidthMm = useCallback((mm: number) => {
    if (!shownRange) return;
    const cf = liveFracs ?? colFracs;
    if (cf.length !== cols + 1 || tableWidthMm <= 0) return;
    const c = shownRange.c0;
    const target = Math.max(MIN_MM, mm) / tableWidthMm; // desired fractional width of this column
    const next = [...cf];
    if (c < cols - 1) {
      // move the RIGHT boundary; clamp so neither this nor the right neighbour collapses.
      next[c + 1] = Math.min(cf[c + 2] - MIN_FRAC, Math.max(cf[c] + MIN_FRAC, cf[c] + target));
    } else if (c > 0) {
      // last column: move the LEFT boundary instead (steal from the left neighbour).
      next[c] = Math.max(cf[c - 1] + MIN_FRAC, Math.min(cf[c + 1] - MIN_FRAC, cf[c + 1] - target));
    } else {
      return; // a 1-column table can't be resized against a neighbour
    }
    onCommitColWidths(next);
  }, [shownRange, liveFracs, colFracs, cols, tableWidthMm, onCommitColWidths]);
  const setRowHeightMm = useCallback((mm: number) => {
    if (!shownRange || !onCommitRowHeights) return;
    const rf = liveRowFracs ?? rowFracs;
    if (rf.length !== rows + 1 || tableHeightMm <= 0) return;
    const r = shownRange.r0;
    const target = Math.max(MIN_MM, mm) / tableHeightMm;
    const next = [...rf];
    if (r < rows - 1) next[r + 1] = Math.min(rf[r + 2] - MIN_ROW_FRAC, Math.max(rf[r] + MIN_ROW_FRAC, rf[r] + target));
    else if (r > 0) next[r] = Math.max(rf[r - 1] + MIN_ROW_FRAC, Math.min(rf[r + 1] - MIN_ROW_FRAC, rf[r + 1] - target));
    else return;
    onCommitRowHeights(next);
  }, [shownRange, liveRowFracs, rowFracs, rows, tableHeightMm, onCommitRowHeights]);

  const r = live ?? box;
  const fracs = liveFracs ?? colFracs;
  const rFracs = liveRowFracs ?? rowFracs;
  return (
    <div
      className="pointer-events-auto absolute z-20 ring-2 ring-accent"
      style={{ left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`, cursor: "cell" }}
      onPointerDown={startRangeDrag}
      role="presentation"
      title="드래그하여 여러 칸 선택 (서식 일괄 변경) · 표 이동은 좌측 상단 손잡이"
    >
      {/* A grab handle pill — DRAG IT to move the table (body drag selects a cell range). Anchored just
          LEFT of the table top (in the page's left margin) so it never overlaps a heading ABOVE the
          table (the old top-left-above placement covered the "□ 일반현황" / "Ⅰ.자가진단표" titles). */}
      <span
        className="absolute right-full top-0 mr-1 flex cursor-move items-center gap-1 rounded-md bg-accent px-1.5 py-0.5 text-[10px] font-medium text-white shadow-sm"
        onPointerDown={startDrag}
        title="드래그하여 표 위치 이동"
      >
        <span aria-hidden>⠿</span> 표
      </span>
      {/* Quick-edit toolbar — ABOVE the table, RIGHT-aligned to it. Right-aligned keeps it inside the page
          (a left-full/right-margin placement ran the wide toolbar off the page edge → clipped); a heading
          above a table is left-aligned, so the right side above the table is normally empty. */}
      <div
        className="absolute -top-7 right-0 flex items-center gap-1 rounded-md border border-black/10 bg-white px-1 py-0.5 text-[11px] shadow-md dark:border-white/10 dark:bg-neutral-800"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <button className="rounded px-1.5 py-0.5 hover:bg-accent/10 hover:text-accent" {...verb(onAddRow)}>
          + 행
        </button>
        <button className="rounded px-1.5 py-0.5 hover:bg-accent/10 hover:text-accent" {...verb(onEditCell)}>
          칸 편집
        </button>
        <button
          className={`rounded px-1.5 py-0.5 hover:bg-accent/10 hover:text-accent ${shadeOpen ? "bg-accent/10 text-accent" : ""}`}
          onPointerDown={(e) => e.stopPropagation()}
          // preventDefault on mousedown keeps focus where it is — so opening the palette WHILE a cell
          // is being inline-edited doesn't blur→commit→repaint the editor out from under the click
          // (that race is why 배경색 "안 열려" during edit).
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => { e.stopPropagation(); setShadeOpen((o) => !o); }}
        >
          🎨 배경색
        </button>
        <button className="rounded px-1.5 py-0.5 text-red-600 hover:bg-red-500/10 dark:text-red-400" {...verb(onDeleteTable)}>
          표 삭제
        </button>
      </div>
      {/* 배경색 palette — the reference is the FOCUSED cell (click or double-click-to-edit a cell).
          Shows that cell, then pick a SCOPE (이 칸만 / 행 / 열) + a swatch (or 지우기). z-50 so it sits
          ABOVE an open inline editor (z-40); preventDefault on the controls keeps the editor alive. */}
      {shadeOpen && (
        <div
          className="absolute -top-7 right-0 z-50 flex w-60 translate-y-[-100%] flex-col gap-2 rounded-lg border border-black/10 bg-white p-2.5 text-[11px] shadow-xl dark:border-white/10 dark:bg-neutral-800"
          onPointerDown={(e) => e.stopPropagation()}
        >
          {/* 1) which cell is the reference */}
          {activeCell ? (
            <div className="text-neutral-600 dark:text-neutral-300">
              기준 칸: <b className="text-neutral-900 dark:text-neutral-100">{activeCell.row + 1}행 {activeCell.col + 1}열</b>
            </div>
          ) : (
            <div className="rounded bg-amber-500/10 px-1.5 py-1 text-amber-700 dark:text-amber-400">표의 칸을 클릭(또는 더블클릭해 편집)하면 그 칸이 기준이 됩니다</div>
          )}
          {/* 2) apply scope — single choice, plain wording. 이 칸만 is the default (leftmost). */}
          <div className="flex gap-1">
            {([["cell", "이 칸만"], ["row", "가로 줄(행) 전체"], ["col", "세로 칸(열) 전체"]] as const).map(([s, label]) => (
              <button
                key={s}
                onMouseDown={(e) => e.preventDefault()}
                onClick={(e) => { e.stopPropagation(); setShadeScope(s); }}
                className={`flex-1 rounded px-1.5 py-1 leading-tight ${shadeScope === s ? "bg-accent text-white" : "bg-black/5 text-neutral-600 hover:bg-black/10 dark:bg-white/10 dark:text-neutral-300"}`}
              >{label}</button>
            ))}
          </div>
          {/* 3) pick a color (applies to the chosen scope) */}
          <div className="flex items-center gap-1">
            {SWATCHES.map((c) => (
              <button
                key={c}
                disabled={!activeCell}
                title={c}
                // preventDefault keeps the inline editor focused (no blur→commit→repaint) so the focused
                // cell survives the click; commitShade snapshots + commits any edit itself.
                onMouseDown={(e) => e.preventDefault()}
                onClick={(e) => { e.stopPropagation(); onShade(shadeScope, c); setShadeOpen(false); }}
                className="h-5 w-5 rounded-[3px] border border-black/20 hover:ring-2 hover:ring-accent disabled:cursor-not-allowed disabled:opacity-40"
                style={{ backgroundColor: c }}
              />
            ))}
            {/* 사용자 지정 — 연속 스펙트럼(OS 색상 선택기) */}
            <label className={`flex h-5 w-6 items-center justify-center rounded-[3px] border border-black/20 ${activeCell ? "cursor-pointer" : "cursor-not-allowed opacity-40"}`} title="사용자 지정 색" style={{ background: "conic-gradient(red,#ff0,lime,cyan,blue,magenta,red)" }} onMouseDown={(e) => e.preventDefault()}>
              <input type="color" disabled={!activeCell} className="sr-only" onChange={(e) => { onShade(shadeScope, e.target.value); setShadeOpen(false); }} />
            </label>
            <button
              disabled={!activeCell}
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => { e.stopPropagation(); onShade(shadeScope, null); setShadeOpen(false); }}
              title="색 지우기"
              className="ml-auto rounded border border-black/15 px-1.5 py-0.5 leading-none text-neutral-500 hover:bg-black/5 disabled:opacity-40 dark:border-white/15"
            >지우기</button>
          </div>
        </div>
      )}
      {/* Column-resize handles: a thin draggable divider on each INNER column boundary. Dragging one
          adjusts only that boundary (its neighbors hold); commit on pointerup → SetTableColWidths. */}
      {fracs.length > 2 && fracs.slice(1, -1).map((f, idx) => (
        <div
          key={`c${idx}`}
          onPointerDown={startColDrag(idx + 1)}
          title="드래그하여 열 너비 조정"
          className="group absolute top-0 z-10 flex h-full w-2.5 -translate-x-1/2 cursor-col-resize items-stretch justify-center"
          style={{ left: `${f * r.width}px` }}
        >
          {/* Faintly visible WHILE THE TABLE IS SELECTED (this overlay is only mounted when selected),
              so the resize affordance is discoverable; solid accent on hover. No persistent doc clutter
              because the divider exists only inside the selection overlay. */}
          <div className="w-0.5 bg-accent/30 group-hover:bg-accent" />
        </div>
      ))}
      {/* Row-resize handles: the horizontal twin — a draggable divider on each INNER row boundary.
          Drag the one below the header row to set its height. Commit → SetTableRowHeights. */}
      {onCommitRowHeights && rFracs.length > 2 && rFracs.slice(1, -1).map((f, idx) => (
        <div
          key={`r${idx}`}
          onPointerDown={startRowDrag(idx + 1)}
          title="드래그하여 행 높이 조정"
          className="group absolute left-0 z-10 flex w-full h-2.5 -translate-y-1/2 cursor-row-resize flex-col items-stretch justify-center"
          style={{ top: `${f * r.height}px` }}
        >
          <div className="h-0.5 bg-accent/30 group-hover:bg-accent" />
        </div>
      ))}
      {/* Multi-cell RANGE highlight + batch toolbar. The rectangle is computed from the fractional
          col/row boundaries; the toolbar floats above it and dispatches ONE batch op per action. */}
      {shownRange && fracs.length > shownRange.c1 + 1 && rFracs.length > shownRange.r1 + 1 && (() => {
        const cL = fracs[shownRange.c0] * r.width;
        const cR = fracs[shownRange.c1 + 1] * r.width;
        const rT = rFracs[shownRange.r0] * r.height;
        const rB = rFracs[shownRange.r1 + 1] * r.height;
        const nCells = (shownRange.r1 - shownRange.r0 + 1) * (shownRange.c1 - shownRange.c0 + 1);
        const stop = (e: React.PointerEvent) => e.stopPropagation();
        const keep = (e: React.MouseEvent) => e.preventDefault(); // don't blur / start a drag
        const fmtBtn = "rounded px-1.5 py-0.5 hover:bg-accent/10 hover:text-accent";
        return (
          <>
            {/* translucent selection rectangle */}
            <div
              className="pointer-events-none absolute z-[15] bg-accent/15 ring-2 ring-accent/70"
              style={{ left: `${cL}px`, top: `${rT}px`, width: `${Math.max(0, cR - cL)}px`, height: `${Math.max(0, rB - rT)}px` }}
            />
            {/* batch toolbar — only once the range spans >1 cell */}
            {isMultiRange && (
              <div
                className="absolute z-[60] flex items-center gap-0.5 rounded-md border border-black/10 bg-white px-1 py-0.5 text-[11px] shadow-lg dark:border-white/10 dark:bg-neutral-800"
                // Above the selection when there's room; otherwise just BELOW it (so it never covers the
                // row above the selection / sits clipped at the table top).
                style={{ left: `${cL}px`, top: rT >= 30 ? `${rT - 30}px` : `${rB + 4}px` }}
                onPointerDown={stop}
              >
                <span className="px-1 text-[10px] text-neutral-400">{nCells}칸</span>
                <button title="굵게" className={`${fmtBtn} font-bold`} onMouseDown={keep} onClick={() => onRangeFmt({ bold: true })}>가</button>
                <button title="굵게 해제" className={fmtBtn} onMouseDown={keep} onClick={() => onRangeFmt({ bold: false })}>가̶</button>
                <button title="기울임" className={`${fmtBtn} italic`} onMouseDown={keep} onClick={() => onRangeFmt({ italic: true })}>가</button>
                <span className="mx-0.5 h-4 w-px bg-black/10 dark:bg-white/10" />
                <button title="왼쪽 정렬" className={fmtBtn} onMouseDown={keep} onClick={() => onRangeFmt({ align: "left" })}>⇤</button>
                <button title="가운데 정렬" className={fmtBtn} onMouseDown={keep} onClick={() => onRangeFmt({ align: "center" })}>↔</button>
                <button title="오른쪽 정렬" className={fmtBtn} onMouseDown={keep} onClick={() => onRangeFmt({ align: "right" })}>⇥</button>
                <span className="mx-0.5 h-4 w-px bg-black/10 dark:bg-white/10" />
                {/* 글자 크기(pt) — −/+ 또는 직접 입력, 선택한 모든 칸에 적용 */}
                <button title="글자 작게" className={fmtBtn} onMouseDown={keep} onClick={() => { const v = Math.max(4, rangeSizePt - 1); setRangeSizePt(v); onRangeFmt({ sizePt: v }); }}>−</button>
                <input
                  title="글자 크기(pt) — 입력 후 Enter"
                  inputMode="numeric" value={String(rangeSizePt)}
                  onMouseDown={(e) => e.stopPropagation()}
                  onChange={(e) => setRangeSizePt(Math.min(96, Math.max(0, parseInt(e.target.value.replace(/[^0-9]/g, "") || "0", 10))))}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); if (rangeSizePt >= 4) onRangeFmt({ sizePt: rangeSizePt }); (e.currentTarget as HTMLInputElement).blur(); } }}
                  onBlur={() => { if (rangeSizePt >= 4) onRangeFmt({ sizePt: rangeSizePt }); }}
                  className="w-7 rounded bg-transparent text-center tabular-nums outline-none focus:bg-black/5 dark:focus:bg-white/10"
                />
                <button title="글자 크게" className={fmtBtn} onMouseDown={keep} onClick={() => { const v = Math.min(96, rangeSizePt + 1); setRangeSizePt(v); onRangeFmt({ sizePt: v }); }}>+</button>
                <span className="mx-0.5 h-4 w-px bg-black/10 dark:bg-white/10" />
                <button title="글꼴" className={`${fmtBtn} ${rangeMenu === "font" ? "bg-accent/10 text-accent" : ""}`} onMouseDown={keep} onClick={() => setRangeMenu((m) => (m === "font" ? null : "font"))}>글꼴 ▾</button>
                <button title="글자색" className={`${fmtBtn} ${rangeMenu === "color" ? "bg-accent/10 text-accent" : ""}`} onMouseDown={keep} onClick={() => setRangeMenu((m) => (m === "color" ? null : "color"))}>가<span className="ml-0.5 inline-block h-1 w-3 align-middle" style={{ backgroundColor: "#C00000" }} /></button>
                <button title="배경색" className={`${fmtBtn} ${rangeMenu === "bg" ? "bg-accent/10 text-accent" : ""}`} onMouseDown={keep} onClick={() => setRangeMenu((m) => (m === "bg" ? null : "bg"))}>🎨</button>
                <span className="mx-0.5 h-4 w-px bg-black/10 dark:bg-white/10" />
                <button title="크기 (열 너비 / 행 높이 · 균등 분배)" className={`${fmtBtn} ${rangeMenu === "size" ? "bg-accent/10 text-accent" : ""}`} onMouseDown={keep} onClick={() => setRangeMenu((m) => (m === "size" ? null : "size"))}>크기 ▾</button>
                {onSendRangeToChat && (
                  <>
                    <span className="mx-0.5 h-4 w-px bg-black/10 dark:bg-white/10" />
                    {/* 💬 채팅에 넣기 (issue #009): snapshot this range as an anchor chip + open the chat. */}
                    <button title="이 영역을 채팅 편집 대상으로 추가" className={`${fmtBtn} text-ai`} onMouseDown={keep} onClick={() => onSendRangeToChat()}>💬 채팅</button>
                  </>
                )}
                {/* popovers */}
                {rangeMenu === "font" && (
                  <div className="absolute left-0 top-full z-[61] mt-1 flex w-36 flex-col rounded-md border border-black/10 bg-white p-1 shadow-xl dark:border-white/10 dark:bg-neutral-800" onPointerDown={stop}>
                    {RANGE_FONTS.map((f) => (
                      <button key={f} onMouseDown={keep} onClick={() => { onRangeFmt({ font: f }); setRangeMenu(null); }} className="rounded px-2 py-1 text-left hover:bg-accent/10 hover:text-accent" style={{ fontFamily: f }}>{f}</button>
                    ))}
                  </div>
                )}
                {rangeMenu === "color" && (
                  <div className="absolute right-0 top-full z-[61] mt-1 flex items-center gap-1 rounded-md border border-black/10 bg-white p-1.5 shadow-xl dark:border-white/10 dark:bg-neutral-800" onPointerDown={stop}>
                    {RANGE_COLORS.map((c) => (
                      <button key={c} title={c} onMouseDown={keep} onClick={() => { onRangeFmt({ color: c }); setRangeMenu(null); }} className="h-5 w-5 rounded-[3px] border border-black/20 hover:ring-2 hover:ring-accent" style={{ backgroundColor: c }} />
                    ))}
                    {/* 사용자 지정 — 연속 스펙트럼(OS 색상 선택기). onInput으로 드래그 중 미리보기. */}
                    <label className="ml-1 flex h-5 w-6 cursor-pointer items-center justify-center rounded-[3px] border border-black/20 text-[9px] leading-none" title="사용자 지정 색" style={{ background: "conic-gradient(red,#ff0,lime,cyan,blue,magenta,red)" }} onMouseDown={keep}>
                      <input type="color" className="sr-only" onChange={(e) => { onRangeFmt({ color: e.target.value }); setRangeMenu(null); }} />
                    </label>
                  </div>
                )}
                {rangeMenu === "bg" && (
                  <div className="absolute right-0 top-full z-[61] mt-1 flex items-center gap-1 rounded-md border border-black/10 bg-white p-1.5 shadow-xl dark:border-white/10 dark:bg-neutral-800" onPointerDown={stop}>
                    {RANGE_BG.map((c) => (
                      <button key={c} title={c} onMouseDown={keep} onClick={() => { onRangeShade(c); setRangeMenu(null); }} className="h-5 w-5 rounded-[3px] border border-black/20 hover:ring-2 hover:ring-accent" style={{ backgroundColor: c }} />
                    ))}
                    <label className="ml-0.5 flex h-5 w-6 cursor-pointer items-center justify-center rounded-[3px] border border-black/20" title="사용자 지정 색" style={{ background: "conic-gradient(red,#ff0,lime,cyan,blue,magenta,red)" }} onMouseDown={keep}>
                      <input type="color" className="sr-only" onInput={(e) => onRangeShade((e.target as HTMLInputElement).value)} onChange={(e) => { onRangeShade(e.target.value); setRangeMenu(null); }} />
                    </label>
                    <button onMouseDown={keep} onClick={() => { onRangeShade(null); setRangeMenu(null); }} title="색 지우기" className="ml-1 rounded border border-black/15 px-1.5 py-0.5 leading-none text-neutral-500 hover:bg-black/5 dark:border-white/15">지우기</button>
                  </div>
                )}
                {/* 크기: precise mm width/height (single col/row) + 균등 분배 (multi). 복잡한 그리드에서
                    핸들을 찾아 끌 필요 없이 숫자로 정확히, 또는 한 번에 균등하게. */}
                {rangeMenu === "size" && (
                  <div className="absolute right-0 top-full z-[61] mt-1 flex w-56 flex-col gap-2 rounded-md border border-black/10 bg-white p-2.5 text-[11px] shadow-xl dark:border-white/10 dark:bg-neutral-800" onPointerDown={stop}>
                    {singleCol ? (
                      <label className="flex items-center justify-between gap-2">
                        <span className="text-neutral-600 dark:text-neutral-300">열 너비</span>
                        <span className="flex items-center gap-1">
                          <input
                            key={`w${shownRange.c0}`}
                            type="number" min={2} step={0.5} defaultValue={colWidthMm.toFixed(1)}
                            onMouseDown={(e) => e.stopPropagation()}
                            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); const v = parseFloat((e.currentTarget as HTMLInputElement).value); if (Number.isFinite(v)) { setColWidthMm(v); setRangeMenu(null); } } }}
                            onBlur={(e) => { const v = parseFloat(e.currentTarget.value); if (Number.isFinite(v) && Math.abs(v - colWidthMm) > 0.05) setColWidthMm(v); }}
                            className="w-16 rounded border border-black/15 bg-transparent px-1 py-0.5 text-right tabular-nums outline-none focus:border-accent dark:border-white/15"
                          />
                          <span className="text-neutral-400">mm</span>
                        </span>
                      </label>
                    ) : (
                      <button onMouseDown={keep} onClick={() => { equalizeCols(); setRangeMenu(null); }} className="rounded bg-black/5 px-2 py-1 text-left hover:bg-accent/10 hover:text-accent dark:bg-white/10">열 너비 균등 분배 ({shownRange.c1 - shownRange.c0 + 1}열)</button>
                    )}
                    {onCommitRowHeights && (singleRow ? (
                      <label className="flex items-center justify-between gap-2">
                        <span className="text-neutral-600 dark:text-neutral-300">행 높이</span>
                        <span className="flex items-center gap-1">
                          <input
                            key={`h${shownRange.r0}`}
                            type="number" min={2} step={0.5} defaultValue={rowHeightMm.toFixed(1)}
                            onMouseDown={(e) => e.stopPropagation()}
                            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); const v = parseFloat((e.currentTarget as HTMLInputElement).value); if (Number.isFinite(v)) { setRowHeightMm(v); setRangeMenu(null); } } }}
                            onBlur={(e) => { const v = parseFloat(e.currentTarget.value); if (Number.isFinite(v) && Math.abs(v - rowHeightMm) > 0.05) setRowHeightMm(v); }}
                            className="w-16 rounded border border-black/15 bg-transparent px-1 py-0.5 text-right tabular-nums outline-none focus:border-accent dark:border-white/15"
                          />
                          <span className="text-neutral-400">mm</span>
                        </span>
                      </label>
                    ) : (
                      <button onMouseDown={keep} onClick={() => { equalizeRows(); setRangeMenu(null); }} className="rounded bg-black/5 px-2 py-1 text-left hover:bg-accent/10 hover:text-accent dark:bg-white/10">행 높이 균등 분배 ({shownRange.r1 - shownRange.r0 + 1}행)</button>
                    ))}
                    <p className="text-[10px] leading-tight text-neutral-400">한 열/행만 선택하면 mm로 정확히, 여러 개면 균등 분배돼요.</p>
                  </div>
                )}
              </div>
            )}
          </>
        );
      })()}
    </div>
  );
}
