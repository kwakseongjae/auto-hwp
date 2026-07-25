import { describe, expect, it } from "vitest";
import {
  alignCharBoxes,
  bodyCaretRectAt,
  bodyLineMove,
  bodyOffsetAtPoint,
  BodyCaretController,
  glyphsInBand,
  parsePageGlyphs,
} from "../bodyCaret";
import { CaretRouter } from "../caretRouter";
import { CellCaretController } from "../cellCaret";
import { createEditorCore } from "../core";
import { DocSession } from "../session";
import type { BlockHit, CellTextHit, Intent, RunSpec } from "../types";
import { MockAdapter } from "./mockAdapter";

// 본문 문단 캐럿 — 순수 기하(페이지 SVG 글리프 ↔ 모델 문자 정렬)와 컨트롤러(클릭/이동/타이핑) 계약.
//
// 왜 이 방식인가: 엔진은 본문 문단에 대한 own-render 캐럿 표면이 없다(CARET-GAP §7.4). 그래서 화면에
// 실제로 그려진 페이지 SVG의 `<text>`(글리프 1개 = <text> 1개, 공백은 렌더 생략)를 기하 정본으로 삼고
// `blockRuns` 모델 텍스트와 1:1로 맞춘다. 개수가 안 맞으면(페이지 경계로 쪼개진 문단 등) **캐럿을 주지
// 않는다**(018) — 틀린 자리에 캐럿을 놓는 것이 더 나쁘다.

/** size 13인 글리프 한 줄을 x=100부터 advance 13으로 늘어놓은 SVG(공백은 생략 — 렌더러와 같은 규약). */
function svgLine(chars: { ch: string; x: number; y?: number; size?: number }[]): string {
  const body = chars
    .map((c) => `<text x="${c.x}" y="${c.y ?? 50}" font-size="${c.size ?? 13}" font-family="NanumGothic, sans-serif" fill="#000000">${c.ch}</text>`)
    .join("");
  return `<svg viewBox="0 0 794 1123" width="794" height="1123"><rect x="0" y="0" width="794" height="1123" fill="#FFFFFF"/>${body}</svg>`;
}

const BAND: BlockHit = { section: 0, block: 3, kind: "paragraph", x: 75, y: 40, w: 640, h: 20, text: "가나 다", editable: true };

/** "가나 다" — 글리프 3개(공백은 안 그려진다), 전각 advance 13. */
const SVG_3 = svgLine([
  { ch: "가", x: 100 },
  { ch: "나", x: 113 },
  { ch: "다", x: 130 }, // 앞의 공백 하나(≈4)만큼 벌어진 자리
]);

describe("body caret — 순수 기하", () => {
  it("페이지 SVG에서 글리프(x/baseline/size/문자)를 뽑고 XML 엔티티를 되돌린다", () => {
    const gs = parsePageGlyphs(svgLine([{ ch: "&amp;", x: 10 }, { ch: "&lt;", x: 23 }]));
    expect(gs).toHaveLength(2);
    expect(gs[0]).toMatchObject({ x: 10, baseline: 50, size: 13, text: "&" });
    expect(gs[1].text).toBe("<");
  });

  it("밴드(문단 세로 띠) 안의 글리프만 읽기 순서로 고른다 — 이웃 블록 글리프는 안 섞인다", () => {
    const svg = svgLine([
      { ch: "밖", x: 100, y: 20 }, // 밴드 위(다른 블록)
      { ch: "나", x: 113, y: 50 },
      { ch: "가", x: 100, y: 50 },
      { ch: "밑", x: 100, y: 90 }, // 밴드 아래(다른 블록)
    ]);
    const inBand = glyphsInBand(parsePageGlyphs(svg), BAND);
    expect(inBand.map((g) => g.text)).toEqual(["가", "나"]);
  });

  it("모델 텍스트와 글리프를 1:1로 맞추고, 공백 자리는 관측 advance로 보간한다", () => {
    const boxes = alignCharBoxes("가나 다", glyphsInBand(parsePageGlyphs(SVG_3), BAND))!;
    expect(boxes).toHaveLength(4);
    expect(boxes[0].x).toBe(100); // 비공백은 글리프 x에 정확히 스냅
    expect(boxes[1].x).toBe(113);
    expect(boxes[3].x).toBe(130);
    // 공백은 '나'의 오른쪽 끝(113+13=126)에 놓이고, 그 폭은 관측된 간격에서 보정된다('다'까지 4px)
    expect(boxes[2].x).toBeCloseTo(126, 6);
    expect(boxes[2].adv).toBeCloseTo(4, 0);
    expect(boxes.every((b) => b.line === 0)).toBe(true);
  });

  it("문단 끝 공백도 폭을 갖는다 — 문단 끝 캐럿이 마지막 글자 위에 겹치지 않게", () => {
    const boxes = alignCharBoxes("가나 ", glyphsInBand(parsePageGlyphs(svgLine([{ ch: "가", x: 100 }, { ch: "나", x: 113 }])), BAND))!;
    expect(boxes[2].x).toBeCloseTo(126, 6);
    expect(bodyCaretRectAt(boxes, 3, 0)!.x).toBeGreaterThan(126);
  });

  it("글리프 수 ≠ 비공백 문자 수면 null — 페이지 경계로 쪼개진 문단에 캐럿을 만들지 않는다(018)", () => {
    // 문단은 6글자인데 이 페이지 밴드엔 글리프가 3개뿐(나머지는 다음 페이지)
    expect(alignCharBoxes("가나 다라마바", glyphsInBand(parsePageGlyphs(SVG_3), BAND))).toBeNull();
    expect(alignCharBoxes("가나 다", [])).toBeNull();
  });

  it("문단 선두 공백은 첫 글리프에서 왼쪽으로 역산한다(들여쓰기 자리)", () => {
    const boxes = alignCharBoxes("  가나", glyphsInBand(parsePageGlyphs(svgLine([{ ch: "가", x: 100 }, { ch: "나", x: 113 }])), BAND))!;
    expect(boxes[0].x).toBeLessThan(boxes[1].x);
    expect(boxes[1].x).toBeLessThan(100);
    expect(boxes[2].x).toBe(100);
  });

  it("줄이 바뀌면 줄 번호가 올라가고, 줄 높이는 그 줄 최대 글리프 크기다", () => {
    const svg = svgLine([
      { ch: "가", x: 100, y: 50 },
      { ch: "나", x: 113, y: 50 },
      { ch: "다", x: 100, y: 70, size: 20 },
    ]);
    const boxes = alignCharBoxes("가나 다", glyphsInBand(parsePageGlyphs(svg), { y: 40, h: 40 }))!;
    expect(boxes.map((b) => b.line)).toEqual([0, 0, 0, 1]); // 줄바꿈 공백은 앞 줄 끝에 붙는다
    expect(boxes[3].lineHeight).toBe(20);
  });

  it("캐럿 사각형은 셀 캐럿과 같은 규약: x=글자 왼쪽, top=baseline−0.85h, 문단끝=마지막 글자 오른쪽", () => {
    const boxes = alignCharBoxes("가나 다", glyphsInBand(parsePageGlyphs(SVG_3), BAND))!;
    const r0 = bodyCaretRectAt(boxes, 0, 2)!;
    expect(r0).toMatchObject({ page: 2, x: 100, height: 13 });
    expect(r0.top).toBeCloseTo(50 - 13 * 0.85, 6);
    expect(bodyCaretRectAt(boxes, 1, 0)!.x).toBe(113);
    expect(bodyCaretRectAt(boxes, 4, 0)!.x).toBeCloseTo(143, 6); // 마지막 '다'(130) + advance 13
    // past-end는 문단 끝으로 CLAMP되어 사각형을 돌려준다 — null 아님(CaretRect 계약)
    expect(bodyCaretRectAt(boxes, 999, 0)).toEqual(bodyCaretRectAt(boxes, 4, 0));
    expect(bodyCaretRectAt([], 0, 0)).toBeNull();
  });

  it("클릭 → 오프셋: 글자 중앙 왼쪽이면 앞, 오른쪽이면 뒤로 스냅하고 줄은 y로 고른다", () => {
    const boxes = alignCharBoxes("가나 다", glyphsInBand(parsePageGlyphs(SVG_3), BAND))!;
    const midY = 50 - 13 * 0.85 + 6;
    expect(bodyOffsetAtPoint(boxes, 101, midY)).toBe(0); // '가' 왼쪽 절반
    expect(bodyOffsetAtPoint(boxes, 112, midY)).toBe(1); // '가' 오른쪽 절반
    expect(bodyOffsetAtPoint(boxes, 500, midY)).toBe(4); // 줄 끝 너머 → 문단 끝
    expect(bodyOffsetAtPoint(boxes, 101, -500)).toBe(0); // 줄 위 → 가장 가까운 줄(근접 스냅)
    expect(bodyOffsetAtPoint([], 0, 0)).toBe(0);
  });

  it("위/아래 이동은 x를 유지한 채 이웃 줄로, 갈 줄이 없으면 제자리", () => {
    const svg = svgLine([
      { ch: "가", x: 100, y: 50 },
      { ch: "나", x: 113, y: 50 },
      { ch: "다", x: 100, y: 70 },
      { ch: "라", x: 113, y: 70 },
    ]);
    const boxes = alignCharBoxes("가나다라", glyphsInBand(parsePageGlyphs(svg), { y: 40, h: 40 }))!;
    expect(bodyLineMove(boxes, 1, 1)).toBe(3); // 첫 줄 두 번째 경계 → 둘째 줄 같은 x
    expect(bodyLineMove(boxes, 3, -1)).toBe(1);
    expect(bodyLineMove(boxes, 1, -1)).toBe(1); // 위에 줄이 없다 → 제자리
    expect(bodyLineMove(boxes, 3, 1)).toBe(3);
  });
});

// ── 컨트롤러 ─────────────────────────────────────────────────────────────────────────────────────

const RUNS: RunSpec[] = [{ text: "가나", bold: true }, { text: " 다" }];

function bodyAdapter(over: Partial<ConstructorParameters<typeof MockAdapter>[0]> = {}) {
  return new MockAdapter({
    svg: () => SVG_3,
    hit: () => BAND,
    blocks: [BAND],
    runs: () => RUNS.map((r) => ({ ...r })),
    ...over,
  });
}

async function coreWith(adapter: MockAdapter) {
  const core = createEditorCore(adapter);
  await core.session.open(new Uint8Array([1]), "t.hwp");
  return core;
}

describe("BodyCaretController — 클릭/이동/커밋", () => {
  it("본문 문단 클릭 → 캐럿(주소 + 오프셋 + 기하)", async () => {
    const core = await coreWith(bodyAdapter());
    const st = await core.bodyCaret.clickAt(0, 112, 45);
    expect(st).not.toBeNull();
    expect(st!.anchor).toMatchObject({ section: 0, block: 3, offset: 1, paraLen: 4 });
    expect(st!.rect).toMatchObject({ page: 0, x: 113 });
  });

  it("표/그림 밴드, 편집 불가 문단, 밴드 밖 y 클릭은 전부 null (+ 기존 캐럿 해제)", async () => {
    const core = await coreWith(bodyAdapter());
    expect(await core.bodyCaret.clickAt(0, 112, 45)).not.toBeNull();
    expect(await core.bodyCaret.clickAt(0, 112, 300)).toBeNull(); // 밴드(40..60) 밖
    expect(core.bodyCaret.get()).toBeNull();

    const table = await coreWith(bodyAdapter({ hit: () => ({ ...BAND, kind: "table" }) }));
    expect(await table.bodyCaret.clickAt(0, 112, 45)).toBeNull();
    const locked = await coreWith(bodyAdapter({ hit: () => ({ ...BAND, editable: false }) }));
    expect(await locked.bodyCaret.clickAt(0, 112, 45)).toBeNull();
  });

  it("정렬 실패(글리프 수 불일치)면 캐럿을 주지 않는다 — 018 null, throw 없음", async () => {
    const core = await coreWith(bodyAdapter({ svg: () => svgLine([{ ch: "가", x: 100 }]) }));
    expect(await core.bodyCaret.clickAt(0, 101, 45)).toBeNull();
  });

  it("blockRuns 없는 백엔드에서는 기능 자체가 꺼진다(018: 없는 메서드 = 기능 off)", async () => {
    const core = await coreWith(new MockAdapter({ hit: () => BAND, svg: () => SVG_3 }));
    expect(core.bodyCaret.supported).toBe(false);
    expect(await core.bodyCaret.clickAt(0, 112, 45)).toBeNull();
  });

  it("좌우 이동은 [0, paraLen]으로 클램프되고 엔진에 아무것도 안 쓴다", async () => {
    const adapter = bodyAdapter();
    const core = await coreWith(adapter);
    await core.bodyCaret.clickAt(0, 112, 45);
    await core.bodyCaret.move(-5);
    expect(core.bodyCaret.get()!.anchor.offset).toBe(0);
    expect(core.bodyCaret.get()!.rect.x).toBe(100);
    await core.bodyCaret.move(99);
    expect(core.bodyCaret.get()!.anchor.offset).toBe(4);
    expect(adapter.applied).toHaveLength(0); // 읽기 전용 이동 — undo 단위가 생기면 안 된다
  });

  it("타이핑은 SetParagraphRuns 하나 = undo 하나, 런 스타일이 보존된다(평문 variant 금지)", async () => {
    const adapter = bodyAdapter();
    const core = await coreWith(adapter);
    await core.bodyCaret.clickAt(0, 112, 45); // offset 1 (가|나)
    expect(await core.bodyCaret.insertText("X")).toBe(true);
    expect(adapter.applied).toHaveLength(1);
    const intent = adapter.applied[0] as Intent & { runs: RunSpec[]; section: number; block: number };
    expect(intent.intent).toBe("SetParagraphRuns");
    expect(intent.section).toBe(0);
    expect(intent.block).toBe(3);
    expect(intent.runs.map((r) => r.text).join("")).toBe("가X나 다");
    expect(intent.runs[0].bold).toBe(true); // 커밋된 런의 볼드가 살아 있다
    expect(core.session.undoDepth()).toBe(1);
  });

  it("백스페이스는 캐럿 앞 글자를 지우고, 문단 맨 앞이면 우아한 no-op(인텐트 0)", async () => {
    const adapter = bodyAdapter();
    const core = await coreWith(adapter);
    await core.bodyCaret.clickAt(0, 112, 45);
    expect(await core.bodyCaret.deleteBack()).toBe(true);
    expect((adapter.applied[0] as Intent & { runs: RunSpec[] }).runs.map((r) => r.text).join("")).toBe("나 다");

    const adapter2 = bodyAdapter();
    const core2 = await coreWith(adapter2);
    await core2.bodyCaret.clickAt(0, 100.1, 45); // offset 0
    expect(await core2.bodyCaret.deleteBack()).toBe(false);
    expect(adapter2.applied).toHaveLength(0);
  });

  it("커밋 후 문단이 사라지면(밴드 미발견) 편집은 서고 캐럿만 사라진다(018)", async () => {
    let gone = false;
    const adapter = bodyAdapter({ hit: () => (gone ? null : BAND), blocks: [] });
    const core = await coreWith(adapter);
    await core.bodyCaret.clickAt(0, 112, 45);
    gone = true;
    expect(await core.bodyCaret.insertText("X")).toBe(true);
    expect(adapter.applied).toHaveLength(1);
    expect(core.bodyCaret.get()).toBeNull();
  });

  it("styleAtCaret은 캐럿 자리의 런 스타일을 읽는다(IME 미리보기 소스) — 읽기 전용", async () => {
    const adapter = bodyAdapter();
    const core = await coreWith(adapter);
    await core.bodyCaret.clickAt(0, 112, 45);
    expect(await core.bodyCaret.styleAtCaret()).toEqual({ bold: true });
    expect(adapter.applied).toHaveLength(0);
  });

  it("clear()는 캐럿을 지우고 한 번만 알린다", async () => {
    const core = await coreWith(bodyAdapter());
    const seen: (unknown | null)[] = [];
    core.bodyCaret.onChange((s) => seen.push(s));
    await core.bodyCaret.clickAt(0, 112, 45);
    core.bodyCaret.clear();
    core.bodyCaret.clear();
    expect(seen).toHaveLength(2);
    expect(seen[1]).toBeNull();
  });
});

// ── 라우터 ───────────────────────────────────────────────────────────────────────────────────────

const CELL_HIT: CellTextHit = {
  section: 0,
  block: 1,
  row: 0,
  col: 0,
  para: 0,
  offset: 1,
  para_len: 2,
  caret: { page: 0, x: 300, top: 40, height: 13 },
};

describe("CaretRouter — 셀 캐럿과 본문 캐럿은 하나의 표면, 동시에 못 산다", () => {
  it("셀이 먼저 해소되면 셀 캐럿, 셀이 아니면 본문 캐럿", async () => {
    const adapter = bodyAdapter({
      cellText: (_p, x) => (x > 250 ? CELL_HIT : null),
      cellCaret: (_s, _b, _r, _c, _pa, offset) => ({ page: 0, x: 300 + offset * 10, top: 40, height: 13 }),
    });
    const core = await coreWith(adapter);
    expect((await core.caret.clickAt(0, 300, 45))!.kind).toBe("cell");
    expect((await core.caret.clickAt(0, 112, 45))!.kind).toBe("body");
    expect(core.cellCaret.get()).toBeNull(); // 본문으로 넘어가며 셀 캐럿은 해제된다
    expect((await core.caret.clickAt(0, 300, 45))!.kind).toBe("cell");
    expect(core.bodyCaret.get()).toBeNull();
  });

  it("입력은 살아 있는 캐럿의 커밋 레인으로 간다 (셀=SetTableCellRuns / 본문=SetParagraphRuns)", async () => {
    const adapter = bodyAdapter({
      cellText: (_p, x) => (x > 250 ? CELL_HIT : null),
      cellCaret: () => ({ page: 0, x: 300, top: 40, height: 13 }),
    });
    const core = await coreWith(adapter);
    await core.caret.clickAt(0, 300, 45);
    await core.caret.insertText("X");
    expect(adapter.applied[0].intent).toBe("SetTableCellRuns");
    await core.caret.clickAt(0, 112, 45);
    await core.caret.insertText("Y");
    expect(adapter.applied[1].intent).toBe("SetParagraphRuns");
  });

  it("moveLine은 본문 캐럿에서만 처리되고(true), 셀 캐럿에서는 호출자에게 넘긴다(false)", async () => {
    const adapter = bodyAdapter({
      cellText: (_p, x) => (x > 250 ? CELL_HIT : null),
      cellCaret: () => ({ page: 0, x: 300, top: 40, height: 13 }),
    });
    const core = await coreWith(adapter);
    await core.caret.clickAt(0, 300, 45);
    expect(await core.caret.moveLine(1)).toBe(false);
    await core.caret.clickAt(0, 112, 45);
    expect(await core.caret.moveLine(1)).toBe(true);
  });

  it("clear()는 둘 다 지우고, 캐럿이 없으면 입력/삭제는 조용한 false", async () => {
    const core = await coreWith(bodyAdapter());
    await core.caret.clickAt(0, 112, 45);
    core.caret.clear();
    expect(core.caret.get()).toBeNull();
    expect(await core.caret.insertText("X")).toBe(false);
    expect(await core.caret.deleteBack()).toBe(false);
    expect(await core.caret.styleAtCaret()).toBeNull();
  });

  it("어느 쪽도 못 답하는 백엔드면 supported=false", async () => {
    const bare = new MockAdapter({ hit: () => BAND });
    const session = new DocSession(bare);
    const router = new CaretRouter(new CellCaretController(bare, session), new BodyCaretController(bare, session));
    expect(router.supported).toBe(false);
  });
});
