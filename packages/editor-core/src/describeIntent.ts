import type { Intent, IntentCard } from "./types";

// Per-op-kind label + glyph for the proposal preview CARD header (010식). Pure Intent→card mapping — no
// DOM — so both the UI panel and headless callers describe an Intent identically. DESCENDED from
// @auto-hwp/react (issue 026); @auto-hwp/react re-exports it (backward compatible). Unknown kinds fall back
// to a generic "편집" card.
const OP_META: Record<string, { label: string; icon: string }> = {
  SetTableCell: { label: "칸 채우기", icon: "▣" },
  SetCellRangeShade: { label: "음영", icon: "◧" },
  SetTableCellShade: { label: "음영", icon: "◧" },
  TableInsertRows: { label: "행 삽입", icon: "▤" },
  TableAppendRow: { label: "행 추가", icon: "▤" },
  ApplyContent: { label: "콘텐츠 적용", icon: "¶" },
  InsertTableAt: { label: "표 삽입", icon: "▦" },
  InsertParagraphAt: { label: "문단 삽입", icon: "¶" },
  InsertChartAt: { label: "차트 삽입", icon: "📊" },
  MoveBlock: { label: "블록 이동", icon: "↕" },
  DeleteBlock: { label: "블록 삭제", icon: "－" },
  SetImageSize: { label: "그림 크기", icon: "🖼" },
  MoveImage: { label: "그림 이동", icon: "🖼" },
  InsertImage: { label: "그림 삽입", icon: "🖼" },
  Replace: { label: "찾아 바꾸기", icon: "⇄" },
  SetParagraphText: { label: "문단 수정", icon: "✎" },
  SetPageMargins: { label: "페이지 여백", icon: "▭" },
  SetCharFmt: { label: "글자 서식", icon: "Ａ" },
  SetTableColWidths: { label: "열 너비", icon: "↔" },
};

function num(v: unknown): number | null {
  return typeof v === "number" ? v : null;
}

// Human-readable insert position: `index` is a block index; null/absent = the section end (the
// InsertTableAt/InsertParagraphAt `index: null` anchor — INTENT-SCHEMA §6.9).
function positionLabel(index: number | null): string {
  return index === null ? "구역 끝" : `블록 ${index} 위치`;
}

// Elide long original text for the delete card (원문은 카드에 다 안 들어간다 — 앞부분만).
function elide(text: string, max = 120): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Map an Intent → a preview CARD (kind + icon + human summary + target chip). Pure, so the panel and
 *  tests describe an Intent identically. Issue 051: structural inserts summarize POSITION + CONTENT
 *  (표 크기/문단 텍스트), and `DeleteBlock` is flagged `destructive` so the UI renders a warning card
 *  (the 원문 detail is fetched asynchronously by `EditController.previewCards` — this stays pure). */
export function describeIntent(intent: Intent): IntentCard {
  const meta = OP_META[intent.intent] ?? { label: intent.intent || "편집", icon: "✎" };
  const section = num(intent.section);
  const block = num(intent.index) ?? num(intent.block) ?? num(intent.from);
  let summary: string;
  let destructive: boolean | undefined;
  switch (intent.intent) {
    case "SetTableCell":
      summary = `표 ${(num(intent.row) ?? 0) + 1}행 ${(num(intent.col) ?? 0) + 1}열 → “${String(intent.text ?? "")}”`;
      break;
    case "TableInsertRows":
      summary = `${num(intent.count) ?? 1}개 행 삽입 (위치 ${num(intent.at) ?? 0})`;
      break;
    case "TableAppendRow":
      summary = "마지막 행 구성을 복제한 빈 행 1개 추가";
      break;
    case "InsertTableAt": {
      const rows = Array.isArray(intent.rows) ? (intent.rows as unknown[][]) : [];
      const cols = rows.reduce((m, r) => Math.max(m, Array.isArray(r) ? r.length : 0), 0);
      summary = `${rows.length}×${cols} 표 삽입 (${positionLabel(num(intent.index))})`;
      break;
    }
    case "InsertParagraphAt": {
      const runs = Array.isArray(intent.runs) ? (intent.runs as { text?: unknown }[]) : [];
      const text = runs.map((r) => String(r?.text ?? "")).join("");
      summary = `문단 삽입 (${positionLabel(num(intent.index))}) → “${elide(text, 60)}”`;
      break;
    }
    case "InsertChartAt": {
      // AI-generated data chart (062-follow): summarize type + data shape (categories × series).
      const chart = (intent.chart ?? {}) as { type?: unknown; title?: unknown; categories?: unknown; series?: unknown };
      const kindWord =
        chart.type === "pie" ? "원" : chart.type === "line" ? "선" : "막대";
      const cats = Array.isArray(chart.categories) ? chart.categories.length : 0;
      const sers = Array.isArray(chart.series) ? chart.series.length : 0;
      const title = typeof chart.title === "string" && chart.title.trim() ? `“${elide(chart.title, 40)}” ` : "";
      summary = `${title}${kindWord} 차트 삽입 (${positionLabel(num(intent.index))}) — ${cats}개 항목 · ${sers}개 계열`;
      break;
    }
    case "Replace":
      summary = `“${String(intent.query ?? "")}” → “${String(intent.replacement ?? "")}”${intent.all ? " (전체)" : ""}`;
      break;
    case "SetParagraphText":
      summary = `문단 텍스트 → “${String(intent.text ?? "")}”`;
      break;
    // 067-follow (진단 U4): 문서 전역 편집 4종 — 카드가 바뀌는 값을 정확히 보여줘야 사용자가
    // 프리뷰만으로 승인/거부를 판단할 수 있다 (generic "편집" 카드 금지).
    case "SetCharFmt": {
      const parts: string[] = [];
      if (typeof intent.bold === "boolean") parts.push(intent.bold ? "굵게" : "굵게 해제");
      if (typeof intent.italic === "boolean") parts.push(intent.italic ? "기울임" : "기울임 해제");
      if (typeof intent.size_pt === "number") parts.push(`크기 ${intent.size_pt}pt`);
      if (typeof intent.font === "string" && intent.font) parts.push(`글꼴 ${intent.font}`);
      const cell = Array.isArray(intent.cell) && intent.cell.length === 2 ? ` (셀 ${Number(intent.cell[0]) + 1}행 ${Number(intent.cell[1]) + 1}열)` : "";
      summary = `${parts.length ? parts.join(" · ") : "글자 서식 변경"}${cell}`;
      break;
    }
    case "SetTableColWidths": {
      const w = Array.isArray(intent.widths) ? (intent.widths as unknown[]).map(String).join(" : ") : "";
      summary = w ? `열 너비 비율 → ${w}` : "열 너비 변경";
      break;
    }
    case "SetPageMargins":
      summary = `여백(mm) 좌 ${num(intent.left_mm) ?? "?"} · 우 ${num(intent.right_mm) ?? "?"} · 상 ${num(intent.top_mm) ?? "?"} · 하 ${num(intent.bottom_mm) ?? "?"}`;
      break;
    case "ApplyContent":
      summary = "AI 콘텐츠 블록 적용 (문서 끝)";
      break;
    case "DeleteBlock":
      summary = "이 블록을 삭제합니다 — 아래 원문을 확인하고 승인하세요";
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
): Promise<string> {
  const joined = (runs: { text?: string }[]) => runs.map((r) => String(r.text ?? "")).join("");
  try {
    const para = joined(await runsAt(section, block));
    if (para.trim().length > 0) return elide(para);
    const cell = joined(await runsAt(section, block, 0, 0));
    if (cell.trim().length > 0) return elide(`표 블록 — 첫 셀: “${cell}”`);
  } catch {
    /* fall through to the honest placeholder */
  }
  return "원문을 읽을 수 없는 블록입니다 (빈 문단/그림 등) — 삭제 대상 위치를 확인하세요";
}
