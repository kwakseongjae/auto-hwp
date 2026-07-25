// 캐럿 **범위 선택**의 공용 절반 — 셀 캐럿(053)과 본문 문단 캐럿이 같은 규약을 쓰게 만드는 모듈.
//
// ## 모델: `{anchor, focus}` (DOM Selection 과 같은 규약)
// 캐럿은 지금까지 오프셋 **하나**였다. 범위를 열려면 두 개가 필요하다:
//   · `selAnchor` = 고정단(shift 를 누르기 시작한 자리),
//   · `offset`    = 이동단(focus, 캐럿 막대가 그려지는 자리).
// 둘이 같으면 그냥 캐럿이다. `offset` 의 의미가 그대로라 기존 코드(캐럿 사각형/커밋/IME)는 손대지 않아도
// 되고, 확장은 **additive** 다 — 새 필드 하나뿐.
//
// ## 기하: 두 캐럿이 자리를 아는 방식이 달라 하이라이트 산출도 둘이다
//   · 본문 캐럿은 문자별 `CharBox`(페이지 SVG 글리프 정렬)를 이미 갖고 있다 → **정확**하게 줄별로 자른다.
//   · 셀 캐럿은 엔진 `caretRectCell(offset)` 밖에 없다 → 오프셋을 훑어(probe) 같은 줄끼리 묶는다.
//     ⚠️ 엔진 계약상 "줄바꿈 경계의 오프셋은 **다음 줄 시작**"(place.rs cell_caret_rect)이라, 줄이 접힌
//     지점에서 그 줄 마지막 글자의 폭만큼이 관측되지 않는다 — 그 줄에서 관측된 마지막 advance 로 메운다
//     (한글/한자는 등폭이라 정확, 라틴은 근사). 캐럿 막대 자체는 언제나 엔진 값이라 영향받지 않는다.

import type { CellCaretRect } from "./types";

/** 정규화된 선택 구간 `[start, end)` — `start === end` 면 범위가 없다(캐럿). */
export interface SelRange {
  start: number;
  end: number;
}

/** `{anchor, focus}` → 정규화 구간. 어느 쪽으로 끌었든 같은 답을 준다. */
export function selRange(anchor: number, focus: number): SelRange {
  return anchor <= focus ? { start: anchor, end: focus } : { start: focus, end: anchor };
}

/** 범위가 비어 있는가(= 순수 캐럿). */
export function selCollapsed(anchor: number, focus: number): boolean {
  return anchor === focus;
}

/** 선택 하이라이트 사각형 하나 — own-render 페이지 px + 그 페이지(캐럿 사각형과 같은 공간). */
export interface RangeRect {
  page: number;
  x: number;
  top: number;
  width: number;
  height: number;
}

/** 같은 줄로 볼 baseline/top 허용 오차(px) — SVG/엔진 좌표가 소수 반올림되므로 약간의 여유를 준다. */
const LINE_EPS = 0.05;

/** 한 줄분 하이라이트를 만든다(폭이 0 이하면 버린다 — 빈 사각형은 그리지 않는다). */
function box(page: number, x0: number, x1: number, top: number, height: number): RangeRect | null {
  const width = x1 - x0;
  if (!(width > 0) || !(height > 0)) return null;
  return { page, x: x0, top, width, height };
}

/** 문자 박스에서 뽑은 줄별 하이라이트 — 본문 캐럿용(정확). `[start, end)` 가 비면 빈 배열.
 *  `boxes` 는 `CharBox`(x/adv/baseline/lineHeight/line)만 요구하는 구조적 타입이라 이 모듈은
 *  bodyCaret 에 의존하지 않는다(순환 import 방지). */
export function rectsFromCharBoxes(
  boxes: { x: number; adv: number; baseline: number; lineHeight: number; line: number }[],
  start: number,
  end: number,
  page: number,
): RangeRect[] {
  const s = Math.max(0, Math.min(start, boxes.length));
  const e = Math.max(0, Math.min(end, boxes.length));
  if (e <= s) return [];
  const out: RangeRect[] = [];
  let i = s;
  while (i < e) {
    const line = boxes[i].line;
    let j = i;
    while (j + 1 < e && boxes[j + 1].line === line) j++;
    const first = boxes[i];
    const last = boxes[j];
    const top = first.baseline - first.lineHeight * 0.85; // BASELINE_RATIO — 캐럿 막대와 같은 수식
    const r = box(page, first.x, last.x + last.adv, top, first.lineHeight);
    if (r) out.push(r);
    i = j + 1;
  }
  return out;
}

/** 오프셋 → 캐럿 사각형을 물어보는 함수(엔진 `caretRectCell` 의 부분 적용). */
export type RectProbe = (offset: number) => Promise<CellCaretRect | null>;

/** 오프셋을 훑어 줄별 하이라이트를 만든다 — 셀 캐럿용. 어느 한 오프셋이라도 해소 안 되면 **빈 배열**
 *  (018: 틀린 하이라이트보다 무하이라이트). `cap` 은 폭주 방지 상한(넘으면 거기까지만 그린다). */
export async function rectsByProbe(probe: RectProbe, start: number, end: number, cap = 600): Promise<RangeRect[]> {
  if (end <= start) return [];
  const pts: { o: number; r: CellCaretRect }[] = [];
  const last = Math.min(end, start + cap);
  for (let o = start; o <= last; o++) {
    const r = await probe(o);
    if (!r) return [];
    pts.push({ o, r });
  }
  const out: RangeRect[] = [];
  let i = 0;
  while (i + 1 < pts.length) {
    const line = pts[i].r;
    let j = i;
    while (j + 1 < pts.length && pts[j + 1].r.page === line.page && Math.abs(pts[j + 1].r.top - line.top) <= LINE_EPS) j++;
    let x1 = pts[j].r.x;
    if (j + 1 < pts.length) {
      // 줄이 접혔다: 이 줄 마지막 글자의 폭은 관측되지 않는다(다음 오프셋은 이미 다음 줄) — 이 줄에서
      // 관측된 마지막 advance 로 메운다. 표본이 없으면 줄 높이의 절반(전각 근사).
      x1 += j > i ? pts[j].r.x - pts[j - 1].r.x : line.height * 0.5;
    }
    const r = box(line.page, pts[i].r.x, x1, line.top, line.height);
    if (r) out.push(r);
    i = j + 1; // 접힌 경계 오프셋이 곧 다음 줄의 첫 점이다(엔진 계약)
  }
  return out;
}
