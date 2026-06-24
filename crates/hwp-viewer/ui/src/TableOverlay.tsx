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
  /** CSS px per PAGE unit on the vertical axis (the SVG rect/viewBox ratio) — converts a move drag to
   *  page units so the parent can decide the target block. */
  pxPerPageY: number;
  /** Commit a move: the vertical drag delta in PAGE units (parent decides the target block from sign). */
  onCommitMove: (dyPage: number) => void;
  /** Append one empty body row to the table (행 추가). */
  onAddRow: () => void;
  /** Edit a cell — opens the cell editor (칸 편집). */
  onEditCell: () => void;
  /** Delete the whole table block (표 삭제). */
  onDeleteTable: () => void;
  /** Deselect (Escape / click-away handled by the parent; this is the overlay's own dismiss). */
  onDismiss: () => void;
};

/** Minimum drag distance (px) before a press is treated as a MOVE (vs. a click that just selected). */
const MIN_DRAG_PX = 16;

/** A live drag in progress: the pointer-down screen coords + the box at the gesture start. */
type Drag = { startX: number; startY: number; start: ScreenBox; moved: boolean };

export default function TableOverlay({
  box,
  pxPerPageY,
  onCommitMove,
  onAddRow,
  onEditCell,
  onDeleteTable,
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
  }, []);

  const onPointerUp = useCallback((e: PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    if (!d) return;
    setLive(null); // the parent repaint will re-place the overlay from the fresh bbox
    const dyPx = e.clientY - d.startY;
    // Ignore a trivial jitter (a click that didn't really drag) so a select doesn't relocate.
    if (d.moved && Math.abs(dyPx) > MIN_DRAG_PX && pxPerPageY > 0) onCommitMove(dyPx / pxPerPageY);
  }, [onPointerMove, onCommitMove, pxPerPageY]);

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

  // Escape dismisses the selection.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDismiss]);

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
