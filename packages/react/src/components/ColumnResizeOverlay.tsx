import { useCallback, useEffect, useState } from "react";
import { resizeBoundary } from "@tf-hwp/editor-core";

/** Which axis a boundary drag runs along: `"x"` = column boundaries (vertical grips, drag left↔right);
 *  `"y"` = row boundaries (horizontal grips, drag up↕down). */
type Axis = "x" | "y";

/// useBoundaryDrag — the shared drag core for BOTH the column-width and row-height overlays (issue 031).
/// It keeps the live (possibly dragged) boundaries, and on each pointermove converts the pointer into
/// own-render PAGE px and moves the dragged INTERIOR boundary (clamped by `resizeBoundary`).
///
/// ⚠️ ISSUE 031 ROOT CAUSE (fixed here): the overlay is a SIBLING of `.hw-sheet` inside `.hw-sheet-wrap`
/// (see HwpPageView — `renderOverlay` renders next to the memoized PageSheet). v1's `onMove` walked
/// `closest('.hw-sheet')`, which returns NULL from the overlay → early return → the drag preview never
/// moved → an UNCHANGED boundary array was committed → the px→ratio conversion was a no-op → the engine
/// applied nothing, yet the host still toasted success (the "성공 토스트인데 무반영" bug). The grips are
/// positioned in the `.hw-sheet-wrap` frame (the `inset:0` overlay), so we convert the pointer in that
/// SAME frame — `closest('.hw-sheet-wrap')`, whose left/top edge equals the SVG's top-left.
function useBoundaryDrag(boundaries: number[], axis: Axis, scale: number, minPx: number, onCommit: (b: number[]) => void) {
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
      const host = (ev.currentTarget as HTMLElement).closest(".hw-sheet-wrap") as HTMLElement | null;
      const rect = host?.getBoundingClientRect();
      if (!rect) return;
      const page = axis === "x" ? (ev.clientX - rect.left) / scale : (ev.clientY - rect.top) / scale;
      setLive((prev) => resizeBoundary(prev, dragging, page, minPx));
    },
    [dragging, axis, scale, minPx],
  );

  const onUp = useCallback(() => {
    if (dragging == null) return;
    setDragging(null);
    onCommit(live);
  }, [dragging, live, onCommit]);

  return { live, dragging, onDown, onMove, onUp };
}

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
  const { live, dragging, onDown, onMove, onUp } = useBoundaryDrag(boundaries, "x", scale, minPx, onCommit);

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

export interface RowResizeOverlayProps {
  /** The table's `rows + 1` row-boundary y-positions in own-render PAGE px (from
   *  `core.session.rowBoundaries`). The two ends are the table box top/bottom (fixed); interior handles
   *  drag. On a SPLIT table these are the per-page FRAGMENT's boundaries (rebased to the fragment top). */
  boundaries: number[];
  /** The table box left + width in own-render PAGE px — the handles span the whole table width. */
  left: number;
  width: number;
  /** rendered px / viewBox px for this page (from HwpPageView) — page px × scale = client px. */
  scale: number;
  /** Minimum row height in PAGE px (drag clamp). Default 8. */
  minPx?: number;
  /** Fired on pointer-up with the NEW boundary array (PAGE px). The host remaps px → a WHOLE-table
   *  HWPUNIT `heights` vector (`remapFragmentHeights`) and applies `SetTableRowHeights` (px→HWPUNIT +
   *  split remap stays in core — issue 031). */
  onCommit: (boundaries: number[]) => void;
}

/// RowResizeOverlay — the opt-in ROW-height drag handles for a marked table (issue 031, the row twin of
/// ColumnResizeOverlay). It draws a thin HORIZONTAL grip on each INTERIOR row boundary; dragging shows a
/// live preview and on release calls `onCommit(newBoundaries)`. Same PAGE-px + `scale` contract; the
/// px→HWPUNIT conversion + split-table fragment→whole-table remap live in the core (single point). The
/// handle is `hw-row-grip`. Shares the axis-generic drag core (`.hw-sheet-wrap` coordinate frame).
export function RowResizeOverlay({ boundaries, left, width, scale, minPx = 8, onCommit }: RowResizeOverlayProps) {
  const { live, dragging, onDown, onMove, onUp } = useBoundaryDrag(boundaries, "y", scale, minPx, onCommit);

  if (live.length < 3) return null; // need at least one interior boundary (2 rows) to resize

  return (
    <div className="hw-row-resize" onPointerMove={onMove} onPointerUp={onUp} data-testid="hw-row-resize">
      {live.map((y, i) => {
        if (i === 0 || i === live.length - 1) return null; // endpoints are the table box — no grip
        return (
          <div
            key={i}
            className={`hw-row-grip${dragging === i ? " hw-row-grip-active" : ""}`}
            data-testid={`hw-row-grip-${i}`}
            role="separator"
            aria-orientation="horizontal"
            aria-label={`${i}번째 행 경계 높이 조절`}
            title="드래그하여 행 높이 조절"
            style={{ top: y * scale, left: left * scale, width: width * scale }}
            onPointerDown={onDown(i)}
          />
        );
      })}
    </div>
  );
}
