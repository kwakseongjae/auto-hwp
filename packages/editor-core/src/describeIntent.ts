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
  ApplyContent: { label: "콘텐츠 적용", icon: "¶" },
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

/** Map an Intent → a preview CARD (kind + icon + human summary + target chip). Pure, so the panel and
 *  tests describe an Intent identically. */
export function describeIntent(intent: Intent): IntentCard {
  const meta = OP_META[intent.intent] ?? { label: intent.intent || "편집", icon: "✎" };
  const section = num(intent.section);
  const block = num(intent.index) ?? num(intent.block) ?? num(intent.from);
  let summary: string;
  switch (intent.intent) {
    case "SetTableCell":
      summary = `표 ${(num(intent.row) ?? 0) + 1}행 ${(num(intent.col) ?? 0) + 1}열 → “${String(intent.text ?? "")}”`;
      break;
    case "TableInsertRows":
      summary = `${num(intent.count) ?? 1}개 행 삽입 (위치 ${num(intent.at) ?? 0})`;
      break;
    case "Replace":
      summary = `“${String(intent.query ?? "")}” → “${String(intent.replacement ?? "")}”${intent.all ? " (전체)" : ""}`;
      break;
    case "SetParagraphText":
      summary = `문단 텍스트 → “${String(intent.text ?? "")}”`;
      break;
    case "ApplyContent":
      summary = "AI 콘텐츠 블록 적용";
      break;
    case "DeleteBlock":
      summary = "이 블록 삭제";
      break;
    default:
      summary = meta.label;
  }
  return { kind: intent.intent, icon: meta.icon, label: meta.label, summary, section, block };
}
