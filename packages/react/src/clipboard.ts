/// ⌘C(복사)용 평문 추출 — 순수 함수만. 왜 별도 모듈인가: 클립보드 경로는 **읽기 전용**(대응 op 가 없으므로
/// 붙여넣기는 스코프 밖)이라 엔진/DOM 을 전혀 타지 않는다. 문자열 규칙(표 = TSV, 셀 안 줄바꿈 처리)은
/// 붙여넣기 대상(엑셀/구글시트/한글 표)의 문법이 정하는 것이므로, React 밖에서 단위 테스트로 못 박는다.
import type { TableGrid } from "@auto-hwp/editor-core";

/** 셀 한 칸의 텍스트를 TSV **한 칸**으로 안전하게 만든다. 왜 필요한가: 우리 셀은 여러 문단을 가질 수 있어
 *  `text` 에 `\n` 이 들어올 수 있는데, TSV 에서 `\n` 은 **행 구분자**다 — 그대로 흘리면 붙여넣은 표의
 *  격자가 통째로 어긋난다(한 셀이 새 행이 됨). 탭도 같은 이유로 열 구분자와 충돌한다. 둘 다 공백으로
 *  접어 격자를 지킨다(원문 손실은 표시상 공백 1칸뿐 — 문서는 건드리지 않는다). */
function cellCell(text: string): string {
  return text.replace(/[\t\r\n]+/g, " ");
}

/** 표(또는 표 안 범위)의 그리드를 TSV 로 — 열은 탭, 행은 줄바꿈. 스프레드시트에 그대로 붙여넣으면 격자가
 *  살아난다(사용자가 ⌘C 에 기대하는 것). `rows`/`cols` 는 선택 범위(모델 전역 `[from,to]`, 양끝 포함);
 *  생략하면 표 전체. `grid.cells` 는 **활성(비병합) 셀만** 담으므로, 덮인 칸은 빈 칸으로 채워 열 정렬을
 *  유지한다(칸을 건너뛰면 아래 행과 열이 밀린다). */
export function gridToTsv(grid: TableGrid, rows?: [number, number], cols?: [number, number]): string {
  const r0 = Math.max(0, rows?.[0] ?? 0);
  const r1 = Math.min(grid.rows - 1, rows?.[1] ?? grid.rows - 1);
  const c0 = Math.max(0, cols?.[0] ?? 0);
  const c1 = Math.min(grid.cols - 1, cols?.[1] ?? grid.cols - 1);
  if (r1 < r0 || c1 < c0) return "";
  const at = new Map<string, string>();
  for (const c of grid.cells) at.set(`${c.row}:${c.col}`, c.text ?? "");
  const lines: string[] = [];
  for (let r = r0; r <= r1; r++) {
    const row: string[] = [];
    for (let c = c0; c <= c1; c++) row.push(cellCell(at.get(`${r}:${c}`) ?? ""));
    lines.push(row.join("\t"));
  }
  return lines.join("\n");
}

/** 다중 선택(⌘클릭/마퀴로 모은 블록들)의 조각들을 하나의 클립보드 문자열로. 조각 사이는 줄바꿈:
 *  선택 순서는 알아도 화면상 행/열 배치는 알 수 없으므로 탭으로 이으면 거짓 격자가 된다 — 한 줄에 하나가
 *  정직하다. 빈 조각(빈 셀/빈 문단)은 버려서 유령 빈 줄을 만들지 않는다. 결과가 빈 문자열이면 호출자는
 *  **쓰지 않는다**(사용자의 기존 클립보드를 빈 값으로 덮지 않기 위해 — 규율 6 의 정신). */
export function joinSelectionText(parts: string[]): string {
  return parts.filter((p) => p !== "").join("\n");
}
