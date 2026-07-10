import type { Intent, IntentCard } from "./types";

// Per-op-kind label + glyph for the proposal preview CARD header (010식). Pure Intent→card mapping — no
// DOM — so both the UI panel and headless callers describe an Intent identically. DESCENDED from
// @tf-hwp/react (issue 026); @tf-hwp/react re-exports it (backward compatible). Unknown kinds fall back
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
  MoveBlock: { label: "블록 이동", icon: "↕" },
  DeleteBlock: { label: "블록 삭제", icon: "－" },
  SetImageSize: { label: "그림 크기", icon: "🖼" },
  MoveImage: { label: "그림 이동", icon: "🖼" },
  InsertImage: { label: "그림 삽입", icon: "🖼" },
  Replace: { label: "찾아 바꾸기", icon: "⇄" },
  SetParagraphText: { label: "문단 수정", icon: "✎" },
  SetPageMargins: { label: "페이지 여백", icon: "▭" },
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
    case "Replace":
      summary = `“${String(intent.query ?? "")}” → “${String(intent.replacement ?? "")}”${intent.all ? " (전체)" : ""}`;
      break;
    case "SetParagraphText":
      summary = `문단 텍스트 → “${String(intent.text ?? "")}”`;
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
