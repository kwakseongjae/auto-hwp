import { useEffect, useMemo, useState } from "react";
import { createEditorCore, type EditorCore, type EngineAdapter, type OpenResult, type Selection, type SelMarquee } from "@tf-hwp/editor-core";

/// useHwpEditor — the thin React binding to @tf-hwp/editor-core (issue 026). It constructs the headless
/// EditorCore over an EngineAdapter and mirrors its event streams into React state, so components render
/// by SUBSCRIBING (no editing logic in React — that all descended to the core). A host that wants a fully
/// custom UI uses this hook (or drives the core directly, see editor-core/examples/vanilla.ts).
///
/// Returns the live `core` (call its commands: `core.selection.pointerDown(...)`, `core.edit.apply(...)`,
/// `core.session.undo()` …) plus the reactive projections the UI draws.
export interface HwpEditorState {
  /** The headless editor core (session + selection + edit) — call its commands directly. */
  core: EditorCore;
  /** The open document's metadata (pages/format/editable), or null when nothing is open. */
  meta: OpenResult | null;
  /** The current selection (single source of truth): anchor + visual mark per item. */
  selection: Selection[];
  /** The in-progress marquee rectangle, or null. */
  marquee: SelMarquee | null;
  /** Monotonic token bumped whenever the layout is invalidated (re-fetch page SVGs on change). */
  refreshToken: number;
  /** Force a page re-fetch (used by the UI on a wasm-trap recovery, which has no layout signal). */
  bumpRefresh: () => void;
}

export function useHwpEditor(adapter: EngineAdapter): HwpEditorState {
  const core = useMemo(() => createEditorCore(adapter), [adapter]);
  const [meta, setMeta] = useState<OpenResult | null>(() => core.session.getMeta());
  const [selection, setSelection] = useState<Selection[]>(() => core.selection.getSelection());
  const [marquee, setMarquee] = useState<SelMarquee | null>(() => core.selection.getMarquee());
  const [refreshToken, setRefreshToken] = useState(0);

  useEffect(() => {
    // Re-sync to the (possibly new) core instance before subscribing (adapter swap).
    setMeta(core.session.getMeta());
    setSelection(core.selection.getSelection());
    setMarquee(core.selection.getMarquee());
    const offs = [
      core.session.onDocChange((m) => setMeta(m)),
      core.session.onLayoutInvalidated(() => setRefreshToken((t) => t + 1)),
      core.selection.onChange((s) => setSelection(s)),
      core.selection.onMarqueeChange((m) => setMarquee(m)),
    ];
    return () => offs.forEach((off) => off());
  }, [core]);

  return {
    core,
    meta,
    selection,
    marquee,
    refreshToken,
    bumpRefresh: () => setRefreshToken((t) => t + 1),
  };
}
