// @tf-hwp/react — public surface (issue 016). Import the stylesheet once in your app:
//   import "@tf-hwp/react/styles.css";
import "./styles.css";

// Assembly + components
export { HwpWorkspace } from "./components/HwpWorkspace";
export type { HwpWorkspaceProps } from "./components/HwpWorkspace";
export { HwpPageView } from "./components/HwpPageView";
export type { HwpPageViewProps, PageClick } from "./components/HwpPageView";
export { SelectionOverlay } from "./components/SelectionOverlay";
export type { SelectionOverlayProps, Mark, Marquee } from "./components/SelectionOverlay";
export { ChatPanel } from "./components/ChatPanel";
export type { ChatPanelProps } from "./components/ChatPanel";
export { FontPicker } from "./components/FontPicker";
export type { FontPickerProps } from "./components/FontPicker";

// Issue 027 — editing-parity opt-in components. Each is individually importable and drives a single
// @tf-hwp/editor-core command; a host can compose them WITHOUT HwpWorkspace (see the README recipe).
export { ColumnResizeOverlay } from "./components/ColumnResizeOverlay";
export type { ColumnResizeOverlayProps } from "./components/ColumnResizeOverlay";
export { TableInsertButton } from "./components/TableInsertButton";
export type { TableInsertButtonProps } from "./components/TableInsertButton";
export { Ruler } from "./components/Ruler";
export type { RulerProps } from "./components/Ruler";
export { CellTextPopover } from "./components/CellTextPopover";
export type { CellTextPopoverProps } from "./components/CellTextPopover";
// FormatToolbar — the ORIGINAL fixed toolbar (issue 027). Kept for backward compatibility; HwpWorkspace's
// enableEditing path now uses FloatingToolbar (issue 028). Still individually importable for hosts that
// built their own chrome around it.
export { FormatToolbar } from "./components/FormatToolbar";
export type { FormatToolbarProps } from "./components/FormatToolbar";

// Issue 028 — the opt-in capsule FLOATING selection toolbar (네이버 블로그 패턴) + its pure position engine.
// It reuses the 027 core commands (formatCellRange/shadeCellRange) and adds the "AI에게 전달" vibe-edit entry.
export { FloatingToolbar } from "./components/FloatingToolbar";
export type { FloatingToolbarProps, ToolbarAlign } from "./components/FloatingToolbar";
export { computeFloatingPosition, unionPageBox } from "./floatingPosition";
export type { FloatViewport, FloatOptions, FloatPlacement, FloatPosition } from "./floatingPosition";

// Font system v1 (issue 022): the curated OFL catalog + screen @font-face/alias helpers.
export { FONT_CATALOG, catalogUrl, buildFontFaceCss, svgFontFamilies, isTtc } from "./fonts";
export type { FontCatalogEntry } from "./fonts";

// Backend seam
export type { EngineAdapter } from "./EngineAdapter";
export { WasmAdapter } from "./WasmAdapter";
export type { CodedError } from "./WasmAdapter";
export { TauriAdapter } from "./TauriAdapter";
export type { TauriAdapterOptions, Invoke } from "./TauriAdapter";

// Headless core (issue 026) — the React binding hook + a re-export of @tf-hwp/editor-core so a host can
// build a fully custom UI over the SAME core (no @tf-hwp/react components required). The heavy editing
// logic lives in editor-core; the components below are a thin, optional binding.
export { useHwpEditor } from "./useHwpEditor";
export type { HwpEditorState } from "./useHwpEditor";
export { createEditorCore, EditorCore, DocSession, SelectionModel, EditController } from "@tf-hwp/editor-core";
// Issue 027 — the single px↔mm↔ratio conversion utils + the run-preservation helper, re-exported so a
// host composing the opt-in components by hand shares the SAME conversion point (never re-derives it).
export {
  PX_PER_MM,
  pxToMm,
  mmToPx,
  roundMm,
  boundariesToWidths,
  widthsToRatios,
  boundariesToRatios,
  resizeBoundary,
  inheritRuns,
  firstRunStyle,
} from "@tf-hwp/editor-core";

// R7: the sanitizer is exported so hosts can reuse it, but the components never expose an SVG-string
// prop that bypasses it (all injection goes through HwpPageView → sanitizeSvg).
export { sanitizeSvg } from "./sanitize";

// Platform helpers for the selection UX (issue 021): the additive/toggle modifier label (⌘/Ctrl).
export { isMac, modLabel, hasMod } from "./platform";

// Helpers + types
export { describeIntent } from "./describeIntent";
export {
  screenToPage,
  pageBoxToScreen,
  readViewBox,
} from "./coords";
export type { RectLike, VbLike, ScreenBox, PageBox } from "./coords";
export type {
  Anchor,
  BlockHit,
  TableBox,
  CellHit,
  Intent,
  Outcome,
  OpenResult,
  DocContext,
  OnAiRequest,
  IntentCard,
} from "./types";
