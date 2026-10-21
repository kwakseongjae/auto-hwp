import { useEffect, useState } from "react";
import type { WorkspaceHandle, WorkspaceTextFormat } from "./components/HwpWorkspace";

/** #482 — what a host-drawn chrome usually shows, read from a `WorkspaceHandle`. */
export interface WorkspaceViewState {
  /** Committed zoom factor (1 = 100%). */
  zoom: number;
  /** Page at the reading line (0-based) — the status bar's page. */
  page: number;
  /** Live page count (0 without a document). */
  pageCount: number;
  canUndo: boolean;
  canRedo: boolean;
  /** Character format of the current selection, `null` without one. */
  format: WorkspaceTextFormat | null;
}

const FORMAT_KEYS = ["font", "sizePt", "color", "bold", "italic", "underline", "highlight"] as const;
const MIXED_KEYS = ["bold", "italic", "underline", "highlight"] as const;

function readView(handle: WorkspaceHandle): WorkspaceViewState {
  const { current, count } = handle.getPage();
  return {
    zoom: handle.getZoom(),
    page: current,
    pageCount: count,
    canUndo: handle.canUndo(),
    canRedo: handle.canRedo(),
    format: handle.getSelectionFormat(),
  };
}

/** Field-wise: the workspace may hand out a new format object with the same values. */
function sameFormat(a: WorkspaceTextFormat | null, b: WorkspaceTextFormat | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return FORMAT_KEYS.every((k) => a[k] === b[k]) && MIXED_KEYS.every((k) => a.mixed?.[k] === b.mixed?.[k]);
}

function sameView(a: WorkspaceViewState | null, b: WorkspaceViewState): boolean {
  return (
    !!a &&
    a.zoom === b.zoom &&
    a.page === b.page &&
    a.pageCount === b.pageCount &&
    a.canUndo === b.canUndo &&
    a.canRedo === b.canRedo &&
    sameFormat(a.format, b.format)
  );
}

/**
 * #482 — subscribe a host component to a workspace handle: the React-layer convenience over
 * `WorkspaceHandle.subscribe`. Re-renders only the calling component, and only when a value it returns
 * changed (the handle notifies after state settles — never per gesture tick). `null` until a handle is given:
 *
 *   const [ws, setWs] = useState<WorkspaceHandle | null>(null);
 *   const view = useWorkspaceState(ws); // { zoom, page, pageCount, canUndo, canRedo, format } | null
 *   <HwpWorkspace onReady={setWs} … />
 */
export function useWorkspaceState(handle: WorkspaceHandle | null | undefined): WorkspaceViewState | null {
  const [view, setView] = useState<WorkspaceViewState | null>(() => (handle ? readView(handle) : null));
  useEffect(() => {
    if (!handle) {
      setView(null);
      return;
    }
    const update = () =>
      setView((prev) => {
        const next = readView(handle);
        return sameView(prev, next) ? prev : next;
      });
    update(); // anything that settled between this render and the subscription
    return handle.subscribe(update);
  }, [handle]);
  return view;
}
