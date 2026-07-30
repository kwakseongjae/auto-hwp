import type { Intent, IntentCard } from "./types";
import { coreMessagesKoKR, type IntentCardMessages } from "./messages";

// Per-op-kind label + glyph for the proposal preview CARD header (010식). Pure Intent→card mapping — no
// DOM — so both the UI panel and headless callers describe an Intent identically. DESCENDED from
// @auto-hwp/react (issue 026); @auto-hwp/react re-exports it (backward compatible). Unknown kinds fall back
// to a generic "편집" card.
// The GLYPH per op kind. Icons are language-neutral so they stay here; the LABEL comes from the
// injected catalog (`IntentCardMessages.op`) — issue 077.
const OP_ICON: Record<string, string> = {
  SetTableCell: "▣",
  SetCellRangeShade: "◧",
  SetTableCellShade: "◧",
  TableInsertRows: "▤",
  TableAppendRow: "▤",
  ApplyContent: "¶",
  InsertTableAt: "▦",
  InsertParagraphAt: "¶",
  InsertChartAt: "📊",
  MoveBlock: "↕",
  DeleteBlock: "－",
  SetImageSize: "🖼",
  MoveImage: "🖼",
  InsertImage: "🖼",
  Replace: "⇄",
  SetParagraphText: "✎",
  SetPageMargins: "▭",
  SetCharFmt: "Ａ",
  SetTableColWidths: "↔",
};

function num(v: unknown): number | null {
  return typeof v === "number" ? v : null;
}

// Human-readable insert position: `index` is a block index; null/absent = the section end (the
// InsertTableAt/InsertParagraphAt `index: null` anchor — INTENT-SCHEMA §6.9).
function positionLabel(index: number | null, m: IntentCardMessages): string {
  return index === null ? m.positionEnd : m.positionAt(index);
}

// Elide long original text for the delete card (원문은 카드에 다 안 들어간다 — 앞부분만).
function elide(text: string, max = 120): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Map an Intent → a preview CARD (kind + icon + human summary + target chip). Pure, so the panel and
 *  tests describe an Intent identically. Issue 051: structural inserts summarize POSITION + CONTENT
 *  (표 크기/문단 텍스트), and `DeleteBlock` is flagged `destructive` so the UI renders a warning card
 *  (the 원문 detail is fetched asynchronously by `EditController.previewCards` — this stays pure). */
export function describeIntent(intent: Intent, messages: IntentCardMessages = coreMessagesKoKR.intent): IntentCard {
  const m = messages;
  // `|| m.unknownOp` (not `??`): an EMPTY kind must fall back too — the pre-077 behaviour.
  const meta = { label: m.op[intent.intent] ?? (intent.intent || m.unknownOp), icon: OP_ICON[intent.intent] ?? "✎" };
  const section = num(intent.section);
  const block = num(intent.index) ?? num(intent.block) ?? num(intent.from);
  let summary: string;
  let destructive: boolean | undefined;
  switch (intent.intent) {
    case "SetTableCell":
      summary = m.setTableCell((num(intent.row) ?? 0) + 1, (num(intent.col) ?? 0) + 1, String(intent.text ?? ""));
      break;
    case "TableInsertRows":
      summary = m.tableInsertRows(num(intent.count) ?? 1, num(intent.at) ?? 0);
      break;
    case "TableAppendRow":
      summary = m.tableAppendRow;
      break;
    case "InsertTableAt": {
      const rows = Array.isArray(intent.rows) ? (intent.rows as unknown[][]) : [];
      const cols = rows.reduce((m, r) => Math.max(m, Array.isArray(r) ? r.length : 0), 0);
      summary = m.insertTableAt(rows.length, cols, positionLabel(num(intent.index), m));
      break;
    }
    case "InsertParagraphAt": {
      const runs = Array.isArray(intent.runs) ? (intent.runs as { text?: unknown }[]) : [];
      const text = runs.map((r) => String(r?.text ?? "")).join("");
      summary = m.insertParagraphAt(positionLabel(num(intent.index), m), elide(text, 60));
      break;
    }
    case "InsertChartAt": {
      // AI-generated data chart (062-follow): summarize type + data shape (categories × series).
      const chart = (intent.chart ?? {}) as { type?: unknown; title?: unknown; categories?: unknown; series?: unknown };
      const kindWord = chart.type === "pie" ? m.chartKind.pie : chart.type === "line" ? m.chartKind.line : m.chartKind.bar;
      const cats = Array.isArray(chart.categories) ? chart.categories.length : 0;
      const sers = Array.isArray(chart.series) ? chart.series.length : 0;
      const title = typeof chart.title === "string" && chart.title.trim() ? `“${elide(chart.title, 40)}” ` : "";
      summary = m.insertChartAt(title, kindWord, positionLabel(num(intent.index), m), cats, sers);
      break;
    }
    case "Replace":
      summary = m.replace(String(intent.query ?? ""), String(intent.replacement ?? ""), !!intent.all);
      break;
    case "SetParagraphText":
      summary = m.setParagraphText(String(intent.text ?? ""));
      break;
    // 067-follow (진단 U4): 문서 전역 편집 4종 — 카드가 바뀌는 값을 정확히 보여줘야 사용자가
    // 프리뷰만으로 승인/거부를 판단할 수 있다 (generic "편집" 카드 금지).
    case "SetCharFmt": {
      const parts: string[] = [];
      if (typeof intent.bold === "boolean") parts.push(intent.bold ? m.charBoldOn : m.charBoldOff);
      if (typeof intent.italic === "boolean") parts.push(intent.italic ? m.charItalicOn : m.charItalicOff);
      if (typeof intent.size_pt === "number") parts.push(m.charSize(intent.size_pt));
      if (typeof intent.font === "string" && intent.font) parts.push(m.charFont(intent.font));
      const cell = Array.isArray(intent.cell) && intent.cell.length === 2 ? m.charCell(Number(intent.cell[0]) + 1, Number(intent.cell[1]) + 1) : "";
      summary = `${parts.length ? parts.join(" · ") : m.charGeneric}${cell}`;
      break;
    }
    case "SetTableColWidths": {
      const w = Array.isArray(intent.widths) ? (intent.widths as unknown[]).map(String).join(" : ") : "";
      summary = w ? m.colWidths(w) : m.colWidthsGeneric;
      break;
    }
    case "SetPageMargins":
      summary = m.pageMargins(String(num(intent.left_mm) ?? "?"), String(num(intent.right_mm) ?? "?"), String(num(intent.top_mm) ?? "?"), String(num(intent.bottom_mm) ?? "?"));
      break;
    case "ApplyContent":
      summary = m.applyContent;
      break;
    case "DeleteBlock":
      summary = m.deleteBlock;
      destructive = true;
      break;
    default:
      summary = meta.label;
  }
  return { kind: intent.intent, icon: meta.icon, label: meta.label, summary, section, block, ...(destructive ? { destructive } : {}) };
}

/** The 원문(original text) of the block a DeleteBlock intent targets, read through a runs resolver
 *  (`DocSession.runsAt`-shaped). Tries the block as a PARAGRAPH first, then as a TABLE via its (0,0)
 *  cell; an unreadable/empty block yields an HONEST placeholder (never a fabricated preview). Pure over
 *  the injected reader so node tests pin it without a real engine. */
export async function deleteBlockDetail(
  runsAt: (section: number, block: number, row?: number, col?: number) => Promise<{ text?: string }[]>,
  section: number,
  block: number,
  messages: IntentCardMessages = coreMessagesKoKR.intent,
): Promise<string> {
  const joined = (runs: { text?: string }[]) => runs.map((r) => String(r.text ?? "")).join("");
  try {
    const para = joined(await runsAt(section, block));
    if (para.trim().length > 0) return elide(para);
    const cell = joined(await runsAt(section, block, 0, 0));
    if (cell.trim().length > 0) return elide(messages.deleteDetailTable(cell));
  } catch {
    /* fall through to the honest placeholder */
  }
  return messages.deleteDetailUnreadable;
}
