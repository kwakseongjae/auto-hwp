import { describe, expect, it } from "vitest";
import { rectsByProbe, rectsFromCharBoxes, selCollapsed, selRange } from "../caretRange";
import type { CellCaretRect } from "../types";

// 캐럿 범위 선택의 공용 절반 — {anchor, focus} 정규화 + 줄별 하이라이트 기하.
// 셀 캐럿과 본문 캐럿이 **같은 규약**을 쓰는 지점이라 여기가 깨지면 둘 다 깨진다.

/** size 13, advance 13, baseline 50인 한 줄짜리 문자 박스 n개. */
function line(n: number, opts: { x0?: number; baseline?: number; lineNo?: number } = {}) {
  const x0 = opts.x0 ?? 100;
  return Array.from({ length: n }, (_, i) => ({
    x: x0 + i * 13,
    adv: 13,
    baseline: opts.baseline ?? 50,
    lineHeight: 13,
    line: opts.lineNo ?? 0,
  }));
}

describe("선택 범위 정규화", () => {
  it("어느 방향으로 끌었든 같은 구간을 준다", () => {
    expect(selRange(2, 5)).toEqual({ start: 2, end: 5 });
    expect(selRange(5, 2)).toEqual({ start: 2, end: 5 });
    expect(selCollapsed(3, 3)).toBe(true);
    expect(selCollapsed(3, 4)).toBe(false);
  });
});

describe("문자 박스 → 줄별 하이라이트(본문 캐럿)", () => {
  it("한 줄 범위는 첫 글자 왼쪽부터 마지막 글자 오른쪽까지 하나의 사각형", () => {
    const rects = rectsFromCharBoxes(line(4), 1, 3, 2);
    expect(rects).toHaveLength(1);
    expect(rects[0]).toEqual({ page: 2, x: 113, top: 50 - 13 * 0.85, width: 26, height: 13 });
  });

  it("여러 줄에 걸치면 줄마다 하나씩 — 캐럿 막대와 같은 top 수식(baseline−0.85h)", () => {
    const boxes = [...line(2), ...line(3, { baseline: 70, lineNo: 1 })];
    const rects = rectsFromCharBoxes(boxes, 0, 5, 0);
    expect(rects).toHaveLength(2);
    expect(rects[0]).toMatchObject({ x: 100, width: 26 });
    expect(rects[1]).toMatchObject({ x: 100, width: 39, top: 70 - 13 * 0.85 });
  });

  it("빈 범위·역범위·범위 밖 오프셋은 사각형 0개(빈 하이라이트를 그리지 않는다)", () => {
    expect(rectsFromCharBoxes(line(3), 2, 2, 0)).toEqual([]);
    expect(rectsFromCharBoxes(line(3), 3, 1, 0)).toEqual([]);
    expect(rectsFromCharBoxes([], 0, 5, 0)).toEqual([]);
  });

  it("폭이 0인 박스(빈 문단의 가상 줄)는 사각형을 만들지 않는다", () => {
    const zero = [{ x: 100, adv: 0, baseline: 50, lineHeight: 13, line: 0 }];
    expect(rectsFromCharBoxes(zero, 0, 1, 0)).toEqual([]);
  });
});

describe("오프셋 probe → 줄별 하이라이트(셀 캐럿)", () => {
  /** 한 줄에 3글자(폭 10)씩 접히는 셀: 오프셋 3은 엔진 계약대로 **다음 줄 시작**으로 답한다. */
  const wrapped = async (o: number): Promise<CellCaretRect> => {
    const row = Math.floor(o / 3);
    return { page: 1, x: 200 + (o % 3) * 10, top: 40 + row * 20, height: 12 };
  };

  it("접히지 않은 범위는 정확히 시작 x ~ 끝 x", async () => {
    const rects = await rectsByProbe(wrapped, 0, 2);
    expect(rects).toEqual([{ page: 1, x: 200, top: 40, width: 20, height: 12 }]);
  });

  it("줄이 접히면 줄마다 하나씩 — 접힌 줄의 마지막 글자 폭은 관측 advance로 메운다", async () => {
    const rects = await rectsByProbe(wrapped, 0, 4);
    expect(rects).toHaveLength(2);
    // 첫 줄: 200..220(오프셋 2) + 관측 advance 10 = 230 (마지막 글자까지 덮는다)
    expect(rects[0]).toEqual({ page: 1, x: 200, top: 40, width: 30, height: 12 });
    expect(rects[1]).toEqual({ page: 1, x: 200, top: 60, width: 10, height: 12 });
  });

  it("한 오프셋이라도 해소 안 되면 하이라이트 자체를 포기한다(018 — 틀린 것보다 없는 것)", async () => {
    expect(await rectsByProbe(async (o) => (o < 2 ? { page: 0, x: o, top: 0, height: 10 } : null), 0, 4)).toEqual([]);
  });

  it("빈 범위는 probe 를 한 번도 부르지 않는다", async () => {
    let calls = 0;
    await rectsByProbe(async () => {
      calls++;
      return { page: 0, x: 0, top: 0, height: 10 };
    }, 3, 3);
    expect(calls).toBe(0);
  });
});
