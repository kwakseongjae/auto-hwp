import { useCallback, useEffect, useRef, useState } from "react";
import { resizeImageBox, type Box, type ImageHandle, type XYWH } from "@tf-hwp/editor-core";

/// ImageOverlay — the 8-handle move/resize overlay drawn over a SELECTED image's placed box (issue 049,
/// the SDK promotion of the desktop `ImageOverlay`). It is a pure, individually-importable layer over
/// own-render PAGE px + a `scale` (same contract as SelectionOverlay/ColumnResizeOverlay), so a host can
/// mount it WITHOUT HwpWorkspace.
///
/// DIRECT MANIPULATION (issue 030 render-0 discipline): a live drag updates ONLY this overlay's LOCAL
/// state (a page-px box) — it never bumps a HwpWorkspace `useState`, so a 30-move drag re-renders neither
/// the workspace nor the SVG sheets (dragPerf harness stays flat); on pointerup it commits ONE undoable op
/// via `onCommitResize` / `onCommitMove` and the parent repaints from the engine (the single re-render).
///
/// RESIZE geometry lives in editor-core `resizeImageBox` (single point): CORNER handles preserve the start
/// aspect ratio (Shift releases — Figma convention the issue mandates), EDGE handles resize one axis. The
/// px→HWPUNIT commit conversion stays in the parent (`imageSizeToHwpunit`), never here.
///
/// MOVE is an ANCHOR REORDER, NOT a free offset (engine `MoveImage` 실측): the ghost drags freely, but on
/// drop the PARENT resolves the block under the drop point (`hitTest`) and relocates the image THERE — so
/// the UI gives no false freedom (the image lands in the text flow it was dropped on).

const RESIZE_HANDLES: { h: ImageHandle; cls: string; cursor: string }[] = [
  { h: "nw", cls: "hw-img-h-nw", cursor: "nwse-resize" },
  { h: "n", cls: "hw-img-h-n", cursor: "ns-resize" },
  { h: "ne", cls: "hw-img-h-ne", cursor: "nesw-resize" },
  { h: "e", cls: "hw-img-h-e", cursor: "ew-resize" },
  { h: "se", cls: "hw-img-h-se", cursor: "nwse-resize" },
  { h: "s", cls: "hw-img-h-s", cursor: "ns-resize" },
  { h: "sw", cls: "hw-img-h-sw", cursor: "nesw-resize" },
  { h: "w", cls: "hw-img-h-w", cursor: "ew-resize" },
];

/** The body-move drag threshold in CLIENT px — a press that moves less than this is a select, not a move
 *  (so clicking a selected image doesn't relocate it). */
const MOVE_THRESHOLD_PX = 6;

export interface ImageOverlayProps {
  /** The image's own-render PAGE px box `{x,y,w,h}` (from `imageAt`/`imageBbox`). */
  box: Box;
  /** rendered px / viewBox px for this page (from HwpPageView) — page px × scale = client px. */
  scale: number;
  /** Minimum image size in PAGE px (drag clamp). Default 8. */
  minPx?: number;
  /** Commit a resize: the NEW box in PAGE px. The parent converts page→HWPUNIT (`imageSizeToHwpunit`),
   *  applies `SetImageSize`, then apply-verifies + re-places the overlay. */
  onCommitResize: (pageBox: XYWH) => void;
  /** Commit a move: the DROP point in CLIENT px. The parent resolves which block that point lands on
   *  (`hitTest`) and relocates the image THERE (`MoveImage`) — anchor reorder, not a free offset. */
  onCommitMove: (dropClientX: number, dropClientY: number) => void;
  /** Live "drops here" feedback while MOVING — the current pointer (client px). Cleared via `onMoveEnd`. */
  onMovePoint?: (clientX: number, clientY: number) => void;
  /** The move drag ended (drop or cancel) — clear any drop indicator. */
  onMoveEnd?: () => void;
  /** Delete the selected image block (Delete/Backspace). Omit to hide the 🗑 affordance + key path. */
  onDelete?: () => void;
  /** Deselect (Escape / the overlay's own dismiss). */
  onDismiss: () => void;
}

/** A live drag in progress: the handle (or "move"), the pointer-down client coords, the box at start. */
type Drag = { handle: ImageHandle | "move"; startX: number; startY: number; start: XYWH };

/** page-px box → the XYWH the resize math + commit speak. */
const toXywh = (b: Box): XYWH => ({ x: b.x, y: b.y, w: b.w, h: b.h });

export function ImageOverlay({ box, scale, minPx = 8, onCommitResize, onCommitMove, onMovePoint, onMoveEnd, onDelete, onDismiss }: ImageOverlayProps) {
  // `live` is the PAGE-px box the overlay RENDERS while dragging (local-only, no parent repaint); null =
  // idle (render the committed `box`). Reset whenever the committed box changes (a fresh selection / a
  // post-commit re-place).
  const [live, setLive] = useState<XYWH | null>(null);
  const drag = useRef<Drag | null>(null);
  useEffect(() => setLive(null), [box.x, box.y, box.w, box.h]);

  // Apply a handle drag to the start box → the new live PAGE-px box. `dx/dy` are converted from CLIENT px
  // to PAGE px by the current `scale`. Resize is delegated to editor-core `resizeImageBox` (aspect lock on
  // corners unless Shift); move translates the whole box.
  const apply = useCallback(
    (d: Drag, clientX: number, clientY: number, shift: boolean): XYWH => {
      const dx = (clientX - d.startX) / scale;
      const dy = (clientY - d.startY) / scale;
      if (d.handle === "move") return { ...d.start, x: d.start.x + dx, y: d.start.y + dy };
      return resizeImageBox(d.start, d.handle, dx, dy, shift, minPx);
    },
    [scale, minPx],
  );

  const onPointerMove = useCallback(
    (e: PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      setLive(apply(d, e.clientX, e.clientY, e.shiftKey));
      if (d.handle === "move") onMovePoint?.(e.clientX, e.clientY); // live "drops here" feedback
    },
    [apply, onMovePoint],
  );

  const onPointerUp = useCallback(
    (e: PointerEvent) => {
      const d = drag.current;
      drag.current = null;
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      if (!d) return;
      const next = apply(d, e.clientX, e.clientY, e.shiftKey);
      setLive(null); // the parent repaint re-places the overlay from the fresh bbox
      if (d.handle === "move") {
        onMoveEnd?.();
        // Ignore a trivial jitter (a click that didn't really drag) so a select doesn't relocate; else hand
        // the parent the DROP point so it relocates the image to whatever block lands there (anchor reorder).
        const movedPx = Math.hypot(e.clientX - d.startX, e.clientY - d.startY);
        if (movedPx > MOVE_THRESHOLD_PX) onCommitMove(e.clientX, e.clientY);
      } else if (Math.abs(next.w - d.start.w) > 0.5 || Math.abs(next.h - d.start.h) > 0.5) {
        onCommitResize(next); // only commit when the size actually changed (a handle click w/o drag = no-op)
      }
    },
    [apply, onPointerMove, onCommitMove, onCommitResize, onMoveEnd],
  );

  const startDrag = useCallback(
    (handle: ImageHandle | "move") => (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation(); // the overlay owns this gesture — never let it reach the selection model
      drag.current = { handle, startX: e.clientX, startY: e.clientY, start: live ?? toXywh(box) };
      window.addEventListener("pointermove", onPointerMove);
      window.addEventListener("pointerup", onPointerUp);
    },
    [box, live, onPointerMove, onPointerUp],
  );

  // Clean up any straggling window listeners if the overlay unmounts mid-drag.
  useEffect(
    () => () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    },
    [onPointerMove, onPointerUp],
  );

  // Escape dismisses the selection; Delete/Backspace removes the image block (normal doc-app gesture).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.key === "Escape") onDismiss();
      else if (onDelete && (e.key === "Delete" || e.key === "Backspace")) {
        e.preventDefault();
        onDelete();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDismiss, onDelete]);

  const r = live ?? toXywh(box);
  return (
    <div
      className="hw-img-overlay"
      data-image-overlay
      data-testid="hw-image-overlay"
      style={{ left: r.x * scale, top: r.y * scale, width: r.w * scale, height: r.h * scale }}
      onPointerDown={startDrag("move")}
      role="presentation"
    >
      {onDelete && (
        <button
          type="button"
          className="hw-img-delete"
          data-testid="hw-image-delete"
          title="이미지 삭제 (Delete)"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
        >
          🗑 삭제
        </button>
      )}
      {RESIZE_HANDLES.map(({ h, cls, cursor }) => (
        <span
          key={h}
          className={`hw-img-handle ${cls}`}
          data-testid={`hw-image-handle-${h}`}
          style={{ cursor }}
          onPointerDown={startDrag(h)}
        />
      ))}
    </div>
  );
}
