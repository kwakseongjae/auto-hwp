import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PageBox } from "../coords";

/// InPlaceCellEditor — the Figma-style in-place text editor (issue 032). It replaces the 027 popover card
/// (a bordered box with 저장/취소 buttons + a hint) with an editor that sits EXACTLY over the cell rect at
/// the cell's own font size, so entering edit mode does NOT change how the cell looks — only that it is now
/// typeable. The only chrome is a thin focus ring (outline); there are no buttons, hints, or a surrounding
/// card. It commits through the SAME run-preserving path as the popover (editCellText — issue 027 §함정),
/// so a bold cell stays bold.
///
/// It is a `<textarea>` (NOT contentEditable): `contentEditable plaintext-only` has real cross-browser
/// gaps (Firefox never shipped it; Safari quirks), and a textarea gives us a robust auto-grow + a plain
/// "\n" model that maps 1:1 onto the multi-paragraph cell shape `editCellText` expects. It is IME-SAFE:
/// a commit is REFUSED while a Korean composition is in flight (compositionstart→end), so the Enter that
/// CONFIRMS an IME candidate never also commits (issue 027 §함정: "compositionend 전 커밋 금지").
///
/// Keys: Enter=저장, Shift+Enter=개행, Esc=취소, blur(외부 클릭)=저장.

/** Page px per typographic point. own-render PAGE px = HWPUNIT/75 and 1pt = 100 HWPUNIT, so 1pt = 100/75 =
 *  4/3 page px (equivalently pt→px at 96dpi). A cell's on-screen font size is therefore
 *  `size_pt × PAGE_PX_PER_PT × scale`, where `scale` = client px / page px (rendered / viewBox). */
export const PAGE_PX_PER_PT = 4 / 3;

/** The absolutely-positioned box + font size that make the editor sit EXACTLY over the cell rect (issue
 *  032 — the position/size error < 4px is measured against this). PURE: page-px rect × scale → client px,
 *  and size_pt → client px. Node-testable with no DOM (this is the unit-tested core of the positioning). */
export interface InPlaceEditorStyle {
  left: number;
  top: number;
  width: number;
  /** The editor is at LEAST the cell height and grows DOWN when the text overflows (auto-height). */
  minHeight: number;
  /** undefined when the run size is unknown → the editor inherits the sheet's default size. */
  fontSize?: number;
}

/** Compute the editor's on-screen box + font size from the cell's page-px rect, the page scale, and the
 *  cell's first-run size in points. Single source of the positioning math (unit-tested). */
export function computeInPlaceEditorStyle(box: PageBox, scale: number, fontSizePt?: number): InPlaceEditorStyle {
  return {
    left: box.x * scale,
    top: box.y * scale,
    width: box.w * scale,
    minHeight: box.h * scale,
    fontSize: fontSizePt != null && fontSizePt > 0 ? fontSizePt * PAGE_PX_PER_PT * scale : undefined,
  };
}

export interface InPlaceCellEditorProps {
  /** The target cell/paragraph box in own-render PAGE px (the editor covers exactly this rect). */
  box: PageBox;
  /** rendered px / viewBox px for the page (page px × scale = client px) — the SAME scale the SelectionOverlay
   *  uses, so the editor tracks zoom/scroll with the cell. */
  scale: number;
  /** The current plain text of the target (multi-paragraph cells joined by "\n"). */
  initialText: string;
  /** The cell's FIRST run size in points (issue 032: font-size = size_pt × scale). Read via the 027
   *  blockRuns path (`runsAt` → `firstRunStyle`). Omitted → the editor uses the sheet default. */
  fontSizePt?: number;
  /** Fired with the new text on commit (Enter / blur). The host calls `core.edit.editCellText` /
   *  `editParagraphText`, which PRESERVES run styling (issue 027 §함정 — never a plain-text variant). May
   *  return a Promise that REJECTS on failure; the editor then un-latches so the user can retry (step 2). */
  onCommit: (text: string) => void | Promise<void>;
  /** Fired on cancel (Esc). */
  onCancel: () => void;
}

export function InPlaceCellEditor({ box, scale, initialText, fontSizePt, onCommit, onCancel }: InPlaceCellEditorProps) {
  const [text, setText] = useState(initialText);
  const composing = useRef(false);
  // Latched once a commit/cancel is in flight so the trailing blur (or a second Enter) can't double-fire.
  // A FAILED commit un-latches it (see `commit`) so the user can retry — the editor stays open on error.
  const done = useRef(false);
  const ref = useRef<HTMLTextAreaElement | null>(null);

  const style = computeInPlaceEditorStyle(box, scale, fontSizePt);

  useEffect(() => setText(initialText), [initialText]);

  // Focus + select-all on entry (v1: whole-cell select — a near-caret placement at the click point is out
  // of scope and documented in the issue).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);

  // Auto-grow AFTER the controlled value lands in the DOM: reset to auto, then grow to the content height
  // (never below the cell height). Overflow expands the editor DOWN over the document (issue 032 step 3).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.max(style.minHeight, el.scrollHeight)}px`;
  }, [text, style.minHeight]);

  const commit = useCallback(() => {
    if (done.current) return; // already committing/cancelling — ignore the trailing blur / second Enter
    if (composing.current) return; // NEVER commit mid IME composition (compositionend 전 커밋 금지)
    done.current = true;
    // A failed commit rejects → un-latch so Enter/blur can retry (step 2: 저장 실패 시 에디터 유지).
    Promise.resolve(onCommit(text)).catch(() => {
      done.current = false;
    });
  }, [text, onCommit]);

  const cancel = useCallback(() => {
    if (done.current) return;
    done.current = true;
    onCancel();
  }, [onCancel]);

  const onKeyDown = useCallback(
    (ev: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        cancel();
        return;
      }
      // Enter=저장, Shift+Enter=개행(default). Guard the IME gate: the Enter that CONFIRMS a composition
      // candidate must not commit.
      if (ev.key === "Enter" && !ev.shiftKey) {
        if (composing.current || (ev.nativeEvent as { isComposing?: boolean }).isComposing) return;
        ev.preventDefault();
        commit();
      }
    },
    [commit, cancel],
  );

  return (
    <textarea
      ref={ref}
      className="hw-inplace-editor"
      data-testid="hw-inplace-editor"
      value={text}
      style={{ left: style.left, top: style.top, width: style.width, minHeight: style.minHeight, fontSize: style.fontSize }}
      onChange={(e) => setText(e.target.value)}
      onCompositionStart={() => (composing.current = true)}
      onCompositionEnd={() => (composing.current = false)}
      onKeyDown={onKeyDown}
      // blur=저장 (외부 클릭). After Esc/Enter this is a no-op (`done` is latched).
      onBlur={commit}
      // Stop the sheet's pointer handlers (selection model) from firing beneath the editor.
      onPointerDown={(e) => e.stopPropagation()}
      aria-label="셀 텍스트 편집"
    />
  );
}
