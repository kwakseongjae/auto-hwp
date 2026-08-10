// 077 — the HEADLESS half of the SDK message contract.
//
// editor-core has no React and no DOM, so it cannot read a context: the strings it produces (selection
// ANCHOR labels and Intent preview CARDS) are injected as a plain catalog. Every producer takes it as a
// trailing parameter defaulted to `coreMessagesKoKR`, so an existing caller that passes nothing keeps the
// exact Korean it had (this file is a MOVE, not a rewrite).
//
// `@auto-hwp/react` embeds this under `WorkspaceMessages.core` and hands it to the live `EditorCore`, so a
// host overriding `messages` sees translated anchor chips + op cards too.

/** Labels for the selection anchors/marks a click or marquee produces. */
export interface AnchorMessages {
  /** A cell's grid position — both arguments are 1-based. */
  cellWhere: (row: number, col: number) => string;
  /** A cell with text: the elided snippet + its position. */
  cellSnippet: (snippet: string, where: string) => string;
  /** An empty cell: position only. */
  cellEmpty: (where: string) => string;
  /** A block whose text gives a snippet (paragraph/cell body). */
  snippet: (snippet: string) => string;
  /** A table anchor — `page` is 1-based. */
  tableAt: (page: number) => string;
  /** A paragraph with no readable text — `page` is 1-based. */
  paragraphAt: (page: number) => string;
  /** Any other block kind, keyed by the engine's own kind token ("image"/"table") — `page` is 1-based. */
  blockAt: (kind: string, page: number) => string;
  /** 정밀 선택(이슈 2) — a ROW span of a table, both bounds 1-based inclusive (`8행` / `6~8행`). */
  rowsWhere: (from: number, to: number) => string;
  /** 정밀 선택(이슈 2) — a COLUMN span of a table, both bounds 1-based inclusive (`2열` / `2~4열`). */
  colsWhere: (from: number, to: number) => string;
  /** A WHOLE-row(s) `range` anchor: every column of the row span is included (`표 8행 전체`). */
  rangeWholeRows: (rows: string) => string;
  /** A rectangular cell `range` anchor (`표 2~4행 1~3열`). */
  rangeCells: (rows: string, cols: string) => string;
}

/** Labels + summaries for the Intent preview cards shown before an AI edit is applied. */
export interface IntentCardMessages {
  /** Per-op-kind card label, keyed by Intent kind. An unknown kind falls back to `unknownOp`. */
  op: Record<string, string>;
  /** Card label for an Intent kind we have no entry for. */
  unknownOp: string;
  /** Insert position: a block index, or the section end when the index is null. */
  positionEnd: string;
  positionAt: (index: number) => string;
  /** SetTableCell — row/col are 1-based. */
  setTableCell: (row: number, col: number, text: string) => string;
  tableInsertRows: (count: number, at: number) => string;
  tableAppendRow: string;
  insertTableAt: (rows: number, cols: number, position: string) => string;
  insertParagraphAt: (position: string, text: string) => string;
  /** Chart type words, keyed by the schema's own type token. */
  chartKind: { pie: string; line: string; bar: string };
  insertChartAt: (title: string, kindWord: string, position: string, categories: number, series: number) => string;
  replace: (query: string, replacement: string, all: boolean) => string;
  setParagraphText: (text: string) => string;
  charBoldOn: string;
  charBoldOff: string;
  charItalicOn: string;
  charItalicOff: string;
  charSize: (pt: number) => string;
  charFont: (family: string) => string;
  /** Cell scope suffix — row/col are 1-based. */
  charCell: (row: number, col: number) => string;
  charGeneric: string;
  colWidths: (ratios: string) => string;
  colWidthsGeneric: string;
  pageMargins: (left: string, right: string, top: string, bottom: string) => string;
  applyContent: string;
  deleteBlock: string;
  /** DeleteBlock 원문 preview for a TABLE block (first cell). */
  deleteDetailTable: (firstCell: string) => string;
  /** DeleteBlock 원문 preview when the block has no readable text. */
  deleteDetailUnreadable: string;
}

export interface CoreMessages {
  anchor: AnchorMessages;
  intent: IntentCardMessages;
}

/** The default (and, before 077, the only) catalog — moved verbatim out of selection.ts/describeIntent.ts. */
export const coreMessagesKoKR: CoreMessages = {
  anchor: {
    cellWhere: (row, col) => `${row}행 ${col}열`,
    cellSnippet: (snippet, where) => `“${snippet}” (${where})`,
    cellEmpty: (where) => `표 ${where}`,
    snippet: (snippet) => `“${snippet}”`,
    tableAt: (page) => `표 (p.${page})`,
    paragraphAt: (page) => `문단 (p.${page})`,
    blockAt: (kind, page) => `${kind} (p.${page})`,
    rowsWhere: (from, to) => (from === to ? `${from}행` : `${from}~${to}행`),
    colsWhere: (from, to) => (from === to ? `${from}열` : `${from}~${to}열`),
    rangeWholeRows: (rows) => `표 ${rows} 전체`,
    rangeCells: (rows, cols) => `표 ${rows} ${cols}`,
  },

  intent: {
    op: {
      SetTableCell: "칸 채우기",
      SetCellRangeShade: "음영",
      SetTableCellShade: "음영",
      TableInsertRows: "행 삽입",
      TableAppendRow: "행 추가",
      ApplyContent: "콘텐츠 적용",
      InsertTableAt: "표 삽입",
      InsertParagraphAt: "문단 삽입",
      InsertChartAt: "차트 삽입",
      MoveBlock: "블록 이동",
      DeleteBlock: "블록 삭제",
      SetImageSize: "그림 크기",
      MoveImage: "그림 이동",
      InsertImage: "그림 삽입",
      Replace: "찾아 바꾸기",
      SetParagraphText: "문단 수정",
      SetPageMargins: "페이지 여백",
      SetCharFmt: "글자 서식",
      SetTableColWidths: "열 너비",
    },
    unknownOp: "편집",
    positionEnd: "구역 끝",
    positionAt: (index) => `블록 ${index} 위치`,
    setTableCell: (row, col, text) => `표 ${row}행 ${col}열 → “${text}”`,
    tableInsertRows: (count, at) => `${count}개 행 삽입 (위치 ${at})`,
    tableAppendRow: "마지막 행 구성을 복제한 빈 행 1개 추가",
    insertTableAt: (rows, cols, position) => `${rows}×${cols} 표 삽입 (${position})`,
    insertParagraphAt: (position, text) => `문단 삽입 (${position}) → “${text}”`,
    chartKind: { pie: "원", line: "선", bar: "막대" },
    insertChartAt: (title, kindWord, position, categories, series) =>
      `${title}${kindWord} 차트 삽입 (${position}) — ${categories}개 항목 · ${series}개 계열`,
    replace: (query, replacement, all) => `“${query}” → “${replacement}”${all ? " (전체)" : ""}`,
    setParagraphText: (text) => `문단 텍스트 → “${text}”`,
    charBoldOn: "굵게",
    charBoldOff: "굵게 해제",
    charItalicOn: "기울임",
    charItalicOff: "기울임 해제",
    charSize: (pt) => `크기 ${pt}pt`,
    charFont: (family) => `글꼴 ${family}`,
    charCell: (row, col) => ` (셀 ${row}행 ${col}열)`,
    charGeneric: "글자 서식 변경",
    colWidths: (ratios) => `열 너비 비율 → ${ratios}`,
    colWidthsGeneric: "열 너비 변경",
    pageMargins: (left, right, top, bottom) => `여백(mm) 좌 ${left} · 우 ${right} · 상 ${top} · 하 ${bottom}`,
    applyContent: "AI 콘텐츠 블록 적용 (문서 끝)",
    deleteBlock: "이 블록을 삭제합니다 — 아래 원문을 확인하고 승인하세요",
    deleteDetailTable: (firstCell) => `표 블록 — 첫 셀: “${firstCell}”`,
    deleteDetailUnreadable: "원문을 읽을 수 없는 블록입니다 (빈 문단/그림 등) — 삭제 대상 위치를 확인하세요",
  },
};
