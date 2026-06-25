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

  const r = live ?? box;
  const fracs = liveFracs ?? colFracs;
  const rFracs = liveRowFracs ?? rowFracs;
  return (
    <div
      className="pointer-events-auto absolute z-20 cursor-move ring-2 ring-accent"
      style={{ left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` }}
      onPointerDown={startDrag}
      role="presentation"
      title="드래그하여 표 위치 이동"
    >
      {/* A grab handle pill on the top-left edge so the move affordance is obvious. */}
      <span className="absolute -left-px -top-6 flex items-center gap-1 rounded-t-md bg-accent px-1.5 py-0.5 text-[10px] font-medium text-white shadow-sm">
        <span aria-hidden>⠿</span> 표
      </span>
      {/* Quick-edit toolbar — anchored to the top-right of the box, above the page content. */}
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
                onClick={(e) => { e.stopPropagation(); onShade(shadeScope, c); setShadeOpen(false); }}
                className="h-5 w-5 rounded-[3px] border border-black/20 hover:ring-2 hover:ring-accent disabled:cursor-not-allowed disabled:opacity-40"
                style={{ backgroundColor: c }}
              />
            ))}
            <button
              disabled={!activeCell}
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
    </div>
  );
}
