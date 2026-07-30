// 077 — SDK i18n: the typed catalog of EVERY user-visible string the workspace renders.
//
// WHY A TYPE, NOT A RUNTIME LIB: the SDK ships zero i18n dependency (issue 077 결정). A host injects a
// partial catalog through `HwpWorkspaceProps.messages`; anything it omits falls back to `koKR`, which is
// the DEFAULT — a host that passes nothing sees byte-identical Korean chrome.
//
import type { CoreMessages } from "@auto-hwp/editor-core";

// SHAPE RULES (issue 077 수용 기준):
//   - Numbers, shortcut labels, file names, engine errors and other STRUCTURED values are NEVER baked into
//     a string. They arrive as arguments of a FUNCTION message, so a translator can move them freely
//     (`(n) => \`${n} pages\`` vs `(n) => \`${n}쪽\``).
//   - Every key is required. A `koKR` missing a key is a TypeScript error, which is what keeps the
//     catalog and the components in lockstep.
//   - Groups mirror the SURFACE a string appears on, not the file it happens to live in, so shared
//     controls (the format cluster) are overridden once.

/** Recursive partial: a host may override any subtree, down to a single key. Function messages are
 *  LEAVES (replaced wholesale), never structurally descended into. */
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends (...args: never[]) => unknown
    ? T[K]
    : T[K] extends readonly (infer _U)[]
      ? T[K]
      : T[K] extends object
        ? DeepPartial<T[K]>
        : T[K];
};

/** Character-format controls shared by FormatRibbon / FormatToolbar / FloatingToolbar / DesignPanel —
 *  the same words in all four, so a host overrides them ONCE. */
export interface FormatMessages {
  /** Font-family control label ("서체"). */
  fontFamily: string;
  /** Placeholder shown when no family is picked yet. */
  fontFamilyPlaceholder: string;
  /** Font-size control label. */
  fontSize: string;
  /** Ribbon size field tooltip — commit-on-Enter hint. */
  fontSizeHint: string;
  /** Ribbon "−" stepper. */
  sizeDecrease: string;
  /** Ribbon "+" stepper. */
  sizeIncrease: string;
  /** DesignPanel "−" stepper (spelled out). */
  decreaseFontSize: string;
  /** DesignPanel "+" stepper (spelled out). */
  increaseFontSize: string;
  bold: string;
  italic: string;
  underline: string;
  strike: string;
  /** The single glyph drawn INSIDE the B/I/U/S buttons as a live type sample ("가"). */
  sampleGlyph: string;
  textColor: string;
  backgroundColor: string;
  /** Short form used as the color-swatch caption. */
  background: string;
  clearBackground: string;
  /** Alignment group label. */
  align: string;
  alignLeft: string;
  alignCenter: string;
  alignRight: string;
  alignJustify: string;
}

/** FormatRibbon-only chrome (the docked ribbon above the sheet). */
export interface RibbonMessages {
  /** `role="toolbar"` accessible name. */
  toolbarLabel: string;
  /** Mode hint while a live text selection is being styled. */
  modeEditing: string;
  /** Mode hint while a cell/range is selected. */
  modeSelection: string;
}

/** FormatToolbar-only chrome (the floating over-selection bar). */
export interface FormatToolbarMessages {
  /** Tooltip on every control when the selection is not a table cell/range. */
  cellOnlyHint: string;
}

/** FloatingToolbar-only chrome (the selection bubble). */
export interface FloatingToolbarMessages {
  /** The "hand this selection to the AI" button. */
  aiSend: string;
  aiSendTitle: string;
  /** Tooltip when no document is open. */
  aiDisabledTitle: string;
}

export interface FontPickerMessages {
  label: string;
  selectLabel: string;
  /** Option text when nothing is selected yet. */
  placeholder: string;
  /** An uploaded (non-catalog) face shown as the current option. */
  uploadedOption: (family: string) => string;
  /** Suffix marking the bundled default face. */
  bundledSuffix: string;
  uploadTitle: string;
  upload: string;
  currentTitle: (family: string) => string;
  current: (family: string) => string;
  /** A catalog entry that turned out to be a TTC collection. */
  ttcCatalogError: (label: string) => string;
  /** A catalog entry that failed to download. */
  loadError: (label: string) => string;
  /** An uploaded file with a non ttf/otf extension. */
  unsupportedFormat: (fileName: string) => string;
  /** An uploaded file whose bytes are a TTC collection. */
  ttcUploadError: (fileName: string) => string;
}

export interface DesignPanelMessages {
  /** Selection-kind badge, one per engine address kind. */
  kind: {
    paragraph: string;
    cell: string;
    range: string;
    table: string;
    image: string;
    other: string;
  };
  emptyTitle: string;
  emptyHint: string;
  editingTitle: string;
  editingHint: string;
  frameSection: string;
  textSection: string;
  cellSection: string;
  /** Clear the cell background. */
  clear: string;
  /** Note shown when the selection is not a cell/range. */
  cellOnlyNote: string;
}

export interface FindBarMessages {
  label: string;
  queryPlaceholder: string;
  searching: string;
  noResults: string;
  prevTitle: string;
  prevLabel: string;
  nextTitle: string;
  nextLabel: string;
  caseSensitive: string;
  closeTitle: string;
  closeLabel: string;
  replacePlaceholder: string;
  replaceOneTitle: string;
  replaceOne: string;
  replaceAll: string;
  /** The open document has no find lane at all. */
  unsupported: string;
  /** Counting works but match highlighting does not (backend limitation). */
  locateUnsupported: string;
}

export interface OutlinePanelMessages {
  title: string;
  expandTitle: string;
  collapseTitle: string;
  /** Page item label — `page` is 1-based. */
  pageLabel: (page: number) => string;
}

export interface WorkspacePanelMessages {
  label: string;
  openLabel: string;
  closeLabel: string;
  collapseLabel: string;
  tabVibe: string;
  tabDesign: string;
}

export interface StatusBarMessages {
  readOnly: string;
  editMode: string;
  viewMode: string;
  /** Both arguments are 1-based / total counts. */
  pageOf: (page: number, pageCount: number) => string;
  noDocument: string;
}

export interface RulerMessages {
  leftMarginDrag: string;
  leftMargin: string;
  rightMarginDrag: string;
  rightMargin: string;
  /** All three values are millimetres, already rounded. */
  readout: (leftMm: number, rightMm: number, widthMm: number) => string;
}

/** Every table-shaped surface: insert button + size grid, the column-width dialog, the row/column resize
 *  grips, the in-place cell editor and the cell background palette. */
export interface TableMessages {
  insert: string;
  sizePickerLabel: string;
  /** Grid cell accessible name — both counts 1-based. */
  sizeCell: (rows: number, cols: number) => string;
  /** Grid caption once the pointer hovers a size. */
  sizePicked: (rows: number, cols: number) => string;
  /** Grid caption before any hover. */
  sizePlaceholder: string;
  /** Column grip accessible name — `index` is the 1-based interior boundary. */
  colGripLabel: (index: number) => string;
  colGripTitle: string;
  rowGripLabel: (index: number) => string;
  rowGripTitle: string;
  widthDialogLabel: string;
  widthDialogHead: (columnLabel: string) => string;
  /** The column chip the dialog head interpolates — `col` is 1-based. */
  columnLabel: (col: number) => string;
  widthField: string;
  widthApply: string;
  equalizeDisabledTitle: string;
  equalize: (columnCount: number) => string;
  /** `currentMm` arrives pre-formatted to one decimal. */
  widthNote: (currentMm: string) => string;
  shadeCustom: string;
  shadeClearTitle: string;
  shadeClear: string;
  /** Accessible name of the in-place / popover cell editor. */
  cellEditorLabel: string;
  cellPopoverHint: string;
  cellPopoverCancel: string;
  cellPopoverSave: string;
}

export interface ImageOverlayMessages {
  deleteTitle: string;
  delete: string;
}

export interface ChatPanelMessages {
  title: string;
  subtitle: string;
  /** Demo-mode banner — split so the host can keep the `onAiRequest` code token in place. */
  mockBadgePrefix: string;
  mockBadgeSuffix: string;
  /** Empty state — split so "클릭해서 가리키고" can stay bold. */
  emptyPromptPrefix: string;
  emptyPromptStrong: string;
  emptyPromptSuffix: string;
  /** Starter chips that fill the composer. */
  promptChips: readonly string[];
  /** Live agentic timeline phases. */
  statusThinking: string;
  statusSearching: string;
  statusComposing: string;
  searchStep: string;
  /** Bounded conversation memory sent back to the host's model. */
  memoryNoEdits: string;
  memoryProposal: (summary: string) => string;
  /** Destructive (DeleteBlock) card chrome. */
  destructiveBadge: string;
  destructiveBadgeTitle: string;
  targetTitle: string;
  detailTitle: string;
  revealTitle: string;
  reveal: string;
  jumpTitle: string;
  /** `page` is 1-based. */
  jump: (page: number) => string;
  noEdits: string;
  applyWithDelete: string;
  apply: string;
  discard: string;
  applied: string;
  revertTitle: string;
  revertBlockedTitle: string;
  revert: string;
  reverted: string;
  discarded: string;
  openDocFirst: string;
  /** `mod` is the platform modifier label ("⌘" / "Ctrl"). */
  anchorsHint: (mod: string) => string;
  anchorsCount: (count: number) => string;
  clearAnchorsTitle: string;
  clearAnchors: string;
  anchorTitle: (section: number, block: number) => string;
  removeAnchorTitle: string;
  /** Suffix appended to the echoed user turn naming the anchors it rode with. */
  targetSuffix: (labels: string) => string;
  attachmentsHint: string;
  attachmentsCount: (count: number) => string;
  attachmentUnsupported: string;
  removeAttachmentTitle: string;
  attachTitle: string;
  attach: string;
  /** A binary format we cannot extract text from. */
  unsupportedAttachment: string;
  fileReadFailed: string;
  attachLimit: (max: number) => string;
  attachLimitPartial: (max: number, added: number) => string;
  attachReadFailed: (error: string) => string;
  applyFailed: (error: string) => string;
  revertFailed: (error: string) => string;
  placeholderAwaiting: string;
  placeholderAnchored: string;
  placeholder: string;
  send: string;
}

export interface InlineEditMessages {
  label: string;
  title: string;
  targetTitle: string;
  closeTitle: string;
  closeLabel: string;
  placeholder: string;
  /** `mod` is the platform modifier label. */
  hintTitle: (mod: string) => string;
  hint: string;
  apply: string;
  applied: string;
  noEdits: string;
  revertTitle: string;
  revert: string;
  keep: string;
  close: string;
  retry: string;
}

/** Toasts emitted by the `useSelectionActions` cell-range format lane. */
export interface SelectionActionMessages {
  boldOff: string;
  boldOn: string;
  italicOn: string;
  size: (pt: number) => string;
  font: (family: string) => string;
  color: string;
  shadeOn: string;
  shadeOff: string;
  align: string;
}

/** The HwpWorkspace shell: toolbar, canvas, context menu, and every status toast. */
export interface WorkspaceShellMessages {
  /** Toolbar document meta — `format` is already upper-cased ("HWPX"). */
  docMeta: (format: string, pages: number) => string;
  noDocument: string;
  zoomOut: string;
  zoomIn: string;
  undo: string;
  redo: string;
  insertImageTitle: string;
  insertImage: string;
  normalizeOnTitle: string;
  normalizeOffTitle: string;
  normalizeBusy: string;
  normalize: string;
  downloadHtml: string;
  downloadHwpx: string;
  downloadPdf: string;
  dropImageHint: string;
  emptyCanvas: string;
  inlineEditTitle: string;
  inlineEdit: string;
  sendToAiTitle: string;
  sendToAi: string;
  /** Label for a selected image — `page` is 1-based. */
  imageLabel: (page: number) => string;
  /** Fallback paragraph label — `index` is 1-based. */
  paragraphLabel: (index: number) => string;
  /** Multi-selection status summary. */
  selectedCount: (count: number) => string;
  /** Flash label used when jumping to an edit target. */
  revealLabel: string;

  // ── Context menu ───────────────────────────────────────────────────────────────────────────────────
  ctxInsertTable: string;
  ctxEditText: string;
  ctxBold: string;
  ctxBoldOff: string;
  ctxShade: string;
  ctxColumnWidth: string;
  ctxColumnWidthDisabled: string;
  ctxInsertRowAbove: string;
  ctxInsertRowBelow: string;
  ctxSendToAi: string;
  ctxOpenDocFirst: string;

  // ── Ribbon disabled reasons ────────────────────────────────────────────────────────────────────────
  formatMultiSelection: string;
  formatCellUnavailable: string;
  formatSelectCell: string;
  formatLiveOnly: string;
  formatCellOnly: string;

  // ── Engine recovery ────────────────────────────────────────────────────────────────────────────────
  /** An engine trap that the session recovered from. */
  trapRecovered: string;
  /** A trap where the last edit had to be rolled back. */
  trapRecoveredLastUndone: string;
  /** A trapped query (hit-test, caret, menu) — the user can simply retry. */
  recoveredRetry: string;

  // ── Toasts ─────────────────────────────────────────────────────────────────────────────────────────
  /** Document name used when the host supplied none. */
  untitledDocument: string;
  opened: (name: string, pages: number) => string;
  openedNormalized: (name: string, pages: number) => string;
  openFailed: (error: string) => string;
  ttcUnsupported: string;
  fontFailed: (error: string) => string;
  fontApplied: (family: string) => string;
  tableAppended: (rows: number, cols: number) => string;
  tableInsertFailed: (error: string) => string;
  fileReadFailed: string;
  imageOpenDocFirst: string;
  imageReadFailed: string;
  imageInserted: string;
  imageInsertFailed: (error: string) => string;
  imageInsertedSkipped: (skipped: number) => string;
  useOpenButton: string;
  dropTypeUnsupported: string;
  colWidthNotApplied: string;
  colWidthChanged: string;
  colWidthFailed: (error: string) => string;
  shadeFailed: (error: string) => string;
  rowHeightNotApplied: string;
  rowHeightChanged: string;
  rowHeightFailed: (error: string) => string;
  /** Document-wide margin change confirm — all four values in millimetres. */
  marginsConfirm: (leftMm: number, rightMm: number, topMm: number, bottomMm: number) => string;
  marginsChanged: string;
  marginsFailed: (error: string) => string;
  imageResizeNotApplied: string;
  imageResized: string;
  imageResizeFailed: (error: string) => string;
  imageMoveNotApplied: string;
  imageMoved: string;
  imageMoveFailed: (error: string) => string;
  findFailed: (error: string) => string;
  replaced: (count: number) => string;
  replaceNoMatch: string;
  replaceFailed: (error: string) => string;
  textEdited: string;
  textEditFailed: (error: string) => string;
  inputFailed: (error: string) => string;
  formatFailed: (error: string) => string;
  runDesignApplied: string;
  paragraphDesignApplied: string;
  designFailed: (error: string) => string;
  emptyLineAdded: string;
  emptyLineFailed: (error: string) => string;
  deleted: string;
  deleteFailed: (error: string) => string;
  rowInserted: string;
  rowInsertFailed: (error: string) => string;
  appliedEdits: (count: number) => string;
  undone: string;
  undoToast: string;
  redoToast: string;
  undoRedoFailed: (isRedo: boolean, error: string) => string;
  copyUnsupported: string;
  copiedCount: (count: number) => string;
  copied: string;
  copyFailed: (error: string) => string;
  pasteEmpty: string;
  pasted: string;
  pasteNoCaret: string;
  pasteFailed: (error: string) => string;
  clipboardReadFailed: string;
  htmlExportFailed: (error: string) => string;
  hwpxExportFailed: (error: string) => string;
  normalizeOff: string;
  /** Line-spacing report — percentages already rounded by the engine. */
  normalizeReport: (loosePct: number, targetPct: number, paragraphs: number) => string;
  normalizeNoop: string;
  normalizeFailed: (error: string) => string;
  pdfFontRequired: string;
  pdfPlaceholderNote: (count: number) => string;
  pdfFontMissing: string;
  pdfExportFailed: (error: string) => string;
  revealUnsupported: string;
  revealNotFound: string;
  revealFailed: (error: string) => string;
}

/** The headless half (anchor labels + Intent preview cards) lives in `@auto-hwp/editor-core` so a
 *  framework-less host can inject it too — re-exported here as one group of the same catalog. */
export type { AnchorMessages, CoreMessages, IntentCardMessages } from "@auto-hwp/editor-core";

/** The complete injectable catalog. `koKR` is the default; a host overrides any subtree via
 *  `HwpWorkspaceProps.messages` (see `DeepPartial`). */
export interface WorkspaceMessages {
  format: FormatMessages;
  ribbon: RibbonMessages;
  formatToolbar: FormatToolbarMessages;
  floatingToolbar: FloatingToolbarMessages;
  fontPicker: FontPickerMessages;
  design: DesignPanelMessages;
  find: FindBarMessages;
  outline: OutlinePanelMessages;
  panel: WorkspacePanelMessages;
  statusBar: StatusBarMessages;
  ruler: RulerMessages;
  table: TableMessages;
  image: ImageOverlayMessages;
  chat: ChatPanelMessages;
  inlineEdit: InlineEditMessages;
  selectionActions: SelectionActionMessages;
  workspace: WorkspaceShellMessages;
  /** Strings produced by the HEADLESS core: selection anchor/mark labels and the Intent preview cards
   *  (issue 077). Assigned to the live `EditorCore` by `HwpWorkspace`. */
  core: CoreMessages;
}
