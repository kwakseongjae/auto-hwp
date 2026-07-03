import { useCallback, useEffect, useRef, useState } from "react";
import type { PageBox } from "../coords";

export interface CellTextPopoverProps {
  /** The target cell/paragraph box in own-render PAGE px (positions the popover over it). */
  box: PageBox;
  /** rendered px / viewBox px for the page (page px × scale = client px). */
  scale: number;
  /** The current plain text of the target (multi-paragraph cells joined by "\n"). */
  initialText: string;
  /** Fired with the new text on commit. The host calls `core.edit.editCellText` /
   *  `editParagraphText`, which PRESERVES run styling (issue 027 §함정 — never a plain-text variant). */
  onCommit: (text: string) => void;
  /** Fired on cancel (Esc / click-away). */
  onCancel: () => void;
}

/// @deprecated Since issue 032 — superseded by `InPlaceCellEditor`, which edits the cell IN PLACE (over the
/// cell rect at the cell's own font size, chrome = a thin focus ring only) instead of this popover card
/// (bordered box + 저장/취소 buttons + hint). Kept as an export for backward compatibility; HwpWorkspace's
/// enableEditing path no longer mounts it. Prefer `InPlaceCellEditor` for new code.
///
/// CellTextPopover — the opt-in inline text editor (issue 027 step 4): a simple textarea popover anchored
/// over the marked cell/paragraph. v1 is DELIBERATELY a plain textarea — the desktop contentEditable
/// WYSIWYG gotchas (#000 rule etc.) are NOT ported. It is IME-SAFE: a commit is REFUSED while a Korean
/// composition is in flight (compositionstart→end), so pressing Enter to CONFIRM an IME candidate never
/// also commits the edit (issue 027 §함정: "compositionend 전 커밋 금지"). Commit = the 저장 button or
/// ⌘/Ctrl+Enter; Enter alone inserts a newline (multi-paragraph cells). Esc cancels. Korean copy.
export function CellTextPopover({ box, scale, initialText, onCommit, onCancel }: CellTextPopoverProps) {
  const [text, setText] = useState(initialText);
  const composing = useRef(false);
  const ref = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => setText(initialText), [initialText]);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const commit = useCallback(() => {
    if (composing.current) return; // NEVER commit mid-composition (IME gate)
    onCommit(text);
  }, [text, onCommit]);

  const onKeyDown = useCallback(
    (ev: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        onCancel();
        return;
      }
      // ⌘/Ctrl+Enter commits; plain Enter inserts a newline (default). Guard the IME gate.
      if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) {
        ev.preventDefault();
        if (composing.current || (ev.nativeEvent as { isComposing?: boolean }).isComposing) return;
        commit();
      }
    },
    [commit, onCancel],
  );

  const left = box.x * scale;
  const top = box.y * scale;
  const width = Math.max(box.w * scale, 120);

  return (
    <div
      className="hw-cellpop"
      data-testid="hw-cell-popover"
      style={{ left, top, width }}
      // stop the sheet's pointer handlers (selection model) from firing under the popover.
      onPointerDown={(e) => e.stopPropagation()}
    >
      <textarea
        ref={ref}
        className="hw-cellpop-textarea"
        data-testid="hw-cell-textarea"
        value={text}
        rows={Math.max(1, text.split("\n").length)}
        onChange={(e) => setText(e.target.value)}
        onCompositionStart={() => (composing.current = true)}
        onCompositionEnd={() => (composing.current = false)}
        onKeyDown={onKeyDown}
        aria-label="셀 텍스트 편집"
      />
      <div className="hw-cellpop-actions">
        <span className="hw-cellpop-hint">⌘/Ctrl+Enter 저장 · Esc 취소</span>
        <button className="hw-cellpop-btn" data-testid="hw-cell-cancel" onClick={onCancel}>
          취소
        </button>
        <button className="hw-cellpop-btn hw-cellpop-btn-primary" data-testid="hw-cell-save" onClick={commit}>
          저장
        </button>
      </div>
    </div>
  );
}
