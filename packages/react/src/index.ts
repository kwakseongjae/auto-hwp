// @auto-hwp/react — public surface (issue 016). Import the stylesheet once in your app:
//   import "@auto-hwp/react/styles.css";
import "./styles.css";

// Assembly + components
export { HwpWorkspace } from "./components/HwpWorkspace";
export type { HwpWorkspaceProps, WorkspaceDesignSelection, WorkspaceSidePanel, WorkspaceToolbarItem } from "./components/HwpWorkspace";
// 인라인 아이콘 세트(lucide path 사본 — 의존성 0, ISC 표기는 icons.tsx 상단). 호스트가 자기 툴바를
// 조립할 때 SDK와 같은 글리프를 쓸 수 있도록 공개한다.
export * as icons from "./icons";
export type { IconProps } from "./icons";
export { HwpPageView } from "./components/HwpPageView";
export type { HwpPageViewProps, PageClick } from "./components/HwpPageView";
export { SelectionOverlay } from "./components/SelectionOverlay";
export type { SelectionOverlayProps, Mark, Marquee } from "./components/SelectionOverlay";
// Issue 030 — the marquee (rubber-band) as an ISOLATED layer: it subscribes to the core's selection model
// directly, so a drag never re-renders the workspace or the SVG sheets (only the rectangle sweeps).
export { MarqueeLayer } from "./components/MarqueeLayer";
export type { MarqueeLayerProps } from "./components/MarqueeLayer";
// Issue 053 — the blinking CELL TEXT CARET layer (MarqueeLayer's render-0 twin over core.cellCaret).
export { CaretLayer } from "./components/CaretLayer";
export type { CaretLayerProps } from "./components/CaretLayer";
export { CaretRangeLayer } from "./components/CaretRangeLayer";
export type { CaretRangeLayerProps } from "./components/CaretRangeLayer";
export { ImeCompositionLayer } from "./components/ImeCompositionLayer";
export type { ImeCompositionLayerProps } from "./components/ImeCompositionLayer";
export { CompositionStore } from "./composition";
export type { ImeComposition } from "./composition";
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
export { chatSidePanel, workspacePanel } from "./chatSlot";
export type { ChatSlotOptions, WorkspacePanelSlotOptions } from "./chatSlot";
export type { ChatPanelProps } from "./components/ChatPanel";
export { DesignPanel } from "./components/DesignPanel";
export type { DesignPanelProps } from "./components/DesignPanel";
export { WorkspacePanel, WorkspacePanelFrame } from "./components/WorkspacePanel";
export type {
  WorkspacePanelFrameProps,
  WorkspacePanelPresentation,
  WorkspacePanelProps,
  WorkspacePanelTab,
} from "./components/WorkspacePanel";
// Issue 06x — the INLINE per-element vibe-edit panel (apply-then-revert): an alternative to the chat that
// happens directly ON the selected element. HwpWorkspace mounts it from the "✨ 여기서 편집" affordance;
// a host can also compose it over the core (same onAiRequest bridge + one-batch apply + core.session.undo).
export { InlineEditPanel } from "./components/InlineEditPanel";
export type { InlineEditPanelProps } from "./components/InlineEditPanel";
export { FontPicker } from "./components/FontPicker";
export type { FontPickerProps } from "./components/FontPicker";
// Issue 045 — 찾기/바꾸기: the ⌘F capsule (FindBar) + the per-page match highlight layer (FindMatchOverlay).
// HwpWorkspace wires both to the editor-core FindController; a host can also compose them over the core.
export { FindBar } from "./components/FindBar";
export type { FindBarProps } from "./components/FindBar";
export { FindMatchOverlay } from "./components/FindMatchOverlay";
export type { FindMatchOverlayProps } from "./components/FindMatchOverlay";

// Issue 046 — the outline nav (left, collapsible) + the bottom status bar (page X/N · selection · edit
// badge). Individually importable (a host can compose them without HwpWorkspace); the pure helpers
// (activeOutlineIndex / pageAtReference) drive the current-position highlight from a SCROLL-POSITION calc
// that is independent of the 037 virtualization visible set.
export { OutlinePanel } from "./components/OutlinePanel";
export type { OutlinePanelProps } from "./components/OutlinePanel";
export { StatusBar } from "./components/StatusBar";
export type { StatusBarProps } from "./components/StatusBar";
export { activeOutlineIndex, pageAtReference } from "./outline";

// Issue 027 — editing-parity opt-in components. Each is individually importable and drives a single
// @auto-hwp/editor-core command; a host can compose them WITHOUT HwpWorkspace (see the README recipe).
export { ColumnResizeOverlay, RowResizeOverlay } from "./components/ColumnResizeOverlay";
export type { ColumnResizeOverlayProps, RowResizeOverlayProps } from "./components/ColumnResizeOverlay";
// 이슈 2 — 행 머리(스프레드시트식 행 선택 타깃). 클릭=그 행 전체를 `range` 앵커로, Shift+클릭=행 범위.
export { RowHeadOverlay } from "./components/RowHeadOverlay";
export type { RowHeadOverlayProps } from "./components/RowHeadOverlay";
// 이슈 3 — 고스트 프리뷰(적용 전 결과를 대상 자리에 반투명하게). pointer-events:none.
export { GhostPreviewOverlay } from "./components/GhostPreviewOverlay";
export type { GhostPreviewOverlayProps, GhostBox } from "./components/GhostPreviewOverlay";
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
 *  Kept as an export for backward compatibility; HwpWorkspace no longer uses it. Remove only in a major. */
export { CellTextPopover } from "./components/CellTextPopover";
/** @deprecated Since issue 032 — see {@link CellTextPopover}. */
export type { CellTextPopoverProps } from "./components/CellTextPopover";
/** @deprecated HwpWorkspace uses the persistent FormatRibbon. Kept for patch-version SDK compatibility. */
export { FormatToolbar } from "./components/FormatToolbar";
/** @deprecated See {@link FormatToolbar}. */
export type { FormatToolbarProps } from "./components/FormatToolbar";
/** @deprecated HwpWorkspace no longer renders the floating format capsule. Kept for external hosts. */
export { FloatingToolbar } from "./components/FloatingToolbar";
export type { FloatingToolbarProps, ToolbarAlign } from "./components/FloatingToolbar";
export { computeFloatingPosition, unionPageBox } from "./floatingPosition";
export type { FloatViewport, FloatOptions, FloatPlacement, FloatPosition } from "./floatingPosition";

// Issue 048 — the PERSISTENT top format ribbon (선택+편집 겸용): 비편집이면 useSelectionActions(039)로 선택
// 셀/범위 서식 op, 편집 중이면 richedit.applyLiveStyle로 라이브 선택 스타일. Presentational — the host routes
// `onPatch`. HwpWorkspace mounts it in the editing chrome; a custom shell can compose it directly.
export { FormatRibbon } from "./components/FormatRibbon";
export type { FormatRibbonProps, FormatRibbonPatch, RibbonFmt } from "./components/FormatRibbon";

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

// Issue 047 — precise column width (mm) + 균등 분배 dialog, and the 편집 중 셀음영 palette. The dialog is a
// small popover (mm 입력 · 균등 분배); the palette is shown WHILE the in-place editor is open so the current
// cell's background can be set without leaving edit mode. Both are presentational — the mm→px→ratio math
// lives in editor-core units.ts (single conversion point: columnWidthMm/setColumnWidthMm/equalizeColumns).
export { ColumnWidthDialog } from "./components/ColumnWidthDialog";
export type { ColumnWidthDialogProps } from "./components/ColumnWidthDialog";
export { PdfPreviewDialog } from "./components/PdfPreviewDialog";
export type { PdfPreviewDialogProps } from "./components/PdfPreviewDialog";
export { CellShadePalette } from "./components/CellShadePalette";
export type { CellShadePaletteProps } from "./components/CellShadePalette";

// Font system v1 (issue 022): the curated OFL catalog + screen @font-face/alias helpers.
export { FONT_CATALOG, catalogUrl, buildFontFaceCss, svgFontFamilies, isTtc, classifyFont, substituteFamily, SERIF_SUBSTITUTE } from "./fonts";
export type { FontCatalogEntry, FontCategory } from "./fonts";

// Backend seam
export type { EngineAdapter } from "./EngineAdapter";
export { WasmAdapter } from "./WasmAdapter";
// issue 052 — autosave/recovery seam: the host wires a RecoverySnapshotSource (latest autosaved HWPX
// bytes) so a wasm-trap recovery restores the last edit state instead of the original file, observes
// content mutations via `onMutation` (the idle-debounce snapshot trigger), and gets the honest
// recovery report via `onRecovered`.
export type { CodedError, RecoverySnapshot, RecoverySnapshotSource, RecoveryInfo } from "./WasmAdapter";
// issue 055 (FG-14) — worker mode: `new WasmAdapter(wasmUrl, { worker: { url } })` runs the engine in a
// Web Worker (parse/layout/export/toHwpx off the main thread); the adapter surface is unchanged.
export type { WasmAdapterOptions, WasmAdapterWorkerOptions } from "./WasmAdapter";
export { TauriAdapter } from "./TauriAdapter";
export type { TauriAdapterOptions, Invoke } from "./TauriAdapter";

// Headless core (issue 026) — the React binding hook + a re-export of @auto-hwp/editor-core so a host can
// build a fully custom UI over the SAME core (no @auto-hwp/react components required). The heavy editing
// logic lives in editor-core; the components below are a thin, optional binding.
export { useHwpEditor } from "./useHwpEditor";
export type { HwpEditorState } from "./useHwpEditor";
export { createEditorCore, EditorCore, DocSession, SelectionModel, EditController, FindController } from "@auto-hwp/editor-core";
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
  columnWidthMm,
  setColumnWidthMm,
  equalizeColumns,
  // issue 050 — the image-insert size conversion (natural px → HWPUNIT), the SINGLE point a host reuses.
  HWPUNIT_PER_MM,
  mmToHwpUnit,
  DEFAULT_IMAGE_WIDTH_MM,
  imageInsertSize,
  inheritRuns,
  firstRunStyle,
} from "@auto-hwp/editor-core";

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
  AiRequestOptions,
  Anchor,
  Attachment,
  BlockHit,
  Citation,
  TableBox,
  TableGrid,
  GridCell,
  CellHit,
  Intent,
  Outcome,
  OpenResult,
  OutlineItem,
  ProfileHeading,
  ProfileTable,
  DocProfile,
  DocContext,
  OnAiRequest,
  IntentCard,
  FindMatch,
  FindOptions,
  FindReplaceOptions,
  ReplaceResult,
  MatchBox,
} from "./types";

// i18n (issue 077) — the injectable message catalog. `HwpWorkspaceProps.messages` takes a DeepPartial of
// `WorkspaceMessages`; anything omitted falls back to `koKR`. `WorkspaceMessagesProvider` is only needed
// for components mounted OUTSIDE HwpWorkspace (a standalone ChatPanel, a host-composed toolbar).
export {
  koKR,
  mergeMessages,
  useMergedMessages,
  useWorkspaceMessages,
  WorkspaceMessagesContext,
  WorkspaceMessagesProvider,
} from "./i18n";
export type {
  ChatPanelMessages,
  DeepPartial,
  DesignPanelMessages,
  FindBarMessages,
  FloatingToolbarMessages,
  FontPickerMessages,
  FormatMessages,
  FormatToolbarMessages,
  ImageOverlayMessages,
  InlineEditMessages,
  OutlinePanelMessages,
  RibbonMessages,
  RulerMessages,
  SelectionActionMessages,
  StatusBarMessages,
  TableMessages,
  WorkspaceMessages,
  WorkspaceMessagesProviderProps,
  WorkspacePanelMessages,
  WorkspaceShellMessages,
} from "./i18n";
