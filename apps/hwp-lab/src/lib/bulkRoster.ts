// 벌크 채움(/bulk) 명단 파싱 — 퍼널 재설계(③ 명단 단계)에서 page.tsx 밖으로 뺀 **순수 로직**.
// 규칙은 옮기기 전과 한 글자도 다르지 않다(오류 문구 포함) — 뷰만 재배치한다는 계약이라
// 여기 테스트(bulkRoster.test.ts)가 그 동치를 잠근다.
//
// 화면이 이 파일에서 필요로 하는 것은 두 가지다:
//  ① parseRoster — 생성 직전 실제로 쓰는 파서(throw = 정직한 거부).
//  ② readRoster  — 타이핑/붙여넣기 중 라이브 미리보기용 안전 래퍼(throw 대신 error 문자열).
//     ③ 명단 단계의 미리보기 표·행수 배지·AI 위저드의 "결과 붙여넣기" 합류 판정이 전부 이걸 쓴다.
import { rosterColumns } from "./bulkFill";

/** 명단 파싱 — 4형식 자동 감지(전부 결정론):
 *  ① JSON 배열  ② "키: 값" 블록 txt(빈 줄로 인원 구분 — 손으로 쓰기 가장 쉬움)
 *  ③ TSV(탭 — 엑셀 복사 붙여넣기)  ④ CSV(콤마 — 따옴표 발견 시 정직 거부, JSON 권장) */
export function parseRoster(text: string): Record<string, string>[] {
  const t = text.trim();
  if (!t) throw new Error("명단이 비어 있습니다");
  if (t.startsWith("[")) {
    const arr = JSON.parse(t) as Record<string, string>[];
    if (!Array.isArray(arr)) throw new Error("JSON은 객체 배열이어야 합니다");
    return arr;
  }
  const lines = t.split(/\r?\n/);
  const first = lines.find((l) => l.trim()) ?? "";
  // ② 키: 값 블록 — 첫 유효 줄이 "키: 값" 꼴이고 구분자(콤마/탭)가 없을 때
  if (/^[^,\t:]{1,20}:\s*\S/.test(first.trim())) {
    const rows: Record<string, string>[] = [];
    let cur: Record<string, string> = {};
    for (const line of [...lines, ""]) {
      const l = line.trim();
      if (!l) {
        if (Object.keys(cur).length) rows.push(cur);
        cur = {};
        continue;
      }
      const i = l.indexOf(":");
      if (i <= 0) throw new Error(`"키: 값" 형식이 아닌 줄: "${l.slice(0, 30)}"`);
      cur[l.slice(0, i).trim()] = l.slice(i + 1).trim();
    }
    if (!rows.length) throw new Error("빈 명단");
    return rows;
  }
  // ③/④ 표 형식
  const delim = first.includes("\t") ? "\t" : ",";
  if (delim === "," && t.includes('"')) throw new Error("CSV에 따옴표가 있습니다 — 내장 콤마/따옴표는 JSON 또는 탭(TSV)으로 넣어주세요");
  const rows = lines.filter((l) => l.trim());
  const header = rows[0].split(delim).map((h) => h.trim());
  return rows.slice(1).map((line, i) => {
    const cells = line.split(delim);
    if (cells.length !== header.length) throw new Error(`${i + 2}행: 열 수 ${cells.length} ≠ 헤더 ${header.length}`);
    return Object.fromEntries(header.map((h, j) => [h, (cells[j] ?? "").trim()]));
  });
}

/** 어느 형식으로 인식됐는지 — 미리보기 배지에 그대로 쓴다("무엇을 읽었는가"를 숨기지 않는다). */
export type RosterFormat = "json" | "block" | "tsv" | "csv";

export interface RosterView {
  /** 파싱 성공 시의 행들(실패·빈 입력이면 []). */
  rows: Record<string, string>[];
  /** 행들에 등장한 열 이름 합집합. */
  columns: string[];
  /** 파싱 실패 사유(정직 거부 문구 그대로). 성공/빈 입력이면 null. */
  error: string | null;
  /** 입력이 공백뿐 — 오류가 아니라 "아직 아무것도 안 넣음". */
  empty: boolean;
  format: RosterFormat | null;
}

/** 입력 텍스트가 어느 형식으로 읽힐지 — parseRoster의 분기와 같은 순서/조건이어야 한다. */
export function detectRosterFormat(text: string): RosterFormat | null {
  const t = text.trim();
  if (!t) return null;
  if (t.startsWith("[")) return "json";
  const first = t.split(/\r?\n/).find((l) => l.trim()) ?? "";
  if (/^[^,\t:]{1,20}:\s*\S/.test(first.trim())) return "block";
  return first.includes("\t") ? "tsv" : "csv";
}

export const ROSTER_FORMAT_LABEL: Record<RosterFormat, string> = {
  json: "JSON 배열",
  block: "키: 값 블록",
  tsv: "엑셀 붙여넣기(탭)",
  csv: "CSV(콤마)",
};

/** 라이브 미리보기용 — 던지지 않는다. 파싱 실패는 error 문자열로 돌려 화면이 그대로 보여준다
 *  (조용한 빈칸 금지: 실패를 "행 0개"로 뭉개지 않는다). */
export function readRoster(text: string): RosterView {
  if (!text.trim()) return { rows: [], columns: [], error: null, empty: true, format: null };
  try {
    const rows = parseRoster(text);
    return { rows, columns: rosterColumns(rows), error: null, empty: false, format: detectRosterFormat(text) };
  } catch (e) {
    return { rows: [], columns: [], error: e instanceof Error ? e.message : String(e), empty: false, format: detectRosterFormat(text) };
  }
}
