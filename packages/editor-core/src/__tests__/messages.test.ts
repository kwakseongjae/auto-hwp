import { describe, expect, it } from "vitest";
import { blockHitToSel, cellLabel, deriveSel } from "../selection";
import { describeIntent, deleteBlockDetail } from "../describeIntent";
import { coreMessagesKoKR, type CoreMessages } from "../messages";
import { EditorCore } from "../core";
import type { BlockHit, CellHit, EngineAdapter, Intent, TableBox } from "../index";

// 077 — 헤드리스 절반의 주입 계약.
//
// editor-core 는 React context 를 못 읽으므로 문자열 카탈로그를 인자로 받는다. 여기서 잠그는 것은
// ① 인자를 주지 않으면 종전 한국어 그대로(= 회귀 0), ② 주면 그 문구가 나온다, ③ EditorCore.setMessages
// 가 selection/edit 두 소비자에 한 번에 꽂힌다 — 셋.

const cell: CellHit = { section: 0, block: 2, row: 1, col: 3, rows: 1, cols: 1, x: 0, y: 0, w: 10, h: 10, text: "매출액" };
const emptyCell: CellHit = { ...cell, text: "  " };
const table: TableBox = { section: 0, block: 2, rows: 2, cols: 2, first_row: 0, x: 0, y: 0, w: 10, h: 10 };
const paraHit: BlockHit = { kind: "paragraph", section: 0, block: 5, editable: true, x: 0, y: 0, w: 10, h: 10, text: "" };

/** 영어 override — 실제 번역이 아니라 "주입이 닿는가" 를 보는 마커다. */
const EN: CoreMessages = {
  anchor: {
    cellWhere: (r, c) => `r${r}c${c}`,
    cellSnippet: (s, w) => `"${s}" (${w})`,
    cellEmpty: (w) => `Table ${w}`,
    snippet: (s) => `"${s}"`,
    tableAt: (p) => `Table (p.${p})`,
    paragraphAt: (p) => `Paragraph (p.${p})`,
    blockAt: (k, p) => `${k} (p.${p})`,
  },
  intent: { ...coreMessagesKoKR.intent, op: { ...coreMessagesKoKR.intent.op, SetTableCell: "Fill cell" }, unknownOp: "Edit" },
};

describe("anchor 라벨 (selection.ts)", () => {
  it("카탈로그를 주지 않으면 종전 한국어 그대로", () => {
    expect(cellLabel(cell)).toBe("“매출액” (2행 4열)");
    expect(cellLabel(emptyCell)).toBe("표 2행 4열");
    expect(deriveSel(0, table, null, null)!.anchor.label).toBe("표 (p.1)");
    expect(deriveSel(2, null, null, paraHit)!.anchor.label).toBe("문단 (p.3)");
    expect(blockHitToSel(paraHit, 2)!.anchor.label).toBe("문단 (p.3)");
  });

  it("카탈로그를 주면 그 문구로 만든다", () => {
    expect(cellLabel(cell, EN.anchor)).toBe('"매출액" (r2c4)');
    expect(cellLabel(emptyCell, EN.anchor)).toBe("Table r2c4");
    expect(deriveSel(0, table, null, null, EN.anchor)!.anchor.label).toBe("Table (p.1)");
    expect(deriveSel(2, null, null, paraHit, EN.anchor)!.anchor.label).toBe("Paragraph (p.3)");
    expect(blockHitToSel(paraHit, 2, EN.anchor)!.anchor.label).toBe("Paragraph (p.3)");
  });
});

describe("Intent 카드 (describeIntent.ts)", () => {
  const fill = { intent: "SetTableCell", section: 0, block: 1, row: 0, col: 1, text: "1,200" } as unknown as Intent;
  const del = { intent: "DeleteBlock", section: 0, block: 3 } as unknown as Intent;

  it("카탈로그를 주지 않으면 종전 한국어 그대로 (아이콘은 언어 중립이라 불변)", () => {
    const card = describeIntent(fill);
    expect(card.label).toBe("칸 채우기");
    expect(card.icon).toBe("▣");
    expect(card.summary).toBe("표 1행 2열 → “1,200”");
    expect(describeIntent(del).summary).toBe("이 블록을 삭제합니다 — 아래 원문을 확인하고 승인하세요");
  });

  it("카탈로그를 주면 라벨/요약이 그 문구로 (아이콘·section/block 은 그대로)", () => {
    const card = describeIntent(fill, EN.intent);
    expect(card.label).toBe("Fill cell");
    expect(card.icon).toBe("▣");
    expect(card.section).toBe(0);
    expect(card.block).toBe(1);
  });

  it("알 수 없는 op 은 kind 를 라벨로 쓰고, kind 가 비면 unknownOp 로 떨어진다", () => {
    expect(describeIntent({ intent: "NoSuchOp" } as unknown as Intent).label).toBe("NoSuchOp");
    expect(describeIntent({ intent: "" } as unknown as Intent).label).toBe("편집");
    expect(describeIntent({ intent: "" } as unknown as Intent, EN.intent).label).toBe("Edit");
  });

  it("DeleteBlock 원문 프리뷰도 카탈로그를 탄다", async () => {
    const empty = async () => [];
    await expect(deleteBlockDetail(empty, 0, 1)).resolves.toBe(coreMessagesKoKR.intent.deleteDetailUnreadable);
    await expect(deleteBlockDetail(empty, 0, 1, { ...coreMessagesKoKR.intent, deleteDetailUnreadable: "Unreadable block" })).resolves.toBe("Unreadable block");
  });
});

describe("EditorCore.setMessages (주입 지점 1개)", () => {
  const adapter = {} as EngineAdapter;

  it("selection 과 edit 두 소비자에 한 번에 꽂힌다", () => {
    const core = new EditorCore(adapter);
    expect(core.selection.messages).toBe(coreMessagesKoKR);
    expect(core.edit.messages).toBe(coreMessagesKoKR);
    core.setMessages(EN);
    expect(core.selection.messages).toBe(EN);
    expect(core.edit.messages).toBe(EN);
  });

  it("인자 없이 부르면 한국어 기본값으로 되돌린다", () => {
    const core = new EditorCore(adapter);
    core.setMessages(EN);
    core.setMessages();
    expect(core.selection.messages).toBe(coreMessagesKoKR);
  });

  it("주입된 카탈로그가 preview 카드에 실제로 쓰인다", () => {
    const core = new EditorCore(adapter);
    core.setMessages(EN);
    const cards = core.edit.preview([{ intent: "SetTableCell", section: 0, block: 1, row: 0, col: 0, text: "x" } as unknown as Intent]);
    expect(cards[0].label).toBe("Fill cell");
  });

  it("preview 는 map 의 INDEX 를 카탈로그로 오인하지 않는다 (2번째 카드도 정상)", () => {
    const core = new EditorCore(adapter);
    const two = [
      { intent: "SetTableCell", section: 0, block: 1, row: 0, col: 0, text: "a" },
      { intent: "SetTableCell", section: 0, block: 2, row: 0, col: 0, text: "b" },
    ] as unknown as Intent[];
    expect(core.edit.preview(two).map((c) => c.label)).toEqual(["칸 채우기", "칸 채우기"]);
  });
});
