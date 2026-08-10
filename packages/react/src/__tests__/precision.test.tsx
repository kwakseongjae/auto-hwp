import { chatSidePanel } from "../chatSlot";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HwpWorkspace } from "../components/HwpWorkspace";
import { RowHeadOverlay } from "../components/RowHeadOverlay";
import { GhostPreviewOverlay } from "../components/GhostPreviewOverlay";
import type { AiRequestOptions, Anchor, BlockHit, CellHit, DocContext, Intent, TableBox } from "../types";
import { MockAdapter } from "./mockAdapter";

// 이슈 2(행/칸 정밀 선택) + 이슈 3(적용 전 고스트 프리뷰)의 React 절반.
//
// 이슈 2 재현 근거: 표 위 단일 클릭은 "표 (p.1)" 앵커, 셀은 **더블클릭 드릴**로만 잡혔고 행 앵커는
// 아예 없었다(`kind:"range"` 생산자 0). 여기서 잠그는 것 — ① 표를 고르면 행 머리가 보인다(어포던스)
// ② 행 머리 클릭 → "표 N행 전체" 칩 ③ Shift+행 머리 → 행 범위 ④ Shift+셀 클릭 → 칸 범위.
//
// 이슈 3: 카드 hover / "미리 보기" 토글 → 대상 자리에 고스트, 떠나면/적용하면 사라진다.

const origRect = Element.prototype.getBoundingClientRect;
beforeAll(() => {
  Element.prototype.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: 794, bottom: 1123, width: 794, height: 1123, x: 0, y: 0, toJSON() {} }) as DOMRect;
});
afterAll(() => {
  Element.prototype.getBoundingClientRect = origRect;
});

const doc = { bytes: new Uint8Array([1]), name: "t.hwpx" };
const noAi = async () => [] as Intent[];
type Ai = (instruction: string, anchors: Anchor[], ctx: DocContext, opts?: AiRequestOptions) => Promise<Intent[]>;

const COLS = [40, 140, 340];
const ROWS = [60, 100, 140, 180];
const table: TableBox = { section: 0, block: 1, x: 40, y: 60, w: 300, h: 120, rows: 3, cols: 2, first_row: 0 };
const tableHit: BlockHit = { section: 0, block: 1, kind: "table", x: 40, y: 60, w: 300, h: 120, text: "표", editable: true };

const cellAt = (_p: number, x: number, y: number): CellHit | null => {
  const col = COLS.findIndex((c, i) => i + 1 < COLS.length && x >= c && x < COLS[i + 1]);
  const row = ROWS.findIndex((r, i) => i + 1 < ROWS.length && y >= r && y < ROWS[i + 1]);
  if (col < 0 || row < 0) return null;
  return {
    section: 0,
    block: 1,
    row,
    col,
    rows: 3,
    cols: 2,
    text: `r${row}c${col}`,
    x: COLS[col],
    y: ROWS[row],
    w: COLS[col + 1] - COLS[col],
    h: ROWS[row + 1] - ROWS[row],
  };
};

function tableAdapter() {
  return new MockAdapter({
    table: (_p, x, y) => (x >= 40 && x <= 340 && y >= 60 && y <= 180 ? table : null),
    hit: tableHit,
    cell: cellAt,
    colBoundaries: COLS,
    rowBoundaries: ROWS,
    blocks: [tableHit],
    pages: 1,
  });
}

async function openWorkspace(adapter: MockAdapter, onAiRequest: Ai = noAi) {
  const view = render(
    <HwpWorkspace adapter={adapter} document={doc} onAiRequest={onAiRequest} sidePanel={chatSidePanel({ onAiRequest })} enableEditing />,
  );
  await waitFor(() => expect(view.container.querySelector(".hw-sheet svg")).toBeTruthy());
  return view;
}

function sheet(container: HTMLElement): HTMLElement {
  return container.querySelector('.hw-sheet[data-page="0"]') as HTMLElement;
}

function click(el: HTMLElement, x: number, y: number, init: Record<string, unknown> = {}) {
  fireEvent.pointerDown(el, { clientX: x, clientY: y, button: 0, pointerId: 1, ...init });
  fireEvent.pointerUp(el, { clientX: x, clientY: y, button: 0, pointerId: 1, ...init });
}

const anchorText = (container: HTMLElement) => container.querySelector(".hw-anchor")?.textContent ?? "";

// ── 순수 컴포넌트 ────────────────────────────────────────────────────────────────────────────────────
describe("RowHeadOverlay (이슈 2) — 순수 레이어", () => {
  it("행마다 클릭 타깃을 그리고, 전역 행 번호(first_row 반영)를 낸다", () => {
    const picked: [number, boolean][] = [];
    render(<RowHeadOverlay boundaries={[0, 20, 40]} left={40} firstRow={5} scale={2} onSelectRow={(r, e) => picked.push([r, e])} />);
    // 조각의 두 행 = 전역 5·6행 → 1-based 라벨 "6행 전체 선택"/"7행 전체 선택".
    expect(screen.getByTestId("hw-row-head-5").getAttribute("aria-label")).toBe("6행 전체 선택");
    const head = screen.getByTestId("hw-row-head-6");
    // scale=2, 표 왼쪽(40) 바깥에 폭 12px → left = (40-12)*2
    expect((head as HTMLElement).style.left).toBe("56px");
    fireEvent.click(head, { shiftKey: true });
    expect(picked).toEqual([[6, true]]);
  });

  it("경계가 하나뿐이면(행 0개) 아무것도 그리지 않는다", () => {
    const { container } = render(<RowHeadOverlay boundaries={[0]} left={0} firstRow={0} scale={1} onSelectRow={() => {}} />);
    expect(container.querySelector(".hw-row-heads")).toBeNull();
  });
});

describe("GhostPreviewOverlay (이슈 3) — 순수 레이어", () => {
  it("자기 페이지 고스트만 그린다 + 클릭을 가로채지 않는다", () => {
    const { container } = render(
      <GhostPreviewOverlay
        page={0}
        scale={2}
        ghosts={[
          { index: 0, page: 0, box: { x: 10, y: 20, w: 30, h: 40 }, text: "오또케" },
          { index: 1, page: 1, box: { x: 0, y: 0, w: 10, h: 10 }, text: "다른 쪽" },
        ]}
      />,
    );
    expect(screen.getByTestId("hw-ghost-0").textContent).toBe("오또케");
    expect(container.querySelector('[data-testid="hw-ghost-1"]')).toBeNull();
    const g = screen.getByTestId("hw-ghost-0") as HTMLElement;
    expect(g.style.left).toBe("20px");
    expect(g.style.width).toBe("60px");
  });

  it("고스트가 없으면 레이어 자체가 없다", () => {
    const { container } = render(<GhostPreviewOverlay page={0} scale={1} ghosts={[]} />);
    expect(container.querySelector(".hw-ghosts")).toBeNull();
  });
});

// ── 워크스페이스 통합 ────────────────────────────────────────────────────────────────────────────────
describe("HwpWorkspace — 행/칸 정밀 선택 (이슈 2)", () => {
  it("표를 고르면 행 머리가 뜨고, 행 머리 클릭이 '표 N행 전체' 앵커를 만든다", async () => {
    const adapter = tableAdapter();
    const { container } = await openWorkspace(adapter);
    click(sheet(container), 200, 120); // 표 클릭 → 표 전체 앵커(종전 동작 유지)
    await waitFor(() => expect(anchorText(container)).toContain("표"));

    // 어포던스: 행마다 머리가 보인다(종전엔 행을 가리킬 수단이 전혀 없었다).
    const head = await screen.findByTestId("hw-row-head-1");
    fireEvent.click(head);
    await waitFor(() => expect(anchorText(container)).toContain("표 2행 전체"));
    expect(container.querySelectorAll(".hw-anchor")).toHaveLength(1);
    // 마크는 표 폭 전체를 덮는 range 마크다.
    await waitFor(() => expect(container.querySelector(".hw-mark-range")).toBeTruthy());
  });

  it("Shift+행 머리는 행 범위로 자란다", async () => {
    const adapter = tableAdapter();
    const { container } = await openWorkspace(adapter);
    click(sheet(container), 200, 120);
    fireEvent.click(await screen.findByTestId("hw-row-head-0"));
    await waitFor(() => expect(anchorText(container)).toContain("표 1행 전체"));
    fireEvent.click(await screen.findByTestId("hw-row-head-2"), { shiftKey: true });
    await waitFor(() => expect(anchorText(container)).toContain("표 1~3행 전체"));
  });

  it("셀을 드릴한 뒤 Shift+클릭하면 칸 범위 앵커가 된다", async () => {
    const adapter = tableAdapter();
    const { container } = await openWorkspace(adapter);
    const el = sheet(container);
    click(el, 80, 80); // 표 전체
    click(el, 80, 80); // 더블클릭 → (0,0) 셀 드릴
    await waitFor(() => expect(anchorText(container)).toMatch(/행 1열/));
    click(el, 200, 120, { shiftKey: true }); // (1,1) 까지 확장
    await waitFor(() => expect(anchorText(container)).toContain("표 1~2행"));
    expect(container.querySelectorAll(".hw-anchor")).toHaveLength(1);
  });
});

describe("HwpWorkspace — 적용 전 고스트 프리뷰 (이슈 3)", () => {
  const fillIntents: Intent[] = [
    { intent: "SetTableCell", section: 0, index: 1, row: 1, col: 1, text: "오또케" } as Intent,
    { intent: "TableInsertRows", section: 0, index: 1, at: 3, count: 1, cols: 2 } as Intent,
  ];

  async function proposeFill() {
    const adapter = tableAdapter();
    const onAiRequest: Ai = async () => fillIntents;
    const view = await openWorkspace(adapter, onAiRequest);
    const textarea = view.container.querySelector(".hw-textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "이 칸 채워줘" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await screen.findByTestId("hw-ghost-toggle");
    return view;
  }

  it("카드에 hover 하면 대상 칸에 고스트가 뜨고, 떠나면 사라진다", async () => {
    const { container } = await proposeFill();
    const cards = screen.getAllByTestId("hw-card");
    fireEvent.pointerEnter(cards[0]);
    const ghost = await screen.findByTestId("hw-ghost-0");
    expect(ghost.textContent).toBe("오또케");
    // 셀 (1,1) 박스 = COLS[1]..COLS[2] × ROWS[1]..ROWS[2] — 줌 배율과 무관하게 비율로 검증한다.
    const px = (v: string) => parseFloat(v);
    const g = ghost as HTMLElement;
    expect(px(g.style.top) / px(g.style.height)).toBeCloseTo(ROWS[1] / (ROWS[2] - ROWS[1]), 3);
    expect(px(g.style.left) / px(g.style.width)).toBeCloseTo(COLS[1] / (COLS[2] - COLS[1]), 3);
    fireEvent.pointerLeave(cards[0]);
    await waitFor(() => expect(container.querySelector(".hw-ghosts")).toBeNull());
  });

  it("'미리 보기' 토글은 제안 전체를 고정하고, 다시 누르면 해제된다", async () => {
    const { container } = await proposeFill();
    const toggle = screen.getByTestId("hw-ghost-toggle");
    fireEvent.click(toggle);
    await screen.findByTestId("hw-ghost-0");
    // 그릴 수 없는 편집(TableInsertRows)은 고스트가 없다 — 거짓 프리뷰 금지.
    expect(container.querySelector('[data-testid="hw-ghost-1"]')).toBeNull();
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(toggle);
    await waitFor(() => expect(container.querySelector(".hw-ghosts")).toBeNull());
  });

  it("적용하면 고스트가 남지 않는다", async () => {
    const { container } = await proposeFill();
    fireEvent.click(screen.getByTestId("hw-ghost-toggle"));
    await screen.findByTestId("hw-ghost-0");
    fireEvent.click(screen.getByText("✓ 적용"));
    await waitFor(() => expect(container.querySelector(".hw-ghosts")).toBeNull());
  });

  it("그릴 수 있는 편집이 하나도 없으면 토글 대신 정직한 안내가 나온다", async () => {
    const adapter = tableAdapter();
    const onAiRequest: Ai = async () => [{ intent: "DeleteBlock", section: 0, index: 1 } as Intent];
    const { container } = await openWorkspace(adapter, onAiRequest);
    const textarea = container.querySelector(".hw-textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "이 표 지워줘" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await screen.findByTestId("hw-ghost-none");
    expect(container.querySelector('[data-testid="hw-ghost-toggle"]')).toBeNull();
  });
});
