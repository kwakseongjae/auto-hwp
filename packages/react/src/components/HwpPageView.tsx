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
const A4_RATIO = 1123 / 794; // page height/width; the placeholder aspect fallback before a real viewBox is known

// ── issue 037: page-virtualization tuning ───────────────────────────────────────────────────────────
/** Virtualize (mount only the pages near the viewport) ONLY for docs big enough that the all-mounted DOM
 *  cost matters. Small docs mount fully — the observer overhead + placeholder swaps would be pure cost with
 *  no benefit, and every existing fixture (benchmark.hwp = 8p, all vitest mocks ≤ 8p) stays byte-for-byte on
 *  the 034 render path. The 25-page acceptance target is comfortably above this. */
const VIRTUALIZE_MIN_PAGES = 12;
/** How much to keep mounted ABOVE and BELOW the scroll viewport, in CSS px. A page is therefore rendered
 *  ~1.4 pages before it scrolls into the true viewport (no blank-on-scroll), while the 25p acceptance
 *  measurement (1000px-tall viewport) still holds ≤ 6 SVG sheets mounted. */
const BUFFER_PX = 1600;
/** First-screenful seed so open() paints the top pages immediately, without waiting for the observer's
 *  first (async) callback. Kept ≤ 6 so the mounted-SVG count never breaks the acceptance ceiling even in
 *  the pre-settle instant. */
const SEED_PAGES = 6;

/** Measurement/debug escape hatch (issue 037): when `globalThis.__hwVirtDisabled === true`, virtualization is
 *  forced OFF (every page mounts). The 037 measurement harness flips this to capture the BEFORE (all-mounted)
 *  census and then flips it back for the AFTER — on the very same DOM, in the same session. Unlike the R7
 *  sanitize gate this is NOT security-sensitive: it can only make the view mount MORE (the pre-037 behaviour),
 *  never inject anything, so it is intentionally readable in the production bundle (opt-in, defaults off). */
function virtualizationDisabled(): boolean {
  return (globalThis as { __hwVirtDisabled?: boolean }).__hwVirtDisabled === true;
}

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

/// PagePlaceholder — a page currently OUTSIDE the viewport buffer (issue 037: page virtualization). It keeps
/// the parts of the sheet DOM contract that OFF-component code depends on — the `.hw-sheet` class + `data-page`
/// (so scrollCellIntoView/jumpToPage still resolve it) and the EXACT rendered height (so unmounting the heavy
/// SVG never shifts the scrollbar) — but injects NO svg, so it costs ~1 DOM node instead of the ~800 a real
/// sheet does. Memoized on (page, height) so a scroll/selection/marquee tick never re-renders it. It
/// deliberately does NOT bump the SVG-sheet render counter (issue 030): only real SVG sheets are the heavy
/// thing that must stay flat during a drag, and a placeholder is not one.
function PagePlaceholderImpl({ page, height }: { page: number; height: number }) {
  return <div className="hw-sheet hw-sheet-placeholder" data-page={page} style={{ height }} aria-hidden />;
}
const PagePlaceholder = memo(PagePlaceholderImpl);

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

  // ── issue 037: page virtualization ────────────────────────────────────────────────────────────────
  // Docs large enough to matter keep only the pages near the viewport (± BUFFER_PX) mounted as heavy SVG
  // sheets; every other page is a same-size blank placeholder (data-page + exact height retained), so the
  // 25p DOM drops from ~19,825 elements (all 25 sheets) to a handful. Small docs and any environment WITHOUT
  // IntersectionObserver (jsdom) fall back to "everything visible" — byte-for-byte the 034 render path, so
  // every existing selection/edit/zoom/pan test is untouched.
  const virtualize = pageCount > VIRTUALIZE_MIN_PAGES && typeof IntersectionObserver !== "undefined" && !virtualizationDisabled();

  // The set of pages currently intersecting the scroll viewport (± BUFFER_PX). Seeded with the first
  // screenful so open() paints the top pages immediately (the observer's first callback is async). When
  // `virtualize` is false this set is IGNORED (isVis short-circuits to true), so it never perturbs the 034
  // fixtures. A page NOT in the set renders as a placeholder.
  const [visible, setVisible] = useState<Set<number>>(() => {
    const s = new Set<number>();
    for (let i = 0; i < SEED_PAGES; i++) s.add(i);
    return s;
  });
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  // A page is "visible" (gets a real SVG sheet) when virtualization is off OR it's in the observed set. Read
  // through the ref so the async refresh effect below sees the LATEST visibility without depending on it.
  const isVis = useCallback((p: number) => !virtualize || visibleRef.current.has(p), [virtualize]);

  // Pages whose RAW svg CHANGED while OFF-SCREEN: their sanitize+inject is DEFERRED until they scroll back
  // into view (issue 037 §034정합). A ref (not state) — flipping dirty must not itself render; the deferred
  // inject is driven by the visibility effect below. `__hwPageInject` still counts ONLY real injections, so
  // an off-screen edit marks dirty (no inject) and the eventual re-entry pays exactly one inject.
  const dirtyRef = useRef<Set<number>>(new Set());

  // The pages container — its closest `.hw-canvas` ancestor is the scroll root the observer watches.
  const pagesElRef = useRef<HTMLDivElement | null>(null);

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
      // Adapter swap → the cached raw strings belong to a different document; drop them (and any deferred
      // dirty marks) so every page is treated as changed (full re-inject) for the new doc.
      if (cache.adapter !== adapter) {
        cache.adapter = adapter;
        cache.raw = {};
        dirtyRef.current = new Set();
      }
      const prevRaw = cache.raw;
      const nextRaw: Record<number, string> = {};
      const sanitized: Record<number, PageState> = {}; // visible ∩ changed → sanitized + injected NOW
      const dimsOnly: Record<number, { w: number; h: number }> = {}; // off-screen ∩ changed → dims only (deferred sanitize)
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
        // 034 CONTRACT (issue 037 §함정): DIFF every page's raw — keep the cache WHOLE so re-entry never
        // misjudges "unchanged". Narrowing the diff/cache to visible pages would make an off-screen edit
        // look unchanged on re-entry. The compare is on the RAW string BEFORE sanitize, so an unchanged
        // page pays neither the sanitize nor a setState.
        if (p in prevRaw && prevRaw[p] === raw) {
          bumpPageSkipCount();
          continue;
        }
        // Changed (or brand-new). VISIBLE → pay the sanitize gate + inject now (one inject). OFF-SCREEN →
        // DEFER the sanitize (mark dirty) and record only the cheap dimensions (regex on RAW, no DOMParser,
        // no inject) so the placeholder keeps exact size. The deferred sanitize fires on re-entry below.
        if (isVis(p)) {
          try {
            const clean = sanitizeSvg(raw); // R7: the single injection gate
            const { w, h } = parseViewBox(clean);
            sanitized[p] = { svg: clean, vbW: w, vbH: h };
          } catch {
            sanitized[p] = { svg: "", vbW: 0, vbH: 0 };
          }
          bumpPageInjectCount();
          dirtyRef.current.delete(p);
        } else {
          dirtyRef.current.add(p);
          const { w, h } = parseViewBox(raw);
          dimsOnly[p] = { w, h };
        }
        anyChanged = true;
      }
      if (cancelled) return;
      // Commit the raw cache (scoped to the live page count — trailing pages, if the doc shrank, are gone).
      cache.raw = nextRaw;
      // Rebuild `pages` REUSING unchanged PageState object references (so each PageSheet's `svg` prop is the
      // identical string → React.memo holds → no re-render). Visible+changed pages take their freshly
      // sanitized state; off-screen+changed pages take ONLY new dims while RETAINING any prior svg (so a
      // re-entry can flash the cached render before the deferred sanitize corrects it). If nothing changed
      // AND the page count is unchanged, keep the same object so the parent doesn't even re-render.
      setPages((prev) => {
        const hadExtra = Object.keys(prev).some((k) => Number(k) >= pageCount);
        if (!anyChanged && !hadExtra) return prev;
        const nextState: Record<number, PageState> = {};
        for (let p = 0; p < pageCount; p++) {
          if (sanitized[p]) nextState[p] = sanitized[p];
          else if (dimsOnly[p]) nextState[p] = { svg: prev[p]?.svg ?? "", vbW: dimsOnly[p].w, vbH: dimsOnly[p].h };
          else nextState[p] = prev[p] ?? { svg: "", vbW: 0, vbH: 0 };
        }
        return nextState;
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [adapter, pageCount, refreshToken, isVis]);

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

  // ── issue 037: IntersectionObserver wiring ────────────────────────────────────────────────────────
  // ONE batched commit per observer callback (issue 037 §함정: no setState storm). Each entry maps back to
  // its page via the `data-page` on the observed `.hw-sheet-wrap`; we add newly-intersecting pages and drop
  // ones that scrolled out. STABLE ([] deps) so the observer isn't re-created on every render.
  const onIntersect = useCallback<IntersectionObserverCallback>((entries) => {
    setVisible((prev) => {
      let next = prev;
      let changed = false;
      for (const e of entries) {
        const attr = (e.target as HTMLElement).getAttribute("data-page");
        if (attr == null) continue;
        const p = Number(attr);
        if (e.isIntersecting) {
          if (!prev.has(p)) {
            if (!changed) { next = new Set(prev); changed = true; }
            next.add(p);
          }
        } else if (prev.has(p)) {
          if (!changed) { next = new Set(prev); changed = true; }
          next.delete(p);
        }
      }
      return changed ? next : prev; // one commit per callback
    });
  }, []);

  // Create the observer over every `.hw-sheet-wrap`, re-creating it when the page count changes (new wraps
  // must be observed) or virtualization toggles. `root` = the `.hw-canvas` scroll container so the buffer is
  // measured against the real viewport; `rootMargin` keeps ± BUFFER_PX of pages mounted. No-op when
  // virtualization is off or IntersectionObserver is absent (jsdom) — the 034 all-visible fallback stands.
  useEffect(() => {
    if (!virtualize) return;
    const container = pagesElRef.current;
    if (!container || typeof IntersectionObserver === "undefined") return;
    const root = container.closest(".hw-canvas");
    const io = new IntersectionObserver(onIntersect, {
      root: root ?? null,
      rootMargin: `${BUFFER_PX}px 0px ${BUFFER_PX}px 0px`,
      threshold: 0,
    });
    container.querySelectorAll(".hw-sheet-wrap").forEach((w) => io.observe(w));
    return () => io.disconnect();
  }, [virtualize, pageCount, onIntersect]);

  // Deferred sanitize on RE-ENTRY (issue 037 §034정합 — dirty 재진입 시 주입): pay the sanitize + inject
  // exactly ONCE for any page that is DIRTY (changed/never-sanitized off-screen) and now effectively VISIBLE
  // (raw is already cached — no re-fetch). Runs when the visible set changes OR when virtualization toggles
  // — e.g. a doc that shrinks back under the threshold flips `virtualize` off → isVis becomes true for every
  // page → any still-deferred page injects here, so nothing is left blank. Batched into a single setPages.
  useEffect(() => {
    if (dirtyRef.current.size === 0) return;
    const raw = rawCacheRef.current.raw;
    const inj: Record<number, PageState> = {};
    let any = false;
    for (const p of Array.from(dirtyRef.current)) {
      if (!isVis(p)) continue;
      const r = raw[p];
      if (r == null) continue; // raw not fetched yet — the refresh effect will inject it directly
      try {
        const clean = sanitizeSvg(r); // R7: the single injection gate
        const { w, h } = parseViewBox(clean);
        inj[p] = { svg: clean, vbW: w, vbH: h };
      } catch {
        inj[p] = { svg: "", vbW: 0, vbH: 0 };
      }
      bumpPageInjectCount();
      dirtyRef.current.delete(p);
      any = true;
    }
    if (any) setPages((prev) => ({ ...prev, ...inj }));
  }, [visible, virtualize, isVis]);

  const width = A4_W * zoom;

  return (
    <div className="hw-pages" ref={pagesElRef}>
      {Array.from({ length: pageCount }, (_, p) => {
        const st = pages[p];
        const scale = st && st.vbW > 0 ? width / st.vbW : 1;
        const vis = isVis(p);
        // Placeholder height MUST equal the rendered SVG height (sheet width × vbH/vbW) so unmounting a page
        // never shifts scroll geometry; it scales with `width` (= A4_W × zoom), so it tracks zoom exactly.
        // Falls back to the A4 aspect until the real viewBox is known (first paint before the async refresh).
        const phHeight = st && st.vbW > 0 ? (width * st.vbH) / st.vbW : width * A4_RATIO;
        // The `.hw-sheet-wrap` carries `data-page` so the observer can map an entry back to its page (the
        // inner `.hw-sheet` also carries it, for scrollCellIntoView/jumpToPage — distinct selectors).
        return (
          <div key={p} className="hw-sheet-wrap" data-page={p} style={{ width }}>
            {vis ? (
              <PageSheet
                page={p}
                svg={st?.svg ?? ""}
                onClick={handleClick}
                onDoubleClick={handleDoubleClick}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
              />
            ) : (
              <PagePlaceholder page={p} height={phHeight} />
            )}
            {renderOverlay?.(p, scale)}
          </div>
        );
      })}
    </div>
  );
}
