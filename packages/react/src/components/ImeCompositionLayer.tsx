import { useEffect, useRef, useState } from "react";
import type { CellCaretState, EditorCore, RunStyle } from "@tf-hwp/editor-core";
import type { CompositionStore } from "../composition";
import { isEditableTarget } from "../viewport";
import { PAGE_PX_PER_PT } from "./InPlaceCellEditor";

export interface ImeCompositionLayerProps {
  /** The headless editor core — the layer subscribes to `core.cellCaret` DIRECTLY (030 isolation). */
  core: EditorCore;
  /** The page this layer belongs to (a caret on another page → this layer renders nothing). */
  page: number;
  /** rendered px / viewBox px for this page (page-px → client-px). Only zoom changes it. */
  scale: number;
  /** Shared signal so the CaretLayer HIDES its bar while composing (no double caret). */
  store: CompositionStore;
  /** Commit the composed string as ONE SetTableCellRuns undo unit — the host wraps it with trap/toast
   *  recovery, so this layer stays free of engine-error policy (it just forwards `compositionend.data`). */
  commit: (text: string) => void;
}

/// ImeCompositionLayer — Korean (and any IME) INLINE composition for the cell text caret (issue 059).
///
/// ## Why this exists (the research 반전)
/// The 053 caret is a pure overlay `div`; there is NO focused editable element at the caret, so the browser
/// has nowhere to run an IME composition — 한글 조합이 시작 자체가 불가능했다(자모조차 안 나옴: the window
/// typing listener's `keyCode===229` guard just swallowed the keydown). This layer supplies the missing
/// INPUT-CAPTURE surface: a caret-tracking hidden `<textarea>` (the xterm.js pattern) placed AT the caret px
/// (never offscreen — the OS candidate / 한자 변환 window anchors to it), focused so composition can begin.
///
/// ## Flow (엔진 무변경 — 표면만)
///  · The textarea holds focus but is EXEMPT from `isEditableTarget` (viewport.ts) — so every window keydown
///    listener (035 zoom/Space · 036 cell-nav · 053 typing · ⌘F) keeps owning plain keys/arrows/Enter exactly
///    as before. Only IME composition routes through the textarea.
///  · compositionstart → the 053 typing listener's `isComposing/229` guard blocks the raw jamo lane; we mount
///    the `hw-ime-preview` overlay + tell the store (CaretLayer hides its bar).
///  · compositionupdate(data) → draw `data` into the preview span BY REF (render-0, the 030 pattern) with the
///    caret's run style, and a composition caret bar at the string's right edge.
///  · compositionend(data) → 도깨비불 대비 ONLY `end.data` is trusted (never an update-history diff): empty →
///    no-op; else `commit(data)` = one SetTableCellRuns undo unit (the SAME lane as typed text). Clear the
///    textarea buffer so the next syllable session starts fresh.
///
/// Presence (textarea/preview mount) rides a `useState` (rare); position + composing text are ref writes, so
/// a composition never re-renders the workspace or the SVG sheets (the render-0 counters lock this).
export function ImeCompositionLayer({ core, page, scale, store, commit }: ImeCompositionLayerProps) {
  const [active, setActive] = useState(false); // caret is on THIS page → textarea present + focused
  const [composing, setComposing] = useState(false); // a composition is live → preview present
  const activeRef = useRef(false); // live mirror so a same-value caret move never calls setState
  const composingRef = useRef(false); // live mirror read by async style fetch / focus guard
  const pendingRef = useRef<CellCaretState | null>(null); // latest caret state for this page
  const pendingTextRef = useRef(""); // latest composing string (applied to the preview by ref)
  const styleRef = useRef<RunStyle>({}); // run style at the caret (059 스타일 소스)

  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const previewRef = useRef<HTMLSpanElement | null>(null);
  const textRef = useRef<HTMLSpanElement | null>(null);
  const barRef = useRef<HTMLSpanElement | null>(null);

  // Position the textarea + preview at the caret px and (re)apply the run style — a pure DOM write, no
  // React render. Kept in a ref so the subscription always sees the latest scale without re-subscribing.
  const flushRef = useRef<() => void>(() => {});
  flushRef.current = () => {
    const s = pendingRef.current;
    if (!s || s.rect.page !== page) return;
    const left = s.rect.x * scale;
    const top = s.rect.top * scale;
    const h = s.rect.height * scale;
    const ta = taRef.current;
    if (ta) {
      ta.style.left = `${left}px`;
      ta.style.top = `${top}px`;
      ta.style.height = `${h}px`;
    }
    const pv = previewRef.current;
    if (pv) {
      const st = styleRef.current;
      const sizePx = st.size_pt && st.size_pt > 0 ? st.size_pt * PAGE_PX_PER_PT * scale : h * 0.82;
      pv.style.left = `${left}px`;
      pv.style.top = `${top}px`;
      pv.style.height = `${h}px`;
      pv.style.fontSize = `${sizePx}px`;
      pv.style.lineHeight = `${h}px`;
      pv.style.fontWeight = st.bold ? "700" : "400";
      pv.style.fontStyle = st.italic ? "italic" : "normal";
      if (st.color) pv.style.color = st.color;
      if (st.font) pv.style.fontFamily = st.font;
    }
    if (barRef.current) barRef.current.style.height = `${h}px`;
  };

  // Write the pending composing text into the preview span (render-0). Called on each update + on the
  // first mount of the preview (compositionstart's setState may not have committed when update 1 arrives).
  const drawRef = useRef<() => void>(() => {});
  drawRef.current = () => {
    if (textRef.current) textRef.current.textContent = pendingTextRef.current;
    flushRef.current();
  };

  // Claim focus from "nowhere" (body/null) so composition can start — but NEVER steal it from a real
  // editable surface (chat composer / size input / menu) or mid-composition (055 lesson: consistent guard).
  const ensureFocusRef = useRef<() => void>(() => {});
  ensureFocusRef.current = () => {
    const ta = taRef.current;
    if (!ta || composingRef.current) return;
    const ae = document.activeElement;
    if (ae === ta) return;
    if (ae && ae !== document.body && isEditableTarget(ae)) return;
    try {
      ta.focus({ preventScroll: true });
    } catch {
      ta.focus();
    }
  };

  // Subscribe to the caret (mirrors CaretLayer): presence flips only when the caret enters/leaves THIS page.
  useEffect(() => {
    const onCaret = (s: CellCaretState | null) => {
      const mine = !!s && s.rect.page === page;
      pendingRef.current = mine ? s : null;
      if (activeRef.current !== mine) {
        activeRef.current = mine;
        setActive(mine);
      }
      if (mine) {
        flushRef.current();
        ensureFocusRef.current();
      }
    };
    onCaret(core.cellCaret.get()); // sync on mount / core|page|scale change
    return core.cellCaret.onChange(onCaret);
  }, [core, page, scale]);

  // On the first activation the textarea doesn't exist until the next commit; focus + position it once
  // mounted (and re-position on a zoom change while the caret is live).
  useEffect(() => {
    if (!active) return;
    ensureFocusRef.current();
    flushRef.current();
  }, [active, scale]);

  // Release the IME session (blur) when the caret leaves this page / the layer unmounts (caret clear,
  // editor open, document swap). Runs only on the active→inactive edge — never on a zoom change — so
  // focus/composition is not dropped mid-typing. (DOM removal also blurs; this is the explicit release.)
  useEffect(() => {
    if (!active) return;
    return () => {
      try {
        taRef.current?.blur();
      } catch {
        /* detached */
      }
      // A caret that vanishes mid-composition must not leave the store latched (CaretLayer would stay hidden).
      if (composingRef.current) {
        composingRef.current = false;
        store.set(null);
      }
    };
  }, [active, store]);

  // Draw the preview text once it mounts (composition just started) and on a zoom change while composing.
  useEffect(() => {
    if (composing) drawRef.current();
  }, [composing, scale]);

  const onCompositionStart = () => {
    composingRef.current = true;
    pendingTextRef.current = "";
    styleRef.current = {};
    setComposing(true);
    store.set({ page, text: "" }); // CaretLayer hides its bar while this is live
    // Fetch the run style at the caret ONCE per session (read-only; no undo unit). Ignore a late resolve
    // if the composition already ended.
    void core.cellCaret
      .styleAtCaret()
      .then((st) => {
        if (!composingRef.current) return;
        styleRef.current = st ?? {};
        flushRef.current();
      })
      .catch(() => {
        /* style is cosmetic — a failed read just leaves the preview at its default look */
      });
  };

  const onCompositionUpdate = (e: React.CompositionEvent<HTMLTextAreaElement>) => {
    pendingTextRef.current = e.data ?? "";
    drawRef.current();
  };

  const onCompositionEnd = (e: React.CompositionEvent<HTMLTextAreaElement>) => {
    const data = e.data ?? "";
    composingRef.current = false;
    const ta = taRef.current;
    if (ta) ta.value = ""; // release the buffer so the NEXT syllable session starts clean
    pendingTextRef.current = "";
    if (textRef.current) textRef.current.textContent = "";
    setComposing(false);
    store.set(null); // caret shows again
    if (data) commit(data); // 도깨비불: trust ONLY end.data — one SetTableCellRuns undo unit
  };

  if (!active) return null;
  return (
    <>
      {/* The caret-tracking INPUT-CAPTURE surface — invisible + non-interactive, but focusable and placed AT
          the caret so the OS candidate/한자 window anchors correctly. `data-hw-ime-input` exempts it from
          isEditableTarget so the window keydown listeners keep owning plain keys. */}
      <textarea
        ref={taRef}
        data-hw-ime-input="1"
        data-testid="hw-ime-input"
        className="hw-ime-input"
        aria-hidden
        tabIndex={-1}
        spellCheck={false}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        onCompositionStart={onCompositionStart}
        onCompositionUpdate={onCompositionUpdate}
        onCompositionEnd={onCompositionEnd}
      />
      {composing && (
        <span ref={previewRef} className="hw-ime-preview" data-testid="hw-ime-preview" aria-hidden>
          <span ref={textRef} className="hw-ime-text" />
          <span ref={barRef} className="hw-ime-caret" />
        </span>
      )}
    </>
  );
}
