import { useCallback, useEffect, useState } from "react";
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

/// HwpPageView — renders EVERY page of the document as an inline SVG sheet with zoom. The SVG string
/// comes from `adapter.pageSvg(n)` and is ALWAYS routed through this package's `sanitizeSvg` before it
/// is injected via dangerouslySetInnerHTML (R7 — there is no prop that takes an SVG string directly).
/// A click is converted from client px to own-render PAGE px HERE (coords.ts), so the coordinate math
/// lives in one place and every backend's hit-test gets page-local px.
export function HwpPageView(props: HwpPageViewProps) {
  const { adapter, pageCount, zoom = 1, refreshToken = 0, onPageClick, onPagePointerDown, onPagePointerMove, onPagePointerUp, renderOverlay } = props;
  const [pages, setPages] = useState<Record<number, PageState>>({});

  // Fetch + sanitize every page's SVG. Re-runs when the doc/adapter/refreshToken/pageCount changes.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const next: Record<number, PageState> = {};
      for (let p = 0; p < pageCount; p++) {
        try {
          const clean = sanitizeSvg(await adapter.pageSvg(p)); // R7: the single injection gate
          const { w, h } = parseViewBox(clean);
          next[p] = { svg: clean, vbW: w, vbH: h };
        } catch {
          next[p] = { svg: "", vbW: 0, vbH: 0 }; // a failed page renders blank, not a crash
        }
        if (cancelled) return;
      }
      if (!cancelled) setPages(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [adapter, pageCount, refreshToken]);

  // client px → own-render PAGE px for `page` (the ONE place §4.5 lives). null when the page isn't laid
  // out yet (zero dimension). Shared by the click and the pointer (marquee) paths.
  const eventToClick = useCallback(
    (page: number, ev: React.MouseEvent<HTMLDivElement> | React.PointerEvent<HTMLDivElement>): PageClick | null => {
      const svg = ev.currentTarget.querySelector("svg") as SVGSVGElement | null;
      if (!svg) return null;
      const rect = svg.getBoundingClientRect();
      const st = pages[page];
      const vb = st && st.vbW > 0 ? { width: st.vbW, height: st.vbH } : { width: rect.width, height: rect.height };
      const pt = screenToPage(ev.clientX, ev.clientY, rect, vb);
      if (!pt) return null;
      return { page, x: pt.x, y: pt.y, meta: ev.metaKey || ev.ctrlKey, client: { x: ev.clientX, y: ev.clientY } };
    },
    [pages],
  );

  const handleClick = useCallback(
    (page: number) => (ev: React.MouseEvent<HTMLDivElement>) => {
      if (!onPageClick) return;
      const c = eventToClick(page, ev);
      if (c) onPageClick(c);
    },
    [onPageClick, eventToClick],
  );

  const handlePointerDown = useCallback(
    (page: number) => (ev: React.PointerEvent<HTMLDivElement>) => {
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
    (page: number) => (ev: React.PointerEvent<HTMLDivElement>) => {
      if (!onPagePointerMove || ev.buttons === 0) return; // only while a button is held (a drag)
      const c = eventToClick(page, ev);
      if (c) onPagePointerMove(c, ev);
    },
    [onPagePointerMove, eventToClick],
  );

  const handlePointerUp = useCallback(
    (page: number) => (ev: React.PointerEvent<HTMLDivElement>) => {
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
            <div
              className="hw-sheet"
              data-page={p}
              onClick={handleClick(p)}
              onPointerDown={handlePointerDown(p)}
              onPointerMove={handlePointerMove(p)}
              onPointerUp={handlePointerUp(p)}
              // R7: `st.svg` is the ONLY value ever handed to dangerouslySetInnerHTML, and it is always
              // the output of sanitizeSvg above. No prop feeds this bypassing the gate.
              dangerouslySetInnerHTML={{ __html: st?.svg ?? "" }}
            />
            {renderOverlay?.(p, scale)}
          </div>
        );
      })}
    </div>
  );
}
