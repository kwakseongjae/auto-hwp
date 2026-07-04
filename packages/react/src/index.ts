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
// Issue 030 — the marquee (rubber-band) as an ISOLATED layer: it subscribes to the core's selection model
// directly, so a drag never re-renders the workspace or the SVG sheets (only the rectangle sweeps).
export { MarqueeLayer } from "./components/MarqueeLayer";
export type { MarqueeLayerProps } from "./components/MarqueeLayer";
// Issue 038 — the hover PRE-HIGHLIGHT layer (FG-09) + the cursor system (FG-06). HoverLayer is MarqueeLayer's
// twin (subscribes to a HoverStore, draws by ref → 0 workspace/sheet renders); useHover owns the pointermove
// → hit-test → store pipeline; cursorForContext is the single pure hit-kind → cursor mapping.
export { HoverLayer } from "./components/HoverLayer";
export type { HoverLayerProps } from "./components/HoverLayer";
export { useHover } from "./useHover";
export type { UseHoverParams, UseHoverResult } from "./useHover";
export { HoverStore, cursorForContext, pointInBox, sameHighlight } from "./hover";
export type { HoverHighlight, HoverCursor, CursorContext } from "./hover";
export { ChatPanel } from "./components/ChatPanel";
export type { ChatPanelProps } from "./components/ChatPanel";
export { FontPicker } from "./components/FontPicker";
export type { FontPickerProps } from "./components/FontPicker";

// Issue 027 — editing-parity opt-in components. Each is individually importable and drives a single
// @tf-hwp/editor-core command; a host can compose them WITHOUT HwpWorkspace (see the README recipe).
export { ColumnResizeOverlay, RowResizeOverlay } from "./components/ColumnResizeOverlay";
export type { ColumnResizeOverlayProps, RowResizeOverlayProps } from "./components/ColumnResizeOverlay";
export { TableInsertButton } from "./components/TableInsertButton";
export type { TableInsertButtonProps } from "./components/TableInsertButton";
export { Ruler } from "./components/Ruler";
export type { RulerProps } from "./components/Ruler";
// Issue 032 — the Figma-style IN-PLACE cell/paragraph editor + its pure positioning helper. HwpWorkspace's
// enableEditing path now opens THIS over the cell rect (no popover card). CellTextPopover below is kept for
// backward compatibility only (deprecated).
export { InPlaceCellEditor, computeInPlaceEditorStyle, PAGE_PX_PER_PT } from "./components/InPlaceCellEditor";
export type { InPlaceCellEditorProps, InPlaceEditorStyle } from "./components/InPlaceCellEditor";
// Issue 040 — the rich in-place editor's run↔DOM helpers (ported from the desktop richedit). runsToHtml
// renders styled runs into a contentEditable; serializeEditor reads the edited DOM back to RunSpec[];
// runsUnchanged is the commit no-op check. Exported so a host building a custom editor reuses the SAME
// lossless round-trip (and tests can pin it). applyLiveStyle formats the live selection (⌘B/⌘I/⌘U/⌘⇧S).
export {
  runsToHtml,
  serializeEditor,
  runsText,
  runsEqual,
  canonRuns,
  runsUnchanged,
  readCaretStyle,
  applyLiveStyle,
  saveInlineSelection,
  sizePx,
} from "./richedit";
export type { ParaIndent } from "./richedit";
/** @deprecated Since issue 032 — superseded by {@link InPlaceCellEditor} (in-place, no popover card).
 *  Kept as an export for backward compatibility; HwpWorkspace no longer uses it. */
export { CellTextPopover } from "./components/CellTextPopover";
/** @deprecated Since issue 032 — see {@link CellTextPopover}. */
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

// Issue 039 — the right-click CONTEXT MENU (셀/문단/바탕 3분기) + the shared selection-action set + the
// pure viewport clamp. Every menu action delegates to an existing intent/EditController path (신규 op 0);
// the shared `useSelectionActions` is what the 028 FloatingToolbar and the menu BOTH drive (중복 코드 금지).
export { ContextMenu } from "./components/ContextMenu";
export type { ContextMenuProps, ContextMenuItem } from "./components/ContextMenu";
export { TableSizeGrid } from "./components/TableSizeGrid";
export type { TableSizeGridProps } from "./components/TableSizeGrid";
export { useSelectionActions } from "./useSelectionActions";
export type { SelectionActions, SelectionActionTarget, SelectionRange } from "./useSelectionActions";
export { clampMenuPosition } from "./contextMenuPosition";
export type { MenuViewport, MenuPosition } from "./contextMenuPosition";

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

// Issue 035 — the PURE pan/zoom viewport math (cursor-anchored zoom + grab-hand pan + wheel/pinch factor +
// the Space guard). HwpWorkspace owns the DOM wiring; a host building a custom viewport reuses these.
export {
  ZOOM_MIN,
  ZOOM_MAX,
  ZOOM_STEP,
  clampZoom,
  zoomAt,
  panBy,
  wheelToZoomFactor,
  isEditableTarget,
  fixedPointScreenX,
  fixedPointScreenY,
} from "./viewport";
export type { ZoomAtInput, ZoomAtResult, ScrollOffset } from "./viewport";

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
