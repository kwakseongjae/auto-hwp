import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { EngineAdapter } from "../EngineAdapter";
import { screenToPage } from "../coords";
import { sanitizeSvg } from "../sanitize";

/** A page-local click resolved to own-render PAGE px + the page index (for the workspace to hit-test).
 *  `meta` folds in the additive/toggle modifier (⌘ on macOS, Ctrl elsewhere) so the selection model can
 *  branch replace vs. toggle/union without re-reading the event; `client` carries the raw screen point
 *  so the workspace can measure the 4px drag threshold in true CSS px (independent of zoom). */
export type PageClick = { page: number; x: number; y: number; meta: boolean; client: { x: number; y: number } };

/** One rendered page: sanitized SVG + its parsed viewBox dimensions (own-render px). */
type PageState = { svg: string; vbW: number; vbH: number };

// ── dev-only render instrumentation (issue 030) ─────────────────────────────────────────────────────
// A global counter of how many times a document SHEET (a heavy per-page SVG) actually re-renders. The
// perf regression this issue kills is "the whole workspace re-renders on every marquee pointermove", so
// we PROVE the fix by asserting this counter stays flat across a 30-move drag. `DEV_INSTRUMENT` is a
// build-time constant (Vite folds `import.meta.env.PROD`), so the whole counter branch is dead-code
// eliminated from a production bundle — zero runtime cost in prod.
const DEV_INSTRUMENT: boolean = (import.meta as { env?: { PROD?: boolean } }).env?.PROD !== true;
type RenderGlobal = { __hwSheetRenders?: number };
function bumpSheetRenderCount(): void {
  if (!DEV_INSTRUMENT) return;
  const g = globalThis as RenderGlobal;
  g.__hwSheetRenders = (g.__hwSheetRenders ?? 0) + 1;
}
/** DEV/test helper: how many times any document sheet has rendered since the last reset. */
export function __getSheetRenderCount(): number {
  return (globalThis as RenderGlobal).__hwSheetRenders ?? 0;
}
/** DEV/test helper: zero the sheet render counter (call right before a measured gesture). */
export function __resetSheetRenderCount(): void {
  (globalThis as RenderGlobal).__hwSheetRenders = 0;
}

// ── dev-only page-selective-refresh instrumentation (issue 034) ─────────────────────────────────────
// Per issue 034 the perf regression this file kills is "every edit re-fetches, re-sanitizes and re-injects
// ALL pages" (measure-browser.mjs: 25p → ~107ms DOM tax). The fix compares each page's RAW svg string to
// its previous value and only sanitizes+injects the pages that actually changed. We PROVE the fix by
// counting, per refresh, how many pages were INJECTED (changed → paid sanitize+setState) vs SKIPPED
// (raw string identical → no sanitize, no state churn). Same build-time `DEV_INSTRUMENT` gate as above, so
// the counter branch is dead-code eliminated from a production bundle (prod tree-shaking verified).
type PageRefreshGlobal = { __hwPageInject?: number; __hwPageSkip?: number };
function bumpPageInjectCount(): void {
  if (!DEV_INSTRUMENT) return;
  const g = globalThis as PageRefreshGlobal;
  g.__hwPageInject = (g.__hwPageInject ?? 0) + 1;
}
function bumpPageSkipCount(): void {
  if (!DEV_INSTRUMENT) return;
  const g = globalThis as PageRefreshGlobal;
  g.__hwPageSkip = (g.__hwPageSkip ?? 0) + 1;
}
/** DEV/test helper: how many pages were sanitized+injected (i.e. changed) since the last reset. */
export function __getPageInjectCount(): number {
  return (globalThis as PageRefreshGlobal).__hwPageInject ?? 0;
}
/** DEV/test helper: how many pages were skipped (raw svg unchanged) since the last reset. */
export function __getPageSkipCount(): number {
  return (globalThis as PageRefreshGlobal).__hwPageSkip ?? 0;
}
/** DEV/test helper: zero the page inject/skip counters (call right before a measured refresh). */
export function __resetPageRefreshCounts(): void {
  const g = globalThis as PageRefreshGlobal;
  g.__hwPageInject = 0;
  g.__hwPageSkip = 0;
}

export interface HwpPageViewProps {
  adapter: EngineAdapter;
  /** Number of pages to render (from the workspace's open result / live count). */
  pageCount: number;
  /** Zoom factor: 1 = 100%. The A4 base width scales by this. */
  zoom?: number;
  /** A monotonically-bumped token; when it changes, every page's SVG is re-fetched (post-edit). */
  refreshToken?: number;
  /** A page-local click, already converted to own-render PAGE px (§4.5 lives in the component). */
  onPageClick?: (click: PageClick) => void;
  /** A page-local DOUBLE-click (issue 027: open the inline text popover). Same page-px conversion. */
  onPageDoubleClick?: (click: PageClick) => void;
  /** Pointer lifecycle for the selection model (issue 021): each carries the same page-local px + the
   *  modifier + the raw client point. On pointerdown the sheet captures the pointer so a drag that
   *  leaves the page still reports move/up here (marquee clips to the start page). Optional — a backend
   *  that only wants clicks can omit them. */
  onPagePointerDown?: (click: PageClick, ev: React.PointerEvent) => void;
  onPagePointerMove?: (click: PageClick, ev: React.PointerEvent) => void;
  onPagePointerUp?: (click: PageClick, ev: React.PointerEvent) => void;
  /** Per-page overlay layer (SelectionOverlay marks). `scale` = rendered px / viewBox px, so marks
   *  positioned as `pageBox * scale` track zoom exactly. Rendered inside a position:relative sheet. */
  renderOverlay?: (page: number, scale: number) => React.ReactNode;
}

const A4_W = 794; // CSS px for 210mm @ 96dpi — the 100% page width

/** Parse the own-render px viewBox from an SVG string (own-render SVGs carry `viewBox="0 0 W H"`;
 *  fall back to width/height attrs). Returns {0,0} when unknown (overlay then uses scale 1). */
function parseViewBox(svg: string): { w: number; h: number } {
  const vb = /viewBox\s*=\s*["']\s*[\d.]+\s+[\d.]+\s+([\d.]+)\s+([\d.]+)/i.exec(svg);
  if (vb) return { w: parseFloat(vb[1]), h: parseFloat(vb[2]) };
  const w = /\bwidth\s*=\s*["']([\d.]+)/i.exec(svg);
  const h = /\bheight\s*=\s*["']([\d.]+)/i.exec(svg);
  return { w: w ? parseFloat(w[1]) : 0, h: h ? parseFloat(h[1]) : 0 };
}

/** The (page, event) → nothing pointer/mouse handlers threaded into a sheet. Kept STABLE across renders
 *  in HwpPageView (via useCallback with `page` passed as an argument, not captured in a per-page closure)
 *  so PageSheet's React.memo actually holds — a fresh closure per render would defeat memoization. */
type SheetHandlers = {
  onClick: (page: number, ev: React.MouseEvent<HTMLDivElement>) => void;
  onDoubleClick: (page: number, ev: React.MouseEvent<HTMLDivElement>) => void;
  onPointerDown: (page: number, ev: React.PointerEvent<HTMLDivElement>) => void;
  onPointerMove: (page: number, ev: React.PointerEvent<HTMLDivElement>) => void;
  onPointerUp: (page: number, ev: React.PointerEvent<HTMLDivElement>) => void;
};

interface PageSheetProps extends SheetHandlers {
  page: number;
  /** The sanitized SVG string. Same document revision → same string (025's wasm SVG cache), so this is
   *  a STABLE reference across selection/marquee/toolbar churn and React.memo skips the re-render. */
  svg: string;
}

/// PageSheet — ONE document sheet (a heavy per-page SVG injected via dangerouslySetInnerHTML). Memoized
/// on (page, svg, handlers): selection / marquee / toolbar state changes DO NOT touch these props, so the
/// SVG never re-renders during a drag (issue 030 — the render-count assertion proves it). The handlers
/// are stable (see SheetHandlers) and `svg` is a stable string per revision, so memo compares equal.
function PageSheetImpl({ page, svg, onClick, onDoubleClick, onPointerDown, onPointerMove, onPointerUp }: PageSheetProps) {
  bumpSheetRenderCount(); // dev-only; folded out of production bundles
  return (
    <div
      className="hw-sheet"
      data-page={page}
      onClick={(e) => onClick(page, e)}
      onDoubleClick={(e) => onDoubleClick(page, e)}
      onPointerDown={(e) => onPointerDown(page, e)}
      onPointerMove={(e) => onPointerMove(page, e)}
      onPointerUp={(e) => onPointerUp(page, e)}
      // R7: `svg` is the ONLY value ever handed to dangerouslySetInnerHTML, and it is always the output of
      // sanitizeSvg in HwpPageView below. No prop feeds this bypassing the gate.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
const PageSheet = memo(PageSheetImpl);

/// HwpPageView — renders EVERY page of the document as an inline SVG sheet with zoom. The SVG string
/// comes from `adapter.pageSvg(n)` and is ALWAYS routed through this package's `sanitizeSvg` before it
/// is injected via dangerouslySetInnerHTML (R7 — there is no prop that takes an SVG string directly).
/// A click is converted from client px to own-render PAGE px HERE (coords.ts), so the coordinate math
/// lives in one place and every backend's hit-test gets page-local px.
///
/// Each sheet is a memoized PageSheet (issue 030): a drag/marquee/toolbar state change re-renders the
/// lightweight overlay layer, NEVER the SVG sheets. The overlay closure is passed as `renderOverlay`.
export function HwpPageView(props: HwpPageViewProps) {
  const { adapter, pageCount, zoom = 1, refreshToken = 0, onPageClick, onPageDoubleClick, onPagePointerDown, onPagePointerMove, onPagePointerUp, renderOverlay } = props;
  const [pages, setPages] = useState<Record<number, PageState>>({});

  // Per-page RAW (pre-sanitize) svg cache, kept across refreshes so a refresh can compare each page's raw
  // string to its previous value and skip pages that didn't change (issue 034). It is tied to the current
  // adapter; an adapter swap (new document) invalidates it so every page re-injects. A ref (not state) so
  // updating it never itself triggers a render — the visible state lives in `pages`.
  const rawCacheRef = useRef<{ adapter: EngineAdapter | null; raw: Record<number, string> }>({ adapter: null, raw: {} });

  // Fetch every page's RAW svg, DIFF it against the previous raw string, and only sanitize+inject the
  // pages that actually changed (issue 034 — page-selective refresh). Why content-diff and not "compute
  // the edited page set": an edit can push content down (row growth → all later pages shift), so a naive
  // "only the edited page" set is wrong. Comparing raw strings is reflow-safe — a shifted page's string
  // differs, a truly-unchanged page's string is identical (025's wasm svg cache makes unchanged pages the
  // SAME string). The comparison is on the RAW string BEFORE sanitize, so an unchanged page pays neither
  // the sanitize (DOMParser+serialize) nor the setState/re-inject. Re-runs on doc/adapter/refresh/count.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const cache = rawCacheRef.current;
      // Adapter swap → the cached raw strings belong to a different document; drop them so every page is
      // treated as changed (full re-inject) for the new doc.
      if (cache.adapter !== adapter) {
        cache.adapter = adapter;
        cache.raw = {};
      }
      const prevRaw = cache.raw;
      const nextRaw: Record<number, string> = {};
      const changed: Record<number, PageState> = {};
      let anyChanged = false;
      for (let p = 0; p < pageCount; p++) {
        let raw: string;
        try {
          raw = await adapter.pageSvg(p);
        } catch {
          raw = ""; // a failed page renders blank, not a crash
        }
        if (cancelled) return;
        nextRaw[p] = raw;
        // Cheap string compare on the RAW svg — unchanged pages skip sanitize + setState entirely.
        if (p in prevRaw && prevRaw[p] === raw) {
          bumpPageSkipCount();
          continue;
        }
        // Changed (or brand-new) page: pay the sanitize gate exactly once, for this page only.
        try {
          const clean = sanitizeSvg(raw); // R7: the single injection gate
          const { w, h } = parseViewBox(clean);
          changed[p] = { svg: clean, vbW: w, vbH: h };
        } catch {
          changed[p] = { svg: "", vbW: 0, vbH: 0 };
        }
        bumpPageInjectCount();
        anyChanged = true;
      }
      if (cancelled) return;
      // Commit the raw cache (scoped to the live page count — trailing pages, if the doc shrank, are gone).
      cache.raw = nextRaw;
      // Rebuild `pages` REUSING the unchanged PageState object references (so each PageSheet's `svg` prop is
      // the identical string → React.memo holds → no re-render, no re-inject) and only swapping the changed
      // pages. If nothing changed AND the page count is unchanged, keep the same object so the parent doesn't
      // even re-render.
      setPages((prev) => {
        const hadExtra = Object.keys(prev).some((k) => Number(k) >= pageCount);
        if (!anyChanged && !hadExtra) return prev;
        const nextState: Record<number, PageState> = {};
        for (let p = 0; p < pageCount; p++) {
          nextState[p] = changed[p] ?? prev[p] ?? { svg: "", vbW: 0, vbH: 0 };
        }
        return nextState;
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [adapter, pageCount, refreshToken]);

  // Latest-`pages` ref so `eventToClick` reads the current viewBox WITHOUT depending on `pages` (issue 034):
  // a page-selective refresh changes `pages` on every edit, and if `eventToClick` (hence the five sheet
  // handlers) churned with it, EVERY PageSheet would re-render on every refresh (memo broken by new handler
  // refs) — defeating the "only the changed sheet re-renders" goal (§구현 5). Reading through a ref keeps
  // the handlers stable across refreshes, so skipped pages' sheets truly do not re-render.
  const pagesRef = useRef(pages);
  pagesRef.current = pages;

  // client px → own-render PAGE px for `page` (the ONE place §4.5 lives). null when the page isn't laid
  // out yet (zero dimension). Shared by the click and the pointer (marquee) paths. STABLE ([] deps) — it
  // reads live `pages` via the ref above, so handler identity survives a refresh.
  const eventToClick = useCallback(
    (page: number, ev: React.MouseEvent<HTMLDivElement> | React.PointerEvent<HTMLDivElement>): PageClick | null => {
      const svg = ev.currentTarget.querySelector("svg") as SVGSVGElement | null;
      if (!svg) return null;
      const rect = svg.getBoundingClientRect();
      const st = pagesRef.current[page];
      const vb = st && st.vbW > 0 ? { width: st.vbW, height: st.vbH } : { width: rect.width, height: rect.height };
      const pt = screenToPage(ev.clientX, ev.clientY, rect, vb);
      if (!pt) return null;
      return { page, x: pt.x, y: pt.y, meta: ev.metaKey || ev.ctrlKey, client: { x: ev.clientX, y: ev.clientY } };
    },
    [],
  );

  // The five sheet handlers, each STABLE (page arrives as an argument, not captured per-page) so
  // PageSheet's memo holds across selection/marquee churn AND across a page-selective refresh — they now
  // move only when the host swaps an on* prop, not when `pages` re-fetches (issue 034: eventToClick is [] ).
  const handleClick = useCallback(
    (page: number, ev: React.MouseEvent<HTMLDivElement>) => {
      if (!onPageClick) return;
      const c = eventToClick(page, ev);
      if (c) onPageClick(c);
    },
    [onPageClick, eventToClick],
  );

  const handleDoubleClick = useCallback(
    (page: number, ev: React.MouseEvent<HTMLDivElement>) => {
      if (!onPageDoubleClick) return;
      const c = eventToClick(page, ev);
      if (c) onPageDoubleClick(c);
    },
    [onPageDoubleClick, eventToClick],
  );

  const handlePointerDown = useCallback(
    (page: number, ev: React.PointerEvent<HTMLDivElement>) => {
      if (!onPagePointerDown || ev.button !== 0) return; // primary button only
      const c = eventToClick(page, ev);
      if (!c) return;
      // Capture so a drag that leaves the sheet still reports move/up here (marquee clips to this page).
      try {
        ev.currentTarget.setPointerCapture?.(ev.pointerId);
      } catch {
        /* jsdom / unsupported — capture is a nicety, not required */
      }
      onPagePointerDown(c, ev);
    },
    [onPagePointerDown, eventToClick],
  );

  const handlePointerMove = useCallback(
    (page: number, ev: React.PointerEvent<HTMLDivElement>) => {
      if (!onPagePointerMove || ev.buttons === 0) return; // only while a button is held (a drag)
      const c = eventToClick(page, ev);
      if (c) onPagePointerMove(c, ev);
    },
    [onPagePointerMove, eventToClick],
  );

  const handlePointerUp = useCallback(
    (page: number, ev: React.PointerEvent<HTMLDivElement>) => {
      if (!onPagePointerUp) return;
      const c = eventToClick(page, ev);
      if (c) onPagePointerUp(c, ev);
    },
    [onPagePointerUp, eventToClick],
  );

  const width = A4_W * zoom;

  return (
    <div className="hw-pages">
      {Array.from({ length: pageCount }, (_, p) => {
        const st = pages[p];
        const scale = st && st.vbW > 0 ? width / st.vbW : 1;
        return (
          <div key={p} className="hw-sheet-wrap" style={{ width }}>
            <PageSheet
              page={p}
              svg={st?.svg ?? ""}
              onClick={handleClick}
              onDoubleClick={handleDoubleClick}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
            />
            {renderOverlay?.(p, scale)}
          </div>
        );
      })}
    </div>
  );
}
