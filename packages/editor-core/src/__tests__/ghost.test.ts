import { describe, expect, it } from "vitest";
import { ghostablePct, intentGhost, intentGhosts } from "../ghost";

// 이슈 3 — 적용 전 고스트 프리뷰의 순수 절반. 여기서 잠그는 것:
//   ① 덮어쓰기 편집(SetTableCell/…Runs, SetParagraph…)만 대상이 나온다
//   ② runs 는 텍스트로 평탄화된다(고스트에 그릴 문자열)
//   ③ 삽입/삭제/구조 편집은 **대상 없음** — 적용 전엔 자리가 없으니 그리지 않는다(거짓 프리뷰 금지)
//   ④ index 가 카드와 1:1 로 묶인다(hover ↔ 고스트)

describe("intentGhost", () => {
  it("SetTableCell → 셀 주소 + 새 텍스트", () => {
    expect(intentGhost({ intent: "SetTableCell", section: 0, index: 10, row: 3, col: 1, text: "오또케" }, 0)).toEqual({
      index: 0,
      section: 0,
      block: 10,
      row: 3,
      col: 1,
      text: "오또케",
    });
  });

  it("SetTableCellRuns → runs 를 평탄화한 텍스트", () => {
    const g = intentGhost(
      { intent: "SetTableCellRuns", section: 0, index: 10, row: 0, col: 2, runs: [{ text: "핀테크 " }, { text: "스타트업", bold: true }] },
      4,
    );
    expect(g).toEqual({ index: 4, section: 0, block: 10, row: 0, col: 2, text: "핀테크 스타트업" });
  });

  it("SetParagraphRuns/Text → 셀 주소 없이 블록만", () => {
    expect(intentGhost({ intent: "SetParagraphRuns", section: 0, block: 7, runs: [{ text: "새 문단" }] }, 1)).toEqual({
      index: 1,
      section: 0,
      block: 7,
      text: "새 문단",
    });
    expect(intentGhost({ intent: "SetParagraphText", section: 0, block: 7, text: "평문" }, 2)).toMatchObject({ block: 7, text: "평문" });
  });

  it("삽입/삭제/구조 편집은 프리뷰 대상이 아니다", () => {
    for (const i of [
      { intent: "TableInsertRows", section: 0, index: 10, at: 3, count: 2, cols: 4 },
      { intent: "DeleteBlock", section: 0, index: 3 },
      { intent: "InsertTableAt", section: 0, index: null, rows: [] },
      { intent: "SetCellRangeShade", section: 0, index: 10, r0: 0, c0: 0, r1: 1, c1: 1, shade: "#eee" },
      { intent: "Replace", query: "a", replacement: "b", all: true },
    ]) {
      expect(intentGhost(i, 0)).toBeNull();
    }
  });

  it("주소가 망가진 후보는 버린다(반쪽 프리뷰 금지)", () => {
    expect(intentGhost({ intent: "SetTableCell", section: 0, index: 10, row: -1, col: 1, text: "x" }, 0)).toBeNull();
    expect(intentGhost({ intent: "SetTableCell", section: 0, index: 10, row: 1, col: 1 }, 0)).toBeNull();
    expect(intentGhost({ intent: "SetParagraphRuns", section: 0, block: 1, runs: "nope" }, 0)).toBeNull();
  });
});

describe("intentGhosts / ghostablePct", () => {
  it("프리뷰 가능한 것만 남기고 index 는 원래 카드 자리를 가리킨다", () => {
    const intents = [
      { intent: "TableInsertRows", section: 0, index: 10, at: 3, count: 1, cols: 2 },
      { intent: "SetTableCell", section: 0, index: 10, row: 3, col: 0, text: "A" },
      { intent: "SetTableCell", section: 0, index: 10, row: 3, col: 1, text: "B" },
    ];
    expect(intentGhosts(intents).map((g) => g.index)).toEqual([1, 2]);
    expect(ghostablePct(intents)).toEqual({ previewable: 2, total: 3 });
  });

  it("프리뷰 가능한 것이 0이면 정직하게 0을 보고한다(토글을 띄우지 않도록)", () => {
    expect(ghostablePct([{ intent: "DeleteBlock", section: 0, index: 1 }])).toEqual({ previewable: 0, total: 1 });
  });
});
