import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { EngineAdapter, OutlineItem } from "@tf-hwp/editor-core";
import { activeOutlineIndex } from "../outline";
import { sanitizeSvg } from "../sanitize";

export interface OutlinePanelProps {
  /** The document outline (engine headings). When empty, the panel shows a PAGE THUMBNAIL rail (a live,
   *  PDF-viewer-style preview of each page — issue 046 §함정: 빈 패널 금지) so a document with no detected
   *  heading still gets a working, visual page navigator. */
  items: OutlineItem[];
  /** Total page count — drives the thumbnail rail / page-list fallback and bounds the current-page highlight. */
  pageCount: number;
  /** The page currently at the top of the viewport (0-based) — a SCROLL-POSITION calc from the workspace,
   *  independent of the 037 virtualization visible set. Highlights the outline item / thumbnail that contains it. */
  currentPage: number;
  /** Collapsed = a thin rail with only the expand affordance (state remembered by the host, issue 046). */
  collapsed: boolean;
  /** Toggle collapsed/expanded (the host persists it to localStorage). */
  onToggleCollapse: () => void;
  /** Jump to a page (0-based). The host wires this to its EXISTING scroll source (no new arithmetic —
   *  issue 046: 035 줌과 정합) so the outline and the page view share one scroll path. */
  onJump: (page: number) => void;
  /** The engine adapter — the thumbnail rail pulls each page's own-render SVG via `adapter.pageSvg(p)` to
   *  build a live preview. OPTIONAL: with no adapter (or a rendererless backend) the page mode degrades to a
   *  plain page-number list, so this stays a working navigator either way. The SVG is ALWAYS passed through
   *  `sanitizeSvg` and handed to an `<img>` (raster) — it is NEVER injected as markup (R7). */
  adapter?: EngineAdapter;
  /** Bumped on every layout invalidation (post-edit). Invalidates each cached thumbnail so an edit re-rasters
   *  the affected pages (unchanged pages are skipped by a raw-string compare, mirroring 034). */
  refreshToken?: number;
}

// A4 @ 96dpi in CSS px — the aspect-ratio fallback for a thumbnail BEFORE its real viewBox is known.
const THUMB_A4_W = 794;
const THUMB_A4_H = 1123;
// Lazy-load tuning: seed the first few thumbnails so the rail top paints immediately; keep ± this many px of
// thumbnails rasterized around the rail viewport. Mirrors HwpPageView's 037 virtualization philosophy.
const THUMB_SEED = 6;
const THUMB_BUFFER_PX = 1200;

/** Parse the own-render px viewBox from an SVG string to fix a thumbnail's aspect ratio (own-render SVGs
 *  carry `viewBox="0 0 W H"`). Falls back to A4 so the placeholder frame has a sensible shape pre-load. */
function thumbViewBox(svg: string): { w: number; h: number } {
  const vb = /viewBox\s*=\s*["']\s*[\d.]+\s+[\d.]+\s+([\d.]+)\s+([\d.]+)/i.exec(svg);
  if (vb) return { w: parseFloat(vb[1]), h: parseFloat(vb[2]) };
  return { w: THUMB_A4_W, h: THUMB_A4_H };
}

interface PageThumbProps {
  adapter: EngineAdapter;
  page: number;
  /** Bumped by the host on every layout invalidation → re-fetch + (if the raw svg changed) re-raster. */
  refreshToken: number;
  /** Near-viewport gate (issue 037-style): only a thumbnail told to load pays the fetch + rasterize. */
  load: boolean;
  active: boolean;
  onJump: (page: number) => void;
}

/// PageThumb — ONE page's live preview: fetch `adapter.pageSvg(page)`, run it through `sanitizeSvg` (R7 —
/// the single injection gate), then hand the CLEAN svg to an `<img>` via a `Blob` object URL. Raster (an
/// `<img>`) not inline svg on purpose: a 12-page rail costs 12 image nodes, not the thousands of duplicated
/// svg nodes inline injection would add. Memoized on its props so a scroll/hover/highlight tick elsewhere in
/// the rail never re-rasterizes it; the object URL is revoked when superseded or on unmount (no leak).
function PageThumbImpl({ adapter, page, refreshToken, load, active, onJump }: PageThumbProps) {
  const [thumb, setThumb] = useState<{ url: string; w: number; h: number } | null>(null);
  // Last RAW svg + last object URL — a 034-style compare skips re-rastering a page whose svg didn't change
  // on a refresh, and lets us revoke the SUPERSEDED blob only once the new one is ready (no img flicker).
  const rawRef = useRef<string | null>(null);
  const urlRef = useRef<string | null>(null);

  useEffect(() => {
    if (!load) return;
    let cancelled = false;
    (async () => {
      let raw: string;
      try {
        raw = await adapter.pageSvg(page);
      } catch {
        raw = ""; // a failed page shows the skeleton, not a crash
      }
      if (cancelled) return;
      // Unchanged since the last load → keep the existing blob (mirrors HwpPageView's raw-diff, issue 034).
      if (rawRef.current === raw && urlRef.current) return;
      rawRef.current = raw;
      const clean = sanitizeSvg(raw); // R7: the single injection gate — the rail NEVER injects raw svg.
      if (!clean) {
        setThumb(null);
        return;
      }
      const { w, h } = thumbViewBox(clean);
      const next = URL.createObjectURL(new Blob([clean], { type: "image/svg+xml" }));
      if (cancelled) {
        URL.revokeObjectURL(next);
        return;
      }
      if (urlRef.current) URL.revokeObjectURL(urlRef.current); // free the blob this render supersedes
      urlRef.current = next;
      setThumb({ url: next, w, h });
    })();
    return () => {
      cancelled = true;
    };
  }, [adapter, page, refreshToken, load]);

  // Revoke the last object URL when the thumbnail unmounts (rail collapsed, doc closed) — no dangling blobs.
  useEffect(
    () => () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    },
    [],
  );

  const ratio = thumb ? `${thumb.w} / ${thumb.h}` : `${THUMB_A4_W} / ${THUMB_A4_H}`;
  return (
    <button
      className={`hw-outline-item hw-outline-thumb-item${active ? " hw-outline-active" : ""}`}
      data-testid="hw-outline-item"
      data-page={page}
      aria-current={active ? "true" : undefined}
      aria-label={`${page + 1}쪽`}
      onClick={() => onJump(page)}
    >
      <span className="hw-thumb-frame" style={{ aspectRatio: ratio }}>
        {thumb ? (
          // alt="" — the neighbouring page number is the accessible label (aria-label on the button).
          <img className="hw-thumb-img" src={thumb.url} alt="" draggable={false} data-testid="hw-outline-thumb" />
        ) : (
          <span className="hw-thumb-skeleton" aria-hidden />
        )}
      </span>
      <span className="hw-thumb-page">{page + 1}쪽</span>
    </button>
  );
}
const PageThumb = memo(PageThumbImpl);

/// OutlinePanel — the left, collapsible document-structure nav (issue 046, TAURI-CONVERGENCE U4 승격). It
/// lists the engine's top-level headings (□/■ section labels + numbered section-band tables); clicking one
/// scrolls the page view to that heading's page, and the item on the current page is highlighted as you
/// scroll. A document with NO detected heading falls back to a PDF-viewer-style PAGE THUMBNAIL rail (live
/// per-page previews, click-to-scroll, active-page highlight) — never an empty panel.
///
/// The heading list is pure presentation (the parent resolves `items`/`currentPage` + `onJump`). The
/// thumbnail rail is the one place this component reaches the engine: it pulls each page's own-render SVG
/// via `adapter.pageSvg`, always through `sanitizeSvg` (R7), rasterizes it to an `<img>`, and lazy-loads
/// near-viewport thumbnails (IntersectionObserver) so a 12+ page doc never rasterizes everything at once.
/// The rail is self-contained (issue 030): its scroll/hover/load state re-renders only the rail, never the
/// main page view.
export function OutlinePanel(props: OutlinePanelProps) {
  const { items, pageCount, currentPage, collapsed, onToggleCollapse, onJump, adapter, refreshToken = 0 } = props;

  // The active heading = the last one whose start page is at/before the current page (pure, testable).
  const activeIdx = useMemo(() => activeOutlineIndex(items, currentPage), [items, currentPage]);
  const hasHeadings = items.length > 0;
  // Thumbnails replace the plain page-list fallback whenever a renderer (adapter) is available.
  const thumbnailMode = !hasHeadings && !!adapter;
  // Lazy-load only when a real IntersectionObserver exists (jsdom lacks one → eager, like HwpPageView's 034
  // all-visible fallback), so tests render every thumbnail deterministically.
  const lazy = thumbnailMode && typeof IntersectionObserver !== "undefined";

  const railRef = useRef<HTMLElement | null>(null);
  // The set of thumbnails allowed to rasterize (near the rail viewport). It only GROWS — a loaded thumbnail
  // is one cheap <img>, so we never unmount it back to a skeleton on re-scroll.
  const [loaded, setLoaded] = useState<Set<number>>(() => new Set());

  // Seed the first screenful so the rail top paints immediately (without waiting for the observer's first,
  // async callback). Re-seeds when the doc (pageCount) changes or thumbnail mode toggles.
  useEffect(() => {
    if (!lazy) {
      setLoaded(new Set());
      return;
    }
    const s = new Set<number>();
    for (let i = 0; i < Math.min(THUMB_SEED, pageCount); i++) s.add(i);
    setLoaded(s);
  }, [lazy, pageCount]);

  // IntersectionObserver over the thumbnail buttons (root = the rail's own scroll container), adding pages to
  // `loaded` as they approach the viewport. `collapsed` is a dep so the observer re-attaches after the rail is
  // expanded (its elements only exist then). No-op unless in lazy thumbnail mode.
  useEffect(() => {
    if (!lazy || collapsed) return;
    const rail = railRef.current;
    if (!rail) return;
    const io = new IntersectionObserver(
      (entries) => {
        setLoaded((prev) => {
          let next = prev;
          let changed = false;
          for (const e of entries) {
            if (!e.isIntersecting) continue;
            const attr = (e.target as HTMLElement).getAttribute("data-page");
            if (attr == null) continue;
            const p = Number(attr);
            if (!prev.has(p)) {
              if (!changed) {
                next = new Set(prev);
                changed = true;
              }
              next.add(p);
            }
          }
          return changed ? next : prev; // one commit per callback
        });
      },
      { root: rail, rootMargin: `${THUMB_BUFFER_PX}px 0px ${THUMB_BUFFER_PX}px 0px`, threshold: 0 },
    );
    rail.querySelectorAll("[data-page]").forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [lazy, collapsed, pageCount]);

  if (collapsed) {
    return (
      <aside className="hw-outline hw-outline-collapsed" data-testid="hw-outline">
        <button
          className="hw-outline-expand"
          data-testid="hw-outline-toggle"
          onClick={onToggleCollapse}
          title="문서 구조 펼치기"
          aria-label="문서 구조 펼치기"
          aria-expanded={false}
        >
          ☰
        </button>
      </aside>
    );
  }

  return (
    <aside className="hw-outline" data-testid="hw-outline">
      <div className="hw-outline-head">
        <span className="hw-outline-title">문서 구조</span>
        <button
          className="hw-outline-collapse"
          data-testid="hw-outline-toggle"
          onClick={onToggleCollapse}
          title="문서 구조 접기"
          aria-label="문서 구조 접기"
          aria-expanded={true}
        >
          ‹
        </button>
      </div>
      <nav
        ref={railRef}
        className={`hw-outline-list${thumbnailMode ? " hw-outline-thumbs" : ""}`}
        data-testid="hw-outline-list"
        aria-label="문서 구조"
      >
        {hasHeadings
          ? items.map((it, i) => (
              <button
                key={`${it.section}:${it.block}:${i}`}
                className={`hw-outline-item hw-outline-l${it.level}${i === activeIdx ? " hw-outline-active" : ""}`}
                data-testid="hw-outline-item"
                data-page={it.page}
                aria-current={i === activeIdx ? "true" : undefined}
                onClick={() => onJump(it.page)}
                title={it.text}
              >
                <span className="hw-outline-text">{it.text}</span>
                <span className="hw-outline-page">{it.page + 1}</span>
              </button>
            ))
          : thumbnailMode
            ? // 빈 패널 금지 (issue 046 §함정): 제목이 없는 문서는 PDF 뷰어식 페이지 썸네일 레일로 폴백.
              Array.from({ length: Math.max(pageCount, 0) }, (_, p) => (
                <PageThumb
                  key={p}
                  adapter={adapter!}
                  page={p}
                  refreshToken={refreshToken}
                  load={!lazy || loaded.has(p)}
                  active={p === currentPage}
                  onJump={onJump}
                />
              ))
            : // No renderer available → a plain page-number list still navigates (graceful degradation).
              Array.from({ length: Math.max(pageCount, 0) }, (_, p) => (
                <button
                  key={p}
                  className={`hw-outline-item hw-outline-page-item${p === currentPage ? " hw-outline-active" : ""}`}
                  data-testid="hw-outline-item"
                  data-page={p}
                  aria-current={p === currentPage ? "true" : undefined}
                  onClick={() => onJump(p)}
                >
                  <span className="hw-outline-text">{p + 1}쪽</span>
                </button>
              ))}
      </nav>
    </aside>
  );
}
