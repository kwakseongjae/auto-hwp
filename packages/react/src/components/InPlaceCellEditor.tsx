import { useCallback, useLayoutEffect, useRef } from "react";
import type { RunSpec } from "@auto-hwp/editor-core";
import type { PageBox } from "../coords";
import { runsToHtml, serializeEditor, applyLiveStyle } from "../richedit";

/// InPlaceCellEditor — the Figma-style in-place text editor (issues 032 + 040). It sits EXACTLY over the cell
/// rect at the cell's own font size, so entering edit mode does NOT change how the cell looks — only that it
/// is now typeable. The only chrome is a thin focus ring (outline); there are no buttons, hints, or a card.
///
/// Issue 040 upgraded it from a plain `<textarea>` (plaintext) to a `contentEditable` RICH editor: a text
/// SELECTION can be made bold/italic/underline/struck LIVE (⌘B/⌘I/⌘U + ⌘⇧S → richedit.applyLiveStyle), and
/// the edited DOM is serialized to `RunSpec[]` on commit — so partial formatting is PRESERVED per run (027
/// §함정 / 040 교훈 6: the run-preserving SetTableCellRuns/SetParagraphRuns path, never a plain-text variant).
/// It stays IME-SAFE: a commit is REFUSED while a Korean composition is in flight (compositionstart→end), so
/// the Enter that CONFIRMS an IME candidate never also commits (교훈: "compositionend 전 커밋 금지").
///
/// Keys: Enter=저장, Shift+Enter=개행, Esc=취소, Tab/Shift+Tab=커밋+이동, blur(외부 클릭)=저장.

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
   *  uses, so the editor tracks zoom/scroll with the cell. It also drives the run→span font-size render. */
  scale: number;
  /** The target's CURRENT styled runs (issue 040) — rendered into the contentEditable so existing per-run
   *  formatting shows live and round-trips. A multi-paragraph cell joins paragraphs with a bare `{text:"\n"}`
   *  run (the shape `runsAt` returns). */
  initialRuns: RunSpec[];
  /** The cell's FIRST run size in points (issue 032: font-size = size_pt × scale). Read via the 027
   *  blockRuns path (`runsAt` → `firstRunStyle`). Omitted → the editor uses the sheet default. */
  fontSizePt?: number;
  /** Fired with the serialized RUNS on commit (Enter / blur). The host commits them run-preserving via
   *  SetTableCellRuns/SetParagraphRuns (issue 040 교훈 6). May return a Promise that REJECTS on failure; the
   *  editor then un-latches so the user can retry (step 2). */
  onCommit: (runs: RunSpec[]) => void | Promise<void>;
  /** Fired on cancel (Esc). */
  onCancel: () => void;
  /** OPTIONAL (issue 036): Tab / Shift+Tab inside a CELL editor = commit THEN move to the right/left cell
   *  and re-enter edit. The host commits (run-preserving) and, ONLY on a successful commit, navigates +
   *  re-opens the editor. Like `onCommit` it may REJECT (commit failed) → the editor un-latches and stays
   *  open with the move CANCELLED (031 apply-verify spirit). Omitted (e.g. a paragraph editor) → Tab is the
   *  default. IME-safe: never fires mid Korean composition. */
  onCommitMove?: (dir: "left" | "right", runs: RunSpec[]) => void | Promise<void>;
}

export function InPlaceCellEditor({ box, scale, initialRuns, fontSizePt, onCommit, onCancel, onCommitMove }: InPlaceCellEditorProps) {
  const composing = useRef(false);
  // Latched once a commit/cancel is in flight so the trailing blur (or a second Enter) can't double-fire.
  // A FAILED commit un-latches it (see `commit`) so the user can retry — the editor stays open on error.
  const done = useRef(false);
  const ref = useRef<HTMLDivElement | null>(null);
  // The runs to render at mount, captured once (the editor is REMOUNTED via `key` when the cell changes, so
  // this never needs to re-run — re-setting innerHTML on a keystroke would kill the caret + Korean IME).
  const initialRef = useRef(initialRuns);

  const style = computeInPlaceEditorStyle(box, scale, fontSizePt);

  // Render the runs into the contentEditable ONCE, then focus + select-all (v1: whole-content select — a
  // near-caret placement at the click point is out of scope, documented in the issue).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.innerHTML = runsToHtml(initialRef.current, scale);
    el.focus();
    const sel = window.getSelection();
    if (sel) {
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
    }
    // Mount-only: the editor is keyed on the cell so a new cell REMOUNTS this. `scale` is captured at mount
    // (a zoom mid-edit re-lays-out and closes the editor), so a stale-scale re-render can't re-set innerHTML.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Serialize the live contentEditable DOM → RunSpec[] (the run-preserving commit payload). */
  const serialize = useCallback((): RunSpec[] => {
    const el = ref.current;
    return el ? serializeEditor(el, scale) : [{ text: "" }];
  }, [scale]);

  const commit = useCallback(() => {
    if (done.current) return; // already committing/cancelling — ignore the trailing blur / second Enter
    if (composing.current) return; // NEVER commit mid IME composition (compositionend 전 커밋 금지)
    done.current = true;
    // A failed commit rejects → un-latch so Enter/blur can retry (step 2: 저장 실패 시 에디터 유지).
    Promise.resolve(onCommit(serialize())).catch(() => {
      done.current = false;
    });
  }, [onCommit, serialize]);

  const cancel = useCallback(() => {
    if (done.current) return;
    done.current = true;
    onCancel();
  }, [onCancel]);

  // Tab / Shift+Tab = commit-then-move (issue 036). Same latch + IME gate + reject→un-latch as `commit`,
  // but routed through `onCommitMove` so the host moves + re-enters ONLY on a successful commit.
  const commitMove = useCallback(
    (dir: "left" | "right") => {
      if (!onCommitMove) return;
      if (done.current) return;
      if (composing.current) return; // never commit mid IME composition
      done.current = true;
      Promise.resolve(onCommitMove(dir, serialize())).catch(() => {
        done.current = false; // commit failed → un-latch, move cancelled, editor stays open (031)
      });
    },
    [onCommitMove, serialize],
  );

  const onKeyDown = useCallback(
    (ev: React.KeyboardEvent<HTMLDivElement>) => {
      if (ev.key === "Escape") {
        ev.preventDefault();
        cancel();
        return;
      }
      // ⌘/Ctrl live formatting on the SELECTION (issue 040): B/I/U + ⌘⇧S = strike. execCommand-based
      // (richedit.applyLiveStyle) — visible immediately; serialized to runs on commit. Never commits.
      if (ev.metaKey || ev.ctrlKey) {
        const k = ev.key.toLowerCase();
        if (k === "b") { ev.preventDefault(); applyLiveStyle({ bold: true }, scale); return; }
        if (k === "i") { ev.preventDefault(); applyLiveStyle({ italic: true }, scale); return; }
        if (k === "u") { ev.preventDefault(); applyLiveStyle({ underline: true }, scale); return; }
        if (ev.shiftKey && k === "s") { ev.preventDefault(); applyLiveStyle({ strike: true }, scale); return; }
      }
      // Tab=오른쪽 셀로 저장+이동, Shift+Tab=왼쪽 (only when the host wired onCommitMove — a cell editor).
      if (ev.key === "Tab" && onCommitMove) {
        if (composing.current || (ev.nativeEvent as { isComposing?: boolean }).isComposing) return;
        ev.preventDefault();
        commitMove(ev.shiftKey ? "left" : "right");
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
    [commit, cancel, commitMove, onCommitMove, scale],
  );

  return (
    <div
      ref={ref}
      className="hw-inplace-editor"
      data-testid="hw-inplace-editor"
      data-inline-edit
      contentEditable
      suppressContentEditableWarning
      role="textbox"
      aria-multiline="true"
      aria-label="셀 텍스트 편집"
      style={{ left: style.left, top: style.top, width: style.width, minHeight: style.minHeight, fontSize: style.fontSize }}
      onCompositionStart={() => (composing.current = true)}
      onCompositionEnd={() => (composing.current = false)}
      onKeyDown={onKeyDown}
      // blur=저장 (외부 클릭). After Esc/Enter this is a no-op (`done` is latched).
      onBlur={commit}
      // Stop the sheet's pointer handlers (selection model) from firing beneath the editor.
      onPointerDown={(e) => e.stopPropagation()}
    />
  );
}
