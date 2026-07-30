/// useSelectionActions — the SHARED selection-format action set (issue 039). The 028 FloatingToolbar and
/// the 039 ContextMenu must drive the SAME handlers (중복 코드 금지), so the format/shade delegation that
/// used to be inline in HwpWorkspace's FloatingToolbar props is extracted HERE, once. Every callback is a
/// pure delegation to an EXISTING editor-core command (`formatCellRange` / `shadeCellRange`, issue 027
/// core — 신규 op 0); the toast copy is byte-identical to the pre-039 inline handlers so 028 does not
/// regress. It resolves against the CURRENT single-selection edit target (cell/range) — the same target
/// the toolbar's format controls key off — so both surfaces act on "현재 선택" (028과 같은 계약).
import { useMemo } from "react";
import type { EditorCore } from "@auto-hwp/editor-core";
import type { ToolbarAlign } from "./components/FloatingToolbar";
import { useWorkspaceMessages } from "./i18n";

/** The single-selection edit target the format actions need (a subset of HwpWorkspace's EditTarget). */
export interface SelectionActionTarget {
  section: number;
  block: number;
  kind: string;
  rows?: [number, number];
  cols?: [number, number];
  curBold: boolean;
  curItalic: boolean;
}

/** A rectangular cell range `[r0..=r1] × [c0..=c1]` (the target of a batch format/shade). */
export interface SelectionRange {
  r0: number;
  c0: number;
  r1: number;
  c1: number;
}

export interface SelectionActions {
  /** The resolved cell range, or null when the target isn't a formattable cell/range. */
  fmtRange: SelectionRange | null;
  /** Whether the format controls are usable (a single cell/range is selected). */
  canFormat: boolean;
  bold: () => void;
  italic: () => void;
  setSize: (pt: number) => void;
  setFont: (family: string) => void;
  setColor: (hex: string) => void;
  setShade: (hex: string | null) => void;
  setAlign: (align: ToolbarAlign) => void;
}

/// Build the shared format action set for the current edit target. `runFmt` is the host's apply+toast
/// wrapper (owns trap recovery) — the actions call it exactly as the inline handlers did, so the emitted
/// Intents + toasts are unchanged. Memoized on `[core, target, runFmt]` so the callback identities are
/// stable between renders that don't change the selection.
export function useSelectionActions(
  core: EditorCore,
  target: SelectionActionTarget | null,
  runFmt: (fn: () => Promise<number>, ok: string) => void,
): SelectionActions {
  const msg = useWorkspaceMessages();
  return useMemo(() => {
    const fmtRange: SelectionRange | null =
      target && target.rows && target.cols
        ? { r0: target.rows[0], c0: target.cols[0], r1: target.rows[1], c1: target.cols[1] }
        : null;
    const canFormat = !!fmtRange;
    // Guard every action so a click on a non-formattable target is a no-op (never an engine error).
    const guarded = (fn: (t: SelectionActionTarget, range: SelectionRange) => void) => () => {
      if (target && fmtRange) fn(target, fmtRange);
    };
    return {
      fmtRange,
      canFormat,
      bold: guarded((t, range) =>
        runFmt(() => core.edit.formatCellRange(t.section, t.block, range, { bold: !t.curBold }), t.curBold ? msg.selectionActions.boldOff : msg.selectionActions.boldOn),
      ),
      italic: guarded((t, range) => runFmt(() => core.edit.formatCellRange(t.section, t.block, range, { italic: !t.curItalic }), msg.selectionActions.italicOn)),
      setSize: (pt: number) => {
        if (target && fmtRange) runFmt(() => core.edit.formatCellRange(target.section, target.block, fmtRange, { size_pt: pt }), msg.selectionActions.size(pt));
      },
      setFont: (f: string) => {
        if (target && fmtRange) runFmt(() => core.edit.formatCellRange(target.section, target.block, fmtRange, { font: f }), msg.selectionActions.font(f));
      },
      setColor: (hex: string) => {
        if (target && fmtRange) runFmt(() => core.edit.formatCellRange(target.section, target.block, fmtRange, { color: hex }), msg.selectionActions.color);
      },
      setShade: (hex: string | null) => {
        if (target && fmtRange) runFmt(() => core.edit.shadeCellRange(target.section, target.block, fmtRange, hex), hex ? msg.selectionActions.shadeOn : msg.selectionActions.shadeOff);
      },
      setAlign: (a: ToolbarAlign) => {
        if (target && fmtRange) runFmt(() => core.edit.formatCellRange(target.section, target.block, fmtRange, { align: a }), msg.selectionActions.align);
      },
    };
  }, [core, target, runFmt, msg]);
}
