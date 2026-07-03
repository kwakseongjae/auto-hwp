import { useCallback, useEffect, useState } from "react";
import { resizeBoundary } from "@tf-hwp/editor-core";

export interface ColumnResizeOverlayProps {
  /** The table's `cols + 1` column-boundary x-positions in own-render PAGE px (from
   *  `core.session.colBoundaries`). The two ends are the table box edges (fixed); interior handles drag. */
  boundaries: number[];
  /** The table box top + height in own-render PAGE px — the handles span the whole table height. */
  top: number;
  height: number;
  /** rendered px / viewBox px for this page (from HwpPageView) — page px × scale = client px. */
  scale: number;
  /** Minimum column width in PAGE px (drag clamp). Default 8. */
  minPx?: number;
  /** Fired on pointer-up with the NEW boundary array (PAGE px). The host converts to ratios via the core
   *  `boundariesToRatios` util and applies `SetTableColWidths` (px→ratio stays in core — issue 027 §함정). */
  onCommit: (boundaries: number[]) => void;
}

/// ColumnResizeOverlay — the opt-in column-width drag handles for a marked table (issue 027 step 1). It
/// draws a thin vertical grip on each INTERIOR column boundary; dragging a grip shows a live preview
/// (local state, no engine round-trip) and on release calls `onCommit(newBoundaries)`. It is a pure,
/// individually-importable layer over own-render PAGE px + a `scale` (same contract as SelectionOverlay),
/// so a host can mount it WITHOUT HwpWorkspace. The px→ratio conversion is NOT done here — the core owns
/// it (single conversion point). All chrome is presentational; the handle is `hw-col-grip`.
export function ColumnResizeOverlay({ boundaries, top, height, scale, minPx = 8, onCommit }: ColumnResizeOverlayProps) {
  // The live (possibly dragged) boundaries; resets whenever the committed boundaries change.
  const [live, setLive] = useState(boundaries);
  const [dragging, setDragging] = useState<number | null>(null);
  useEffect(() => setLive(boundaries), [boundaries]);

  const onDown = useCallback(
    (i: number) => (ev: React.PointerEvent) => {
      ev.preventDefault();
      ev.stopPropagation();
      try {
        (ev.currentTarget as Element).setPointerCapture?.(ev.pointerId);
      } catch {
        /* jsdom */
      }
      setDragging(i);
    },
    [],
  );

  const onMove = useCallback(
    (ev: React.PointerEvent) => {
      if (dragging == null) return;
      // client px → page px: the handle sits in the sheet whose left edge is the overlay's left; convert
      // the pointer's offset within the sheet back to page px by dividing by scale.
      const host = (ev.currentTarget as HTMLElement).closest(".hw-sheet") as HTMLElement | null;
      const rect = host?.getBoundingClientRect();
      if (!rect) return;
      const pageX = (ev.clientX - rect.left) / scale;
      setLive((prev) => resizeBoundary(prev, dragging, pageX, minPx));
    },
    [dragging, scale, minPx],
  );

  const onUp = useCallback(() => {
    if (dragging == null) return;
    setDragging(null);
    onCommit(live);
  }, [dragging, live, onCommit]);

  if (live.length < 3) return null; // need at least one interior boundary (2 cols) to resize

  return (
    <div className="hw-col-resize" onPointerMove={onMove} onPointerUp={onUp} data-testid="hw-col-resize">
      {live.map((x, i) => {
        if (i === 0 || i === live.length - 1) return null; // endpoints are the table box — no grip
        return (
          <div
            key={i}
            className={`hw-col-grip${dragging === i ? " hw-col-grip-active" : ""}`}
            data-testid={`hw-col-grip-${i}`}
            role="separator"
            aria-orientation="vertical"
            aria-label={`${i}번째 열 경계 너비 조절`}
            title="드래그하여 열 너비 조절"
            style={{ left: x * scale, top: top * scale, height: height * scale }}
            onPointerDown={onDown(i)}
          />
        );
      })}
    </div>
  );
}
