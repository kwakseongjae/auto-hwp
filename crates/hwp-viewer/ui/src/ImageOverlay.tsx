import { useCallback, useEffect, useRef, useState } from "react";

/// The 8-handle move/resize overlay drawn over a selected image's placed box (own-render only).
///
/// DIRECT MANIPULATION: a live drag updates ONLY this overlay's local geometry (a CSS box, no
/// re-layout / no repaint of the document) for a smooth 60fps gesture; on pointerup it commits ONE
/// undoable op via `onCommitResize` / `onCommitMove` and the parent repaints from the engine. The
/// overlay is positioned in CSS px (already scaled from page units by the caller, so it tracks the
/// SVG zoom). Resize maps the box back to page units via `pxPerPageX/Y`; move reports the px delta.

/** Screen-px box relative to the page's `.page-svg` wrapper. */
export type ScreenBox = { left: number; top: number; width: number; height: number };

/** Which handle is being dragged. "move" = the body (relocate); the rest resize from that anchor. */
type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "move";

const RESIZE_HANDLES: { h: Handle; cls: string; cursor: string }[] = [
  { h: "nw", cls: "left-0 top-0 -translate-x-1/2 -translate-y-1/2", cursor: "nwse-resize" },
  { h: "n", cls: "left-1/2 top-0 -translate-x-1/2 -translate-y-1/2", cursor: "ns-resize" },
  { h: "ne", cls: "right-0 top-0 translate-x-1/2 -translate-y-1/2", cursor: "nesw-resize" },
  { h: "e", cls: "right-0 top-1/2 translate-x-1/2 -translate-y-1/2", cursor: "ew-resize" },
  { h: "se", cls: "right-0 bottom-0 translate-x-1/2 translate-y-1/2", cursor: "nwse-resize" },
  { h: "s", cls: "left-1/2 bottom-0 -translate-x-1/2 translate-y-1/2", cursor: "ns-resize" },
  { h: "sw", cls: "left-0 bottom-0 -translate-x-1/2 translate-y-1/2", cursor: "nesw-resize" },
  { h: "w", cls: "left-0 top-1/2 -translate-x-1/2 -translate-y-1/2", cursor: "ew-resize" },
];

/** Minimum on-screen size (px) a resize can shrink the box to — keeps the handle grabbable. */
const MIN_PX = 16;

type Props = {
  /** The image's box in CSS px relative to the page wrapper (already zoom-scaled by the caller). */
  box: ScreenBox;
  /** CSS px per PAGE unit on each axis (the SVG rect/viewBox ratio) — converts a resize to page units. */
  pxPerPageX: number;
  pxPerPageY: number;
  /** Commit a resize: the new width/height in PAGE units (the op layer converts page→HWPUNIT 1:1). */
  onCommitResize: (pageW: number, pageH: number) => void;
  /** Commit a move: the DROP point in client (screen) px. The parent resolves which block that point
   *  lands on (own_hit_test) and relocates the image THERE — so it drops where you point. */
  onCommitMove: (dropClientX: number, dropClientY: number) => void;
  /** Deselect (Escape / click-away handled by the parent; this is the overlay's own dismiss). */
  onDismiss: () => void;
};

/** A live drag in progress: the originating handle + the pointer-down screen coords + the box at start. */
type Drag = { handle: Handle; startX: number; startY: number; start: ScreenBox };

export default function ImageOverlay({ box, pxPerPageX, pxPerPageY, onCommitResize, onCommitMove, onDismiss }: Props) {
  // `live` is the box the overlay RENDERS while dragging (local-only, no parent repaint); null = idle
  // (render the committed `box` straight from props). Reset whenever the committed box changes.
  const [live, setLive] = useState<ScreenBox | null>(null);
  const drag = useRef<Drag | null>(null);
  useEffect(() => setLive(null), [box.left, box.top, box.width, box.height]);

  // Apply a handle drag to the start box → the new live box (resize keeps the opposite edge fixed;
  // move translates the whole box). Aspect is NOT locked (corner handles free-resize like Hancom).
  const apply = useCallback((d: Drag, x: number, y: number): ScreenBox => {
    const dx = x - d.startX;
    const dy = y - d.startY;
    const b = { ...d.start };
    if (d.handle === "move") {
      b.left += dx;
      b.top += dy;
      return b;
    }
    if (d.handle.includes("e")) b.width = Math.max(MIN_PX, d.start.width + dx);
    if (d.handle.includes("s")) b.height = Math.max(MIN_PX, d.start.height + dy);
    if (d.handle.includes("w")) {
      const w = Math.max(MIN_PX, d.start.width - dx);
      b.left = d.start.left + (d.start.width - w);
      b.width = w;
    }
    if (d.handle.includes("n")) {
      const h = Math.max(MIN_PX, d.start.height - dy);
      b.top = d.start.top + (d.start.height - h);
      b.height = h;
    }
    return b;
  }, []);

  const onPointerMove = useCallback((e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    setLive(apply(d, e.clientX, e.clientY));
  }, [apply]);

  const onPointerUp = useCallback((e: PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    if (!d) return;
    const next = apply(d, e.clientX, e.clientY);
    setLive(null); // the parent repaint will re-place the overlay from the fresh bbox
    if (d.handle === "move") {
      const dyPx = next.top - d.start.top;
      const dxPx = next.left - d.start.left;
      // Ignore a trivial jitter (a click that didn't really drag) so a select doesn't relocate; else
      // hand the parent the DROP point so it relocates the image to whatever block lands there.
      if (Math.abs(dyPx) > MIN_PX || Math.abs(dxPx) > MIN_PX) onCommitMove(e.clientX, e.clientY);
    } else if (pxPerPageX > 0 && pxPerPageY > 0) {
      // Only commit when the size actually changed (a click on a handle without a drag is a no-op).
      if (Math.abs(next.width - d.start.width) > 0.5 || Math.abs(next.height - d.start.height) > 0.5) {
        onCommitResize(next.width / pxPerPageX, next.height / pxPerPageY);
      }
    }
  }, [apply, onPointerMove, onCommitMove, onCommitResize, pxPerPageX, pxPerPageY]);

  const startDrag = useCallback((handle: Handle) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    drag.current = { handle, startX: e.clientX, startY: e.clientY, start: live ?? box };
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

  const r = live ?? box;
  return (
    <div
      className="absolute z-20 cursor-move ring-2 ring-accent"
      style={{ left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` }}
      onPointerDown={startDrag("move")}
      role="presentation"
    >
      {RESIZE_HANDLES.map(({ h, cls, cursor }) => (
        <span
          key={h}
          className={`absolute h-2.5 w-2.5 rounded-[2px] border border-white bg-accent shadow-sm ${cls}`}
          style={{ cursor }}
          onPointerDown={startDrag(h)}
        />
      ))}
    </div>
  );
}
