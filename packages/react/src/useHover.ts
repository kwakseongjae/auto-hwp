/// useHover — the DOM pipeline for the issue-038 hover pre-highlight + cursor system (FG-09 + FG-06). It
/// is the 030 MarqueeLayer discipline applied to HOVER: a pointermove is rAF-coalesced, deduped against
/// the last target, resolved through the adapter's own-render geometry (tableCellAt → hitTest), and the
/// result is pushed into a HoverStore that HoverLayer draws via a ref (no workspace/sheet re-render). The
/// cursor is written straight to the host element's `data-hover-cursor` (a DOM write, never a React state)
/// so a text↔default↔resize transition also costs 0 renders.
///
/// §함정 discipline: pointermoves NEVER stack async queries — at most ONE hit-test is in flight, always for
/// the LATEST coord; a move that arrives mid-query is coalesced into a single follow-up (stale coords are
/// overwritten, never queued). Suppression (drag/pan/in-place-editor/resize-grip) short-circuits before any
/// query. The client-px → page-px conversion reuses coords.ts (screenToPage), the SAME map HwpPageView uses.
import { useCallback, useEffect, useRef } from "react";
import type { EngineAdapter } from "@tf-hwp/editor-core";
import { readViewBox, screenToPage } from "./coords";
import { HoverStore, cursorForContext, pointInBox, recordHoverQueryMs, type HoverCursor, type HoverHighlight } from "./hover";

// rAF with a jsdom/SSR-safe fallback (same shim as MarqueeLayer).
const raf: (cb: FrameRequestCallback) => number =
  typeof requestAnimationFrame === "function" ? requestAnimationFrame : (cb) => setTimeout(() => cb(0), 0) as unknown as number;
const caf: (id: number) => void = typeof cancelAnimationFrame === "function" ? cancelAnimationFrame : (id) => clearTimeout(id);
const now: () => number = typeof performance !== "undefined" && typeof performance.now === "function" ? () => performance.now() : () => Date.now();

export interface UseHoverParams {
  /** The backend seam — hover reads geometry via `tableCellAt` (cell) then `hitTest` (block). */
  adapter: EngineAdapter;
  /** enableEditing — false ⇒ highlight still shows, but the cursor stays default (issue 038 §억제). */
  editingOn: boolean;
  /** The element carrying `data-hover-cursor` that the sheet cursors key off (the scroll container). */
  cursorHostRef: React.RefObject<HTMLElement | null>;
  /** Live suppression mirrors, read fresh per move without re-subscribing. */
  panModeRef: React.RefObject<boolean>;
  panningRef: React.RefObject<boolean>;
  editorOpenRef: React.RefObject<boolean>;
  /** Batched suppression flag (pan | pan-drag | editor-open | gesture-active) — clears the highlight the
   *  instant it flips on (those transitions may have no following pointermove to clear it). */
  suppressed: boolean;
}

export interface UseHoverResult {
  /** The store HoverLayer subscribes to (one instance for the workspace's lifetime). */
  store: HoverStore;
  /** Attach to the workspace's pointer surface (the zoom layer) — hover moves bubble here. */
  onPointerMove: (e: React.PointerEvent) => void;
  /** Attach to the same surface — clears the highlight when the pointer leaves the pages. */
  onPointerLeave: () => void;
}

export function useHover(params: UseHoverParams): UseHoverResult {
  const storeRef = useRef<HoverStore | null>(null);
  if (!storeRef.current) storeRef.current = new HoverStore();
  const store = storeRef.current;

  // Live mirror of the params so the (stable) handlers read the current adapter/flags without re-creating.
  const p = useRef(params);
  p.current = params;

  const rafRef = useRef<number | null>(null);
  const latestRef = useRef<{ page: number; x: number; y: number } | null>(null); // newest coord to query
  const inFlightRef = useRef(false); // exactly one hit-test in flight at a time
  const pendingRef = useRef(false); // a move arrived mid-query → one coalesced follow-up
  const lastHitRef = useRef<HoverHighlight | null>(null); // last APPLIED target (box-containment dedup)

  const setCursor = useCallback((c: HoverCursor) => {
    const el = p.current.cursorHostRef.current;
    if (!el) return;
    // "default" clears the attribute so the base `.hw-sheet { cursor: default }` (and 035's pan className)
    // win; a non-default value drives the sheet cursor via a CSS attribute selector (no React render).
    el.dataset.hoverCursor = c === "default" ? "" : c;
  }, []);

  const clear = useCallback(() => {
    latestRef.current = null;
    lastHitRef.current = null;
    pendingRef.current = false;
    if (rafRef.current != null) {
      caf(rafRef.current);
      rafRef.current = null;
    }
    store.set(null);
    setCursor("default");
  }, [store, setCursor]);

  const applyHit = useCallback(
    (hit: HoverHighlight | null) => {
      lastHitRef.current = hit;
      store.set(hit);
      setCursor(cursorForContext({ panning: false, panMode: false, overGrip: null, hitKind: hit?.kind ?? null, editing: p.current.editingOn }));
    },
    [store, setCursor],
  );

  // Resolve the latest coord through the adapter. In-flight-1: if a query is already running, do nothing;
  // the running one re-invokes for the newest coord on completion. A trapped query just clears (no crash).
  const runQuery = useCallback(async () => {
    const coord = latestRef.current;
    if (!coord || inFlightRef.current) return;
    inFlightRef.current = true;
    let hit: HoverHighlight | null = null;
    const t0 = now();
    try {
      const { adapter } = p.current;
      const cell = adapter.tableCellAt ? await adapter.tableCellAt(coord.page, coord.x, coord.y) : null;
      if (cell) hit = { page: coord.page, box: { x: cell.x, y: cell.y, w: cell.w, h: cell.h }, kind: "cell" };
      else {
        const bh = await adapter.hitTest(coord.page, coord.x, coord.y);
        if (bh) hit = { page: coord.page, box: { x: bh.x, y: bh.y, w: bh.w, h: bh.h }, kind: bh.kind };
      }
    } catch {
      hit = null; // a trapped hit-test just clears the highlight
    }
    recordHoverQueryMs(now() - t0);
    inFlightRef.current = false;
    // Suppression may have begun during the await (drag/pan/editor) → drop the result.
    if (p.current.suppressed) {
      store.set(null);
      return;
    }
    applyHit(hit);
    // Newer move(s) arrived mid-query → resolve ONCE more for the latest coord (in-flight stays 1).
    if (pendingRef.current) {
      pendingRef.current = false;
      void runQuery();
    }
  }, [store, applyHit]);

  // rAF-coalesce: many pointermoves within a frame collapse to a single query for the newest coord.
  const schedule = useCallback(() => {
    if (inFlightRef.current) {
      pendingRef.current = true;
      return;
    }
    if (rafRef.current != null) return;
    rafRef.current = raf(() => {
      rafRef.current = null;
      void runQuery();
    });
  }, [runQuery]);

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const target = e.target as Element | null;
      if (!target) return;
      // Pan (035) owns grab/grabbing via the .hw-pan/.hw-panning className — suppress hover entirely.
      if (p.current.panModeRef.current || p.current.panningRef.current) {
        store.set(null);
        setCursor("default");
        return;
      }
      // Over a 031 resize grip: the grip's own CSS shows col/row-resize; suppress the highlight and reflect
      // the SAME cursor through the one pure function (reuse the grip judgment — no new boundary math).
      const grip = target.closest?.(".hw-col-grip") ? "col" : target.closest?.(".hw-row-grip") ? "row" : null;
      if (grip) {
        store.set(null);
        setCursor(cursorForContext({ panning: false, panMode: false, overGrip: grip, hitKind: null, editing: p.current.editingOn }));
        return;
      }
      // A selection/marquee DRAG (button held) or an open in-place editor → no pre-highlight.
      if (e.buttons !== 0 || p.current.editorOpenRef.current) {
        store.set(null);
        setCursor("default");
        return;
      }
      // Resolve the page + own-render px under the pointer (the SAME map HwpPageView uses).
      const sheet = target.closest?.(".hw-sheet") as HTMLElement | null;
      if (!sheet || sheet.dataset.page == null) {
        clear();
        return;
      }
      const svg = sheet.querySelector("svg") as SVGSVGElement | null;
      if (!svg) {
        // A virtualized placeholder (037) has no SVG — nothing to highlight; naturally cleared here.
        clear();
        return;
      }
      const page = Number(sheet.dataset.page);
      const rect = svg.getBoundingClientRect();
      const pt = screenToPage(e.clientX, e.clientY, rect, readViewBox(svg));
      if (!pt) {
        clear();
        return;
      }
      // Dedup: still inside the last hit's box ⇒ same block, skip the wasm re-query entirely.
      const last = lastHitRef.current;
      if (last && last.page === page && pointInBox(pt.x, pt.y, last.box)) return;
      latestRef.current = { page, x: pt.x, y: pt.y };
      schedule();
    },
    [store, setCursor, clear, schedule],
  );

  const onPointerLeave = useCallback(() => clear(), [clear]);

  // Clear the instant a suppression begins (drag/pan/editor) — that transition may have no pointermove.
  useEffect(() => {
    if (params.suppressed) clear();
  }, [params.suppressed, clear]);

  // Cancel any pending frame on unmount.
  useEffect(() => () => { if (rafRef.current != null) caf(rafRef.current); }, []);

  return { store, onPointerMove, onPointerLeave };
}
