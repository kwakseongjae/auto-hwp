import { describe, expect, it } from "vitest";
import { rangeLabel, rangeText, SelectionModel } from "../selection";
import type { CellHit, TableBox, TableGrid } from "../types";
import { MockAdapter } from "./mockAdapter";

// 이슈 2 — 행/칸 정밀 선택. 종전에는 표 위 클릭 = "표 전체", 더블클릭 드릴 = 셀 하나, 이 둘뿐이었고
// `kind:"range"` 앵커는 타입에만 있고 **생산자가 없었다**(grep 0건). 여기서 잠그는 것:
//   ① 행 머리 클릭 → 전역 행 주소의 `range` 앵커("표 3행 전체")와 표 폭 전체 마크 박스
//   ② shift+행 머리 → 행 범위("표 2~4행 전체")
//   ③ shift+셀 클릭 → 직사각 셀 범위("표 2~3행 2~3열") + 앵커 rows/cols 가 전역 주소
//   ④ 분할표(다음 페이지 조각): first_row 오프셋이 반영돼 **전역** 행이 나온다
//   ⑤ 기하 질의를 못 하는 백엔드(TauriAdapter 패리티) → null, 조용한 거짓 선택 없음

const COLS = [40, 140, 340]; // 2열 (경계 3개)
const ROWS = [10, 30, 50, 70]; // 3행 (경계 4개)

const grid: TableGrid = {
  section: 0,
  block: 2,
  rows: 3,
  cols: 2,
  cells: [
    { row: 0, col: 0, text: "항목" },
    { row: 0, col: 1, text: "세부 항목" },
    { row: 1, col: 0, text: "일반현황" },
    { row: 1, col: 1, text: "창업아이템명" },
    { row: 2, col: 0, text: "개요" },
    { row: 2, col: 1, text: "" },
  ],
};

const table = (firstRow = 0): TableBox => ({ section: 0, block: 2, x: 40, y: 10, w: 300, h: 60, rows: 3, cols: 2, first_row: firstRow });

/** (row, col) 격자에서 좌표 → CellHit (병합 없음). */
const cellAt = (page: number, x: number, y: number): CellHit | null => {
  const col = COLS.findIndex((c, i) => i + 1 < COLS.length && x >= c && x < COLS[i + 1]);
  const row = ROWS.findIndex((r, i) => i + 1 < ROWS.length && y >= r && y < ROWS[i + 1]);
  if (col < 0 || row < 0) return null;
  void page;
  return {
    section: 0,
    block: 2,
    row,
    col,
    rows: 3,
    cols: 2,
    text: grid.cells.find((c) => c.row === row && c.col === col)?.text ?? "",
    x: COLS[col],
    y: ROWS[row],
    w: COLS[col + 1] - COLS[col],
    h: ROWS[row + 1] - ROWS[row],
  };
};

function model(opts: { firstRow?: number; withGrid?: boolean } = {}) {
  return new SelectionModel(
    new MockAdapter({
      table: table(opts.firstRow ?? 0),
      cell: cellAt,
      colBoundaries: COLS,
      rowBoundaries: ROWS,
      ...(opts.withGrid === false ? {} : { grid }),
    }),
  );
}

describe("rangeLabel / rangeText (순수)", () => {
  it("모든 열을 덮으면 '전체' 행 라벨, 좁으면 두 축을 다 이름한다", () => {
    expect(rangeLabel([2, 2], [0, 1], 2)).toBe("표 3행 전체");
    expect(rangeLabel([1, 3], [0, 1], 2)).toBe("표 2~4행 전체");
    expect(rangeLabel([1, 2], [1, 1], 3)).toBe("표 2~3행 2열");
    expect(rangeLabel([0, 0], [0, 1], 3)).toBe("표 1행 1~2열");
  });

  it("rangeText 는 범위 안 셀만, 행 하나에 한 줄로 낸다", () => {
    expect(rangeText(grid, [1, 2], [0, 1])).toBe("일반현황 | 창업아이템명\n개요 | _빈칸_");
    expect(rangeText(null, [0, 0], [0, 0])).toBe("");
  });
});

describe("SelectionModel.selectRows — 행 앵커 (이슈 2)", () => {
  it("행 하나 → kind:'range', 전역 행 주소, 표 폭 전체 마크", async () => {
    const m = model();
    const sel = await m.selectRows(0, 0, 2, 1);
    expect(sel).not.toBeNull();
    expect(sel!.anchor.kind).toBe("range");
    expect(sel!.anchor.rows).toEqual([1, 1]);
    expect(sel!.anchor.cols).toEqual([0, 1]);
    expect(sel!.anchor.label).toBe("표 2행 전체");
    // 마크 박스: x/w 는 표 폭 전체, y/h 는 그 행의 밴드.
    expect(sel!.mark.box).toEqual({ x: 40, y: 30, w: 300, h: 20 });
    expect(sel!.mark.kind).toBe("range");
    // 앵커 text 에 그 행의 셀들이 실린다(모델 문맥).
    expect(sel!.anchor.text).toBe("일반현황 | 창업아이템명");
    expect(m.getAnchors()).toHaveLength(1);
  });

  it("extend=true 면 이전 행에서 범위로 자란다", async () => {
    const m = model();
    await m.selectRows(0, 0, 2, 0);
    const sel = await m.selectRows(0, 0, 2, 2, true);
    expect(sel!.anchor.rows).toEqual([0, 2]);
    expect(sel!.anchor.label).toBe("표 1~3행 전체");
    expect(sel!.mark.box.h).toBe(60); // 세 행 밴드 전체
  });

  it("분할표 조각(first_row=5)이면 전역 행 주소가 나온다", async () => {
    const m = model({ firstRow: 5 });
    const sel = await m.selectRows(1, 0, 2, 6);
    expect(sel!.anchor.rows).toEqual([6, 6]);
    expect(sel!.anchor.label).toBe("표 7행 전체");
    expect(sel!.mark.page).toBe(1);
    expect(sel!.mark.box.y).toBe(30); // 조각 안 두 번째 밴드
  });

  it("경계 밖 행은 조각 안으로 클램프된다(거짓 주소 금지)", async () => {
    const m = model({ firstRow: 5 });
    const sel = await m.selectRows(1, 0, 2, 99);
    expect(sel!.anchor.rows).toEqual([7, 7]); // 조각의 마지막 전역 행
  });

  it("기하 질의를 못 하는 백엔드면 null (조용한 거짓 선택 없음)", async () => {
    const m = new SelectionModel(new MockAdapter({ table: table(), cell: cellAt }));
    expect(await m.selectRows(0, 0, 2, 1)).toBeNull();
    expect(m.getAnchors()).toHaveLength(0);
  });

  it("그리드 질의가 없는 백엔드면 text 없이 앵커만 (정직한 강등)", async () => {
    const m = model({ withGrid: false });
    const sel = await m.selectRows(0, 0, 2, 1);
    expect(sel!.anchor.text).toBeUndefined();
    expect(sel!.anchor.rows).toEqual([1, 1]);
  });
});

describe("SelectionModel.cellBoxAt — 주소 → 셀 박스 (이슈 3 고스트 기하)", () => {
  it("전역 행/열 주소를 그 페이지 조각의 박스로 푼다", async () => {
    const m = model();
    expect(await m.cellBoxAt(0, 0, 2, 1, 1)).toEqual({ x: 140, y: 30, w: 200, h: 20 });
  });

  it("이 조각에 없는 행/열이면 null (다음 페이지 조각을 보라는 신호)", async () => {
    const m = model({ firstRow: 5 });
    expect(await m.cellBoxAt(1, 0, 2, 1, 0)).toBeNull(); // 조각은 5~7행
    expect(await m.cellBoxAt(1, 0, 2, 6, 9)).toBeNull(); // 열 범위 밖
    expect(await m.cellBoxAt(1, 0, 2, 6, 0)).toEqual({ x: 40, y: 30, w: 100, h: 20 });
  });

  it("기하 질의를 못 하는 백엔드면 null", async () => {
    const m = new SelectionModel(new MockAdapter({ table: table(), cell: cellAt }));
    expect(await m.cellBoxAt(0, 0, 2, 0, 0)).toBeNull();
  });
});

describe("SelectionModel.extendToCell — 셀 범위 (이슈 2)", () => {
  it("드릴한 셀에서 shift+클릭 → 직사각 범위 앵커", async () => {
    const m = model();
    await m.drillInto(0, 60, 15); // (0,0)
    expect(m.getRangeOrigin()).toMatchObject({ row: 0, col: 0 });
    const sel = await m.extendToCell(0, 200, 55); // (2,1)
    expect(sel!.anchor.kind).toBe("range");
    expect(sel!.anchor.rows).toEqual([0, 2]);
    expect(sel!.anchor.cols).toEqual([0, 1]);
    expect(sel!.anchor.label).toBe("표 1~3행 전체"); // 모든 열을 덮으면 행 표현
    expect(sel!.mark.box).toEqual({ x: 40, y: 10, w: 300, h: 60 });
    expect(m.getAnchors()).toHaveLength(1);
  });

  it("한 열만 덮으면 두 축을 다 이름한다", async () => {
    const m = model();
    await m.drillInto(0, 200, 15); // (0,1)
    const sel = await m.extendToCell(0, 200, 35); // (1,1)
    expect(sel!.anchor.rows).toEqual([0, 1]);
    expect(sel!.anchor.cols).toEqual([1, 1]);
    expect(sel!.anchor.label).toBe("표 1~2행 2열");
  });

  it("원점이 없으면(빈 선택) 그냥 그 셀 하나를 고른다 — 오류 아님", async () => {
    const m = model();
    const sel = await m.extendToCell(0, 200, 35);
    expect(sel!.anchor.kind).toBe("cell");
    expect(sel!.anchor.rows).toEqual([1, 1]);
    expect(m.getRangeOrigin()).toMatchObject({ row: 1, col: 1 });
  });

  it("표 밖이면 null(선택 유지)", async () => {
    const m = model();
    await m.drillInto(0, 60, 15);
    expect(await m.extendToCell(0, 1000, 1000)).toBeNull();
    expect(m.getAnchors()[0].kind).toBe("cell");
  });

  it("clear() 는 확장 원점도 지운다", async () => {
    const m = model();
    await m.drillInto(0, 60, 15);
    m.clear();
    expect(m.getRangeOrigin()).toBeNull();
  });
});
