// @auto-hwp/editor-core — headless, framework-agnostic editor core (SDK-LAYERS L2). No React, no DOM.
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
  // 정밀 선택(이슈 2) — the `range` anchor label/text builders (row + cell-range chips).
  rangeLabel,
  rangeText,
} from "./selection";
export type { SelectResult, CellDir } from "./selection";

// 고스트 프리뷰(이슈 3) — Intent[] → "어디에 무엇을 쓸지" 목록. 픽셀 없음(UI 가 주소를 기하로 푼다).
export { intentGhost, intentGhosts, ghostablePct } from "./ghost";
export type { GhostTarget } from "./ghost";

// Edit assembly / preview / apply + the issue-027 manual edit command types
export { EditController } from "./edit";
export type { CellRange, CellFmt, PageMarginsMm } from "./edit";
export { describeIntent } from "./describeIntent";
// 077 — the headless string catalog (anchor labels + Intent preview cards). Every producer defaults to
// `coreMessagesKoKR`; a host swaps it wholesale via `EditorCore.setMessages`.
export { coreMessagesKoKR } from "./messages";
export type { AnchorMessages, CoreMessages, IntentCardMessages } from "./messages";

// Unit conversion (issue 027) — the SINGLE px↔mm↔ratio point the ruler + column-resize share.
export {
  PX_PER_MM,
  HWPUNIT_PER_PX,
  HWPUNIT_PER_MM,
  mmToHwpUnit,
  DEFAULT_IMAGE_WIDTH_MM,
  imageInsertSize,
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
  columnWidthMm,
  setColumnWidthMm,
  equalizeColumns,
  imageSizeToHwpunit,
  resizeImageBox,
  appliedReflectsResize,
} from "./units";
export type { XYWH, ImageHandle } from "./units";

// Run-format preservation (issue 027) — the pure text-edit inheritance rule.
export { inheritRuns, firstRunStyle } from "./runs";
export type { RunStyle } from "./runs";

// Find/Replace controller (issue 045) — search/next/prev/replaceCurrent/replaceAll + caretRect-derived
// match geometry (locate/locateAll). Drives the adapter's find/replace surface; UI-agnostic (node-tested).
export { FindController } from "./find";

// Glyph-caret model (issue 041, FG-12 前半) — pure HitResult→TextAnchor + the para_len clamp / null policy.
export { clampOffset, hitResultToTextAnchor, isCaretGap } from "./caret";

// Cell-addressed glyph caret (issue 053, FG-12 後半) — the headless controller (click → caret →
// per-keystroke SetTableCellRuns commits) + its pure joined-offset/run-splice helpers.
export {
  CellCaretController,
  cellGlobalOffset,
  cellParaOffsetAt,
  inheritStyleAt,
  rangeHasStyle,
  runsText,
  spliceRuns,
  styleRunRange,
} from "./cellCaret";
export type { CellCaretAnchor, CellCaretState, ToggleKey } from "./cellCaret";

// 본문 문단 캐럿 — 셀 밖 문단의 클릭/이동/타이핑(SetParagraphRuns 커밋) + 페이지 SVG 글리프 ↔ 모델 문자
// 정렬의 순수 헬퍼(정렬 실패 = null, 018).
export {
  alignCharBoxes,
  bodyCaretRectAt,
  bodyLineMove,
  bodyOffsetAtPoint,
  BodyCaretController,
  emptyParaBoxes,
  glyphsInBand,
  parsePageGlyphs,
} from "./bodyCaret";
export type { BodyCaretAnchor, BodyCaretState, CharBox, PageGlyph } from "./bodyCaret";

// 캐럿 **범위 선택**(셀∪본문 공통 규약) — {anchor, focus} 정규화 + 줄별 하이라이트 사각형 산출.
export { rectsByProbe, rectsFromCharBoxes, selCollapsed, selRange } from "./caretRange";
export type { RangeRect, RectProbe, SelRange } from "./caretRange";

// 캐럿 라우터 — 셀/본문 캐럿을 하나의 표면으로(오버레이·타이핑이 구독하는 단일 store).
export { CaretRouter } from "./caretRouter";
export type { ActiveCaret, CaretKind } from "./caretRouter";

// Event emitter primitive
export { Emitter } from "./events";
export type { Listener } from "./events";

// Types
export { canonicalProposalDigest } from "./proposal";
export type { ProposalDigestMaterial } from "./proposal";
export type {
  AffectedAddress,
  AgentEvent,
  AiRequestOptions,
  Anchor,
  Attachment,
  BlockHit,
  Box,
  CaretRect,
  ChatTurn,
  Citation,
  CellAddr,
  CellCaretRect,
  CellHit,
  CellTextHit,
  DocContext,
  FindMatch,
  FindOptions,
  FindReplaceOptions,
  GridCell,
  HitResult,
  ImageBox,
  Intent,
  IntentCard,
  MatchBox,
  NormalizeReport,
  OnAiRequest,
  OpenResult,
  Outcome,
  OutlineItem,
  PageGeom,
  ProposalCapabilities,
  SemanticDiffEvidence,
  LayoutEvidence,
  PageArtifactEvidence,
  PdfArtifactEvidence,
  VerificationReportV1,
  ProposalV1,
  PointerInput,
  ProfileHeading,
  ProfileTable,
  DocProfile,
  ReplaceResult,
  RunSpec,
  Selection,
  SelMark,
  SelMarquee,
  TableBox,
  TableGrid,
  TextAnchor,
} from "./types";
