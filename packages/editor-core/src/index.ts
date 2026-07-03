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

// Edit assembly / preview / apply
export { EditController } from "./edit";
export { describeIntent } from "./describeIntent";

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
  PointerInput,
  Selection,
  SelMark,
  SelMarquee,
  TableBox,
} from "./types";
