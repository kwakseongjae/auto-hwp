import type { Intent, RunSpec } from "./types";

/// ghost.ts — 적용 전 "고스트 프리뷰"의 헤드리스 절반 (이슈 3).
///
/// 문제: 제안 카드는 텍스트("표 1행 4열 → 오또케")와 "위치 보기"(점프+플래시)뿐이라, 사용자는 **적용한
/// 뒤에야** 결과를 본다. 되돌리기가 있어도 "적용→확인→되돌리기"는 신뢰를 깎는다.
///
/// 해법의 순수 절반: Intent[] → 그 편집이 **어디에 무엇을 쓸지**의 목록(GhostTarget[]). 픽셀은 여기
/// 없다 — 주소(section/block/row/col)와 새 텍스트만 낸다. 좌표 해석(주소 → 페이지 + 박스)은 UI 층이
/// 어댑터 기하 질의로 하고, 이 파일은 노드 테스트로 못 박힌다.
///
/// 범위 규율(거짓 프리뷰 금지): **이미 존재하는 자리를 덮어쓰는** 편집만 고스트를 낸다. 삽입/삭제
/// (InsertTableAt·TableInsertRows·DeleteBlock…)는 적용 후에야 자리가 생기거나 사라지므로 재조판 없이
/// 정직하게 그릴 수 없다 — 목록에서 빠지고, 카드는 기존 "위치 보기"로 남는다.

/** ONE ghost target: which model address an Intent overwrites + the text it would put there.
 *  `row`/`col` present ⇒ a table CELL; absent ⇒ the paragraph block itself. `index` is the Intent's
 *  position in the proposal array so the UI can key a hover back to its card. */
export interface GhostTarget {
  index: number;
  section: number;
  block: number;
  row?: number;
  col?: number;
  /** The text the edit would leave in that spot (runs flattened, newlines preserved). */
  text: string;
}

/** Flatten a `RunSpec[]` (or a loose JSON array from the model) to its plain text. */
function runsText(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  let out = "";
  for (const r of value as RunSpec[]) {
    if (!r || typeof r !== "object") continue;
    if (typeof r.text === "string") out += r.text;
  }
  return out;
}

function int(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Map ONE Intent to its ghost target, or null when the op has no pre-existing place to draw on
 *  (insert/delete/format/structural ops — see the scope rule at the top of this file). */
export function intentGhost(intent: Intent, index: number): GhostTarget | null {
  const section = int(intent.section);
  if (section === null) return null;
  switch (intent.intent) {
    case "SetTableCell":
    case "SetTableCellRuns": {
      const block = int(intent.index);
      const row = int(intent.row);
      const col = int(intent.col);
      if (block === null || row === null || col === null) return null;
      const text = intent.intent === "SetTableCell" ? (typeof intent.text === "string" ? intent.text : null) : runsText(intent.runs);
      if (text === null) return null;
      return { index, section, block, row, col, text };
    }
    case "SetParagraphText":
    case "SetParagraphRuns": {
      const block = int(intent.block) ?? int(intent.index);
      if (block === null) return null;
      const text = intent.intent === "SetParagraphText" ? (typeof intent.text === "string" ? intent.text : null) : runsText(intent.runs);
      if (text === null) return null;
      return { index, section, block, text };
    }
    default:
      return null;
  }
}

/** Map a whole proposal to its ghost targets, dropping the ops that cannot be honestly previewed.
 *  Pure — no adapter, no DOM. `index` keeps each target tied to its originating card. */
export function intentGhosts(intents: readonly Intent[]): GhostTarget[] {
  const out: GhostTarget[] = [];
  intents.forEach((intent, i) => {
    const g = intentGhost(intent, i);
    if (g) out.push(g);
  });
  return out;
}

/** How many of a proposal's Intents can be ghost-previewed. The UI uses this to keep the "미리 보기"
 *  toggle HONEST — a proposal with 0 previewable ops must not offer a preview that would draw nothing. */
export function ghostablePct(intents: readonly Intent[]): { previewable: number; total: number } {
  return { previewable: intentGhosts(intents).length, total: intents.length };
}
