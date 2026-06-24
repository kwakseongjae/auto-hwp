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
  onCommitMove,
  onAddRow,
  onEditCell,
  onDeleteTable,
  deletable = true,
  onMovePoint,
  onMoveEnd,
  onDismiss,
}: Props) {
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

  const r = live ?? box;
  return (
    <div
      className="absolute z-20 cursor-move ring-2 ring-accent"
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
        <button className="rounded px-1.5 py-0.5 text-red-600 hover:bg-red-500/10 dark:text-red-400" {...verb(onDeleteTable)}>
          표 삭제
        </button>
      </div>
    </div>
  );
}
