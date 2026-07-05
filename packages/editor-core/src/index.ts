// @tf-hwp/editor-core — headless, framework-agnostic editor core (SDK-LAYERS L2). No React, no DOM.
// Drive any UI (or none) over an EngineAdapter; subscribe to events; apply Intents; undo. See the
// README and examples/vanilla.ts for a React-free end-to-end flow.

// Backend seam
export type { EngineAdapter } from "./adapter";

// Composition
export { EditorCore, createEditorCore } from "./core";

// Document lifecycle / undo / font
export { DocSession } from "./session";

// Selection engine (issues 021 + 023) + its pure helpers (exported so hosts/tests can reuse them).
export {
  SelectionModel,
  DRAG_THRESHOLD_PX,
  selKey,
  cellLabel,
  deriveSel,
  blockHitToSel,
  mergeSelection,
} from "./selection";
export type { SelectResult, CellDir } from "./selection";

// Edit assembly / preview / apply + the issue-027 manual edit command types
export { EditController } from "./edit";
export type { CellRange, CellFmt, PageMarginsMm } from "./edit";
export { describeIntent } from "./describeIntent";

// Unit conversion (issue 027) — the SINGLE px↔mm↔ratio point the ruler + column-resize share.
export {
  PX_PER_MM,
  HWPUNIT_PER_PX,
  pxToMm,
  mmToPx,
  roundMm,
  boundariesToWidths,
  widthsToRatios,
  boundariesToRatios,
  boundariesToHeights,
  remapFragmentHeights,
  appliedReflectsDrag,
  resizeBoundary,
} from "./units";

// Run-format preservation (issue 027) — the pure text-edit inheritance rule.
export { inheritRuns, firstRunStyle } from "./runs";
export type { RunStyle } from "./runs";

// Find/Replace controller (issue 045) — search/next/prev/replaceCurrent/replaceAll + caretRect-derived
// match geometry (locate/locateAll). Drives the adapter's find/replace surface; UI-agnostic (node-tested).
export { FindController } from "./find";

// Glyph-caret model (issue 041, FG-12 前半) — pure HitResult→TextAnchor + the para_len clamp / null policy.
export { clampOffset, hitResultToTextAnchor, isCaretGap } from "./caret";

// Event emitter primitive
export { Emitter } from "./events";
export type { Listener } from "./events";

// Types
export type {
  Anchor,
  BlockHit,
  Box,
  CaretRect,
  CellHit,
  DocContext,
  FindMatch,
  FindOptions,
  FindReplaceOptions,
  HitResult,
  Intent,
  IntentCard,
  MatchBox,
  OnAiRequest,
  OpenResult,
  Outcome,
  OutlineItem,
  PageGeom,
  PointerInput,
  ReplaceResult,
  RunSpec,
  Selection,
  SelMark,
  SelMarquee,
  TableBox,
  TextAnchor,
} from "./types";
