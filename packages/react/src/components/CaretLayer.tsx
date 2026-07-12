import { useEffect, useRef, useState } from "react";
import type { CellCaretState, EditorCore } from "@tf-hwp/editor-core";
import type { CompositionStore } from "../composition";

export interface CaretLayerProps {
  /** The headless editor core — CaretLayer subscribes to `core.cellCaret` DIRECTLY (030 isolation). */
  core: EditorCore;
  /** The page this layer belongs to (a caret on another page renders nothing here). */
  page: number;
  /** rendered px / viewBox px for this page (page-px → client-px). Only zoom changes it. */
  scale: number;
  /** issue 059 (optional): while an IME composition is live on THIS page the blinking bar is HIDDEN — the
   *  ImeCompositionLayer draws the composition's own caret at the composing string's right edge, so
   *  suppressing this one prevents a double caret. Omitted (e.g. a backend without IME) → always shown. */
  composition?: CompositionStore;
}

/// CaretLayer — the blinking cell text caret (issue 053), ISOLATED from the workspace/sheet render
/// path exactly like MarqueeLayer (issue 030):
///  · PRESENCE (mount/unmount of the caret div) rides a `useState` — it flips only when the caret
///    appears on / leaves THIS page (a click, Escape, a page hop), so React commits are rare AND
///    `.hw-caret` is genuinely absent when no caret is live (the render-0 test asserts exactly that).
///  · POSITION (left/top/height as the caret moves per keystroke / arrow) is written straight to the
///    DOM via a ref — the 2nd…Nth caret move re-renders NOTHING (React bails the same-value setState)
///    yet the bar tracks every offset change. The CSS blink animation is RESTARTED on each move (the
///    한글식 caret: solid at the moment it moves, then blinks).
export function CaretLayer({ core, page, scale, composition }: CaretLayerProps) {
  const [active, setActive] = useState(false);
  const [composing, setComposing] = useState(false); // 059: an IME composition is live on this page
  const activeRef = useRef(false); // live mirror so a same-value move NEVER calls setState at all
  const ref = useRef<HTMLDivElement | null>(null);
  const pendingRef = useRef<CellCaretState | null>(null);

  // Write the pending caret straight to the div (no React re-render). Kept in a ref so the
  // subscription always sees the latest scale without re-subscribing.
  const flushRef = useRef<() => void>(() => {});
  flushRef.current = () => {
    const el = ref.current;
    const s = pendingRef.current;
    if (!el || !s || s.rect.page !== page) return;
    el.style.left = `${s.rect.x * scale}px`;
    el.style.top = `${s.rect.top * scale}px`;
    el.style.height = `${s.rect.height * scale}px`;
    // Restart the blink so the caret is SOLID right after it moves (typing keeps it visible).
    el.style.animation = "none";
    void el.offsetWidth; // reflow — commits the animation reset
    el.style.animation = "";
  };

  useEffect(() => {
    const onCaret = (s: CellCaretState | null) => {
      const mine = !!s && s.rect.page === page;
      pendingRef.current = mine ? s : null;
      // PRESENCE flips only when the caret appears on / leaves THIS page. A caret MOVE (same page)
      // must not even call setState — React 18's same-value bailout can still schedule one extra
      // render pass, which the 030 counter harness would catch — so gate on a live mirror instead.
      if (activeRef.current !== mine) {
        activeRef.current = mine;
        setActive(mine);
      }
      if (mine) flushRef.current();
    };
    onCaret(core.cellCaret.get()); // sync current state on mount / core|page|scale change
    return core.cellCaret.onChange(onCaret);
  }, [core, page, scale]);

  // 059: track the IME composition presence for THIS page so the bar hides while composing (the
  // ImeCompositionLayer draws the composition caret instead — no double caret). A no-op when no store.
  useEffect(() => {
    if (!composition) return;
    const onComp = () => setComposing(composition.composingOn(page));
    onComp(); // sync current state
    return composition.onChange(onComp);
  }, [composition, page]);

  // On first activation the div doesn't exist until the next commit; position it once mounted (and on
  // a zoom change, or when composition ends and the bar re-appears, while the caret is live). Later
  // moves position it via the flush above.
  useEffect(() => {
    if (active && !composing) flushRef.current();
  }, [active, composing, scale]);

  if (!active || composing) return null;
  return <div ref={ref} className="hw-caret" data-testid="hw-caret" aria-hidden />;
}
