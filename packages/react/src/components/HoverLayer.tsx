import { useEffect, useRef, useState } from "react";
import { bumpHoverLayerRenderCount, type HoverHighlight, type HoverStore } from "../hover";

export interface HoverLayerProps {
  /** The hover store (from `useHover`) — HoverLayer subscribes to it DIRECTLY (issue 038). */
  store: HoverStore;
  /** The page this layer belongs to (the highlight clips to its page — one HoverLayer per sheet). */
  page: number;
  /** rendered px / viewBox px for this page (page-px → client-px). Stable during a hover; only zoom moves it. */
  scale: number;
}

// rAF with a jsdom/SSR-safe fallback (mirrors MarqueeLayer).
const raf: (cb: FrameRequestCallback) => number =
  typeof requestAnimationFrame === "function" ? requestAnimationFrame : (cb) => setTimeout(() => cb(0), 0) as unknown as number;
const caf: (id: number) => void = typeof cancelAnimationFrame === "function" ? cancelAnimationFrame : (id) => clearTimeout(id);

/// HoverLayer — the pre-highlight rectangle (issue 038 FG-09), the exact structural twin of MarqueeLayer:
/// a tiny per-page layer that subscribes to a store itself, so a hover move re-renders NOTHING above it.
///
/// Two channels, on purpose (same as MarqueeLayer):
///  · PRESENCE (mount / unmount of the div) rides a `useState` — it flips only when the highlight enters or
///    leaves THIS page, so React commits are negligible AND `.hw-hover` is genuinely absent when idle.
///  · POSITION + kind (left/top/width/height + the kind class) are written straight to the DOM via a ref,
///    rAF-coalesced — so moving the cursor from one block to the NEXT on the same page re-renders nothing
///    (the same-value `setActive(true)` bails) yet the outline still jumps to the new block within ≤1 rAF.
export function HoverLayer({ store, page, scale }: HoverLayerProps) {
  bumpHoverLayerRenderCount(); // dev-only; folded out of production bundles (issue 038 render-count proof)
  const [active, setActive] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const pendingRef = useRef<HoverHighlight | null>(null);

  // Write the pending box + kind straight to the div (no React re-render). Kept in a ref so the rAF
  // callback always sees the latest scale/page without re-subscribing.
  const flushRef = useRef<() => void>(() => {});
  flushRef.current = () => {
    rafRef.current = null;
    const el = ref.current;
    const h = pendingRef.current;
    if (!el || !h || h.page !== page) return;
    el.style.left = `${h.box.x * scale}px`;
    el.style.top = `${h.box.y * scale}px`;
    el.style.width = `${h.box.w * scale}px`;
    el.style.height = `${h.box.h * scale}px`;
    el.className = `hw-hover hw-hover-${h.kind}`; // kind tags the outline (distinct from a selection mark)
  };

  useEffect(() => {
    const onChange = (h: HoverHighlight | null) => {
      const mine = !!h && h.page === page;
      pendingRef.current = mine ? h : null;
      setActive(mine); // same-value flips bail out of a re-render, so block→block moves cost nothing
      if (mine && rafRef.current == null) rafRef.current = raf(() => flushRef.current());
    };
    onChange(store.get()); // sync the current state on mount / store|page|scale change
    const off = store.subscribe(onChange);
    return () => {
      off();
      if (rafRef.current != null) {
        caf(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [store, page, scale]);

  // On first activation the div doesn't exist until the next commit; position it once it's mounted (and on
  // a zoom change while a hover is live). Subsequent moves position it via the rAF flush above.
  useEffect(() => {
    if (active) flushRef.current();
  }, [active, scale]);

  if (!active) return null;
  return <div ref={ref} className="hw-hover" style={{ position: "absolute" }} aria-hidden data-testid="hw-hover" />;
}
