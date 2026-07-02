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

// Font system v1 (issue 022): the curated OFL catalog + screen @font-face/alias helpers.
export { FONT_CATALOG, catalogUrl, buildFontFaceCss, svgFontFamilies, isTtc } from "./fonts";
export type { FontCatalogEntry } from "./fonts";

// Backend seam
export type { EngineAdapter } from "./EngineAdapter";
export { WasmAdapter } from "./WasmAdapter";
export type { CodedError } from "./WasmAdapter";
export { TauriAdapter } from "./TauriAdapter";
export type { TauriAdapterOptions, Invoke } from "./TauriAdapter";

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
  Intent,
  Outcome,
  OpenResult,
  DocContext,
  OnAiRequest,
  IntentCard,
} from "./types";
