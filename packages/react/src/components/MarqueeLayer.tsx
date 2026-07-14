import { useEffect, useRef, useState } from "react";
import type { EditorCore, SelMarquee } from "@tf-hwp/editor-core";

export interface MarqueeLayerProps {
  /** The headless editor core — MarqueeLayer subscribes to its selection model DIRECTLY (issue 030). */
  core: EditorCore;
  /** The page this layer belongs to. A multi-page marquee draws THIS page's own slice; a single-page
   *  marquee draws only on its start page. */
  page: number;
  /** rendered px / viewBox px for this page (page-px → client-px). Stable during a drag; only zoom moves it. */
  scale: number;
}

/** The own-render PAGE-px box this page should draw for a marquee: its own entry in a MULTI-PAGE marquee
 *  (`boxes`), else the single-page `box` iff the marquee lives on this page. `null` = draw nothing here. */
function sliceBoxFor(m: SelMarquee, page: number): SelMarquee["box"] | null {
  if (m.boxes && m.boxes.length > 0) {
    const s = m.boxes.find((b) => b.page === page);
    return s ? s.box : null;
  }
  return m.page === page ? m.box : null;
}

// rAF with a jsdom/SSR-safe fallback (jsdom under vitest ships rAF, but never assume it).
const raf: (cb: FrameRequestCallback) => number =
  typeof requestAnimationFrame === "function" ? requestAnimationFrame : (cb) => setTimeout(() => cb(0), 0) as unknown as number;
const caf: (id: number) => void = typeof cancelAnimationFrame === "function" ? cancelAnimationFrame : (id) => clearTimeout(id);

/// MarqueeLayer — the rubber-band rectangle, ISOLATED from the workspace/sheet render path (issue 030).
///
/// The old path mirrored the marquee into a workspace `useState`, so every pointermove re-rendered the
/// WHOLE workspace (18 SVG sheets + every overlay). Here the marquee is decoupled: this tiny component
/// subscribes to `core.selection.onMarqueeChange` itself, so a drag re-renders nothing above it.
///
/// Two channels, on purpose:
///  · PRESENCE (mount / unmount of the div) rides a `useState` — it flips only ~twice per gesture (marquee
///    starts, marquee ends), so React commits are negligible AND `.hw-marquee` is genuinely absent when
///    idle (the selection tests assert exactly that).
///  · POSITION (the rect's left/top/width/height as it sweeps) is written straight to the DOM via a ref,
///    rAF-coalesced — so the 2nd…Nth pointermove of a drag re-render NOTHING (React bails the same-value
///    setState) yet the rectangle still tracks the cursor at 60fps.
export function MarqueeLayer({ core, page, scale }: MarqueeLayerProps) {
  const [active, setActive] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const pendingRef = useRef<SelMarquee | null>(null);

  // Write the pending rect straight to the div (no React re-render). Kept in a ref so the rAF callback
  // always sees the latest scale/page without re-subscribing.
  const flushRef = useRef<() => void>(() => {});
  flushRef.current = () => {
    rafRef.current = null;
    const el = ref.current;
    const m = pendingRef.current;
    const box = m ? sliceBoxFor(m, page) : null;
    if (!el || !box) return;
    el.style.left = `${box.x * scale}px`;
    el.style.top = `${box.y * scale}px`;
    el.style.width = `${box.w * scale}px`;
    el.style.height = `${box.h * scale}px`;
  };

  useEffect(() => {
    const onMarquee = (m: SelMarquee | null) => {
      const mine = !!m && sliceBoxFor(m, page) != null;
      pendingRef.current = mine ? m : null;
      setActive(mine); // same-value flips bail out of a re-render (React), so moves 2…N cost nothing
      if (mine && rafRef.current == null) rafRef.current = raf(() => flushRef.current());
    };
    onMarquee(core.selection.getMarquee()); // sync the current state on mount / core|page|scale change
    const off = core.selection.onMarqueeChange(onMarquee);
    return () => {
      off();
      if (rafRef.current != null) {
        caf(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [core, page, scale]);

  // On first activation the div doesn't exist until the next commit; position it once it's mounted (and on
  // a zoom change while a drag is live). Subsequent moves position it via the rAF flush above.
  useEffect(() => {
    if (active) flushRef.current();
  }, [active, scale]);

  if (!active) return null;
  return <div ref={ref} className="hw-marquee" style={{ position: "absolute" }} aria-hidden />;
}
