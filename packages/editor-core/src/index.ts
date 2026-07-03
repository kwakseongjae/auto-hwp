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
export type { SelectResult } from "./selection";

// Edit assembly / preview / apply + the issue-027 manual edit command types
export { EditController } from "./edit";
export type { CellRange, CellFmt, PageMarginsMm } from "./edit";
export { describeIntent } from "./describeIntent";

// Unit conversion (issue 027) — the SINGLE px↔mm↔ratio point the ruler + column-resize share.
export {
  PX_PER_MM,
  pxToMm,
  mmToPx,
  roundMm,
  boundariesToWidths,
  widthsToRatios,
  boundariesToRatios,
  resizeBoundary,
} from "./units";

// Run-format preservation (issue 027) — the pure text-edit inheritance rule.
export { inheritRuns, firstRunStyle } from "./runs";
export type { RunStyle } from "./runs";

// Event emitter primitive
export { Emitter } from "./events";
export type { Listener } from "./events";

// Types
export type {
  Anchor,
  BlockHit,
  Box,
  CellHit,
  DocContext,
  Intent,
  IntentCard,
  OnAiRequest,
  OpenResult,
  Outcome,
  PageGeom,
  PointerInput,
  RunSpec,
  Selection,
  SelMark,
  SelMarquee,
  TableBox,
} from "./types";
