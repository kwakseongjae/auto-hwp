import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ContextMenu, type ContextMenuItem } from "../components/ContextMenu";
import { clampMenuPosition } from "../contextMenuPosition";
import { HwpWorkspace } from "../components/HwpWorkspace";
import type { BlockHit, CellHit, Intent, TableBox } from "../types";
import { MockAdapter } from "./mockAdapter";

// ── clampMenuPosition — pure viewport clamp/flip (issue 039) ─────────────────────────────────────────
describe("clampMenuPosition (issue 039) — 뷰포트 경계 클램프", () => {
  const vp = { width: 1000, height: 800 };
  it("opens right+down of the point when it fits", () => {
    expect(clampMenuPosition(100, 120, 180, 160, vp)).toEqual({ x: 100, y: 120 });
  });
  it("flips LEFT when the menu would overflow the right edge", () => {
    const p = clampMenuPosition(950, 120, 180, 160, vp);
    expect(p.x).toBe(950 - 180); // right edge sits at the point
    expect(p.y).toBe(120);
  });
  it("flips UP when the menu would overflow the bottom edge", () => {
    const p = clampMenuPosition(100, 780, 180, 160, vp);
    expect(p.y).toBe(780 - 160);
  });
  it("final-clamps to the margin when the menu is wider/taller than the viewport fits", () => {
    // menu 180 > viewport 190 − 2×margin(12) = 178 → can't fit; clamps to the margin (6).
    const p = clampMenuPosition(10, 10, 180, 160, { width: 190, height: 170 });
    expect(p.x).toBe(6);
    expect(p.y).toBe(6);
  });
});

// ── ContextMenu component — list, keyboard nav, close rules ──────────────────────────────────────────
describe("ContextMenu (issue 039) — list + 키보드 ↑↓/Enter + Esc/외부클릭/스크롤 닫힘", () => {
  const mkItems = (onA: () => void, onB: () => void): ContextMenuItem[] => [
    { type: "action", key: "a", label: "액션 A", onSelect: onA },
    { type: "separator", key: "s" },
    { type: "action", key: "b", label: "액션 B", disabled: true, onSelect: onB },
    { type: "action", key: "c", label: "액션 C", onSelect: onB },
  ];

  it("renders menuitems + separators; a click fires that item's onSelect + closes", () => {
    const onA = vi.fn();
    const onClose = vi.fn();
    render(<ContextMenu x={50} y={50} items={mkItems(onA, vi.fn())} onClose={onClose} />);
    expect(screen.getByTestId("hw-context-menu").getAttribute("role")).toBe("menu");
    expect((screen.getByTestId("hw-ctx-b") as HTMLButtonElement).disabled).toBe(true); // disabled row shows (미지원은 조용한 무시 금지)
    fireEvent.click(screen.getByTestId("hw-ctx-a"));
    expect(onA).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("↑↓ highlight SKIPS disabled/separator rows; Enter activates the highlighted one", () => {
    const onA = vi.fn();
    const onC = vi.fn();
    const onClose = vi.fn();
    render(<ContextMenu x={50} y={50} items={mkItems(onA, onC)} onClose={onClose} />);
    fireEvent.keyDown(window, { key: "ArrowDown" }); // → A
    expect(screen.getByTestId("hw-ctx-a").className).toContain("hw-ctxmenu-active");
    fireEvent.keyDown(window, { key: "ArrowDown" }); // → C (skips separator + disabled B)
    expect(screen.getByTestId("hw-ctx-c").className).toContain("hw-ctxmenu-active");
    fireEvent.keyDown(window, { key: "Enter" });
    expect(onC).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Esc / outside pointerdown / scroll each close the menu", () => {
    const onClose = vi.fn();
    const { rerender } = render(<ContextMenu x={50} y={50} items={mkItems(vi.fn(), vi.fn())} onClose={onClose} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    rerender(<ContextMenu x={50} y={50} items={mkItems(vi.fn(), vi.fn())} onClose={onClose} />);
    fireEvent.pointerDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(2);
    rerender(<ContextMenu x={50} y={50} items={mkItems(vi.fn(), vi.fn())} onClose={onClose} />);
    fireEvent.scroll(window);
    expect(onClose).toHaveBeenCalledTimes(3);
  });

  it("a pointerdown INSIDE the menu does NOT close it", () => {
    const onClose = vi.fn();
    render(<ContextMenu x={50} y={50} items={mkItems(vi.fn(), vi.fn())} onClose={onClose} />);
    fireEvent.pointerDown(screen.getByTestId("hw-ctx-a"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("custom (children) mode renders a heading + content, no item list", () => {
    render(
      <ContextMenu x={10} y={10} heading="표 추가" onClose={vi.fn()}>
        <div data-testid="custom-body">그리드</div>
      </ContextMenu>,
    );
    expect(screen.getByText("표 추가")).toBeTruthy();
    expect(screen.getByTestId("custom-body")).toBeTruthy();
  });
});

// ── HwpWorkspace integration — 우클릭 → 셀/문단/바탕 분기 + 액션 위임 ──────────────────────────────────
const origRect = Element.prototype.getBoundingClientRect;
beforeAll(() => {
  Element.prototype.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: 794, bottom: 1123, width: 794, height: 1123, x: 0, y: 0, toJSON() {} }) as DOMRect;
});
afterAll(() => {
  Element.prototype.getBoundingClientRect = origRect;
});

const noAi = async () => [] as Intent[];
const doc = { bytes: new Uint8Array([1]), name: "t.hwpx" };
const table: TableBox = { section: 0, block: 1, x: 40, y: 60, w: 300, h: 120, rows: 3, cols: 3, first_row: 0 };
const cell: CellHit = { section: 0, block: 1, row: 1, col: 1, rows: 3, cols: 3, text: "칸", x: 140, y: 100, w: 100, h: 40 };

async function sheetOf(container: HTMLElement): Promise<HTMLElement> {
  return waitFor(() => {
    const el = container.querySelector('.hw-sheet[data-page="0"]');
    expect(el?.querySelector("svg")).toBeTruthy();
    return el as HTMLElement;
  });
}

describe("HwpWorkspace 우클릭 컨텍스트 메뉴 (issue 039)", () => {
  it("셀 우클릭 → 셀 메뉴(텍스트 편집·굵게·배경색·행 삽입·AI); 굵게 → SetCellRangeFmt 위임", async () => {
    const adapter = new MockAdapter({ table, cell, runs: [{ text: "칸" }], colBoundaries: [40, 140, 240, 340], rowBoundaries: [60, 100, 140, 180], pages: 1 });
    const { container } = render(<HwpWorkspace adapter={adapter} document={doc} onAiRequest={noAi} enableEditing />);
    const sheet = await sheetOf(container);
    fireEvent.contextMenu(sheet, { clientX: 160, clientY: 110 });
    const menu = await screen.findByTestId("hw-context-menu");
    // 3분기 중 '셀' 메뉴 — 기대 항목이 전부 있다.
    expect(within(menu).queryByTestId("hw-ctx-edit")).toBeTruthy();
    expect(within(menu).queryByTestId("hw-ctx-bold")).toBeTruthy();
    expect(within(menu).queryByTestId("hw-ctx-shade")).toBeTruthy();
    expect(within(menu).queryByTestId("hw-ctx-row-above")).toBeTruthy();
    expect(within(menu).queryByTestId("hw-ctx-row-below")).toBeTruthy();
    expect(within(menu).queryByTestId("hw-ctx-ai")).toBeTruthy();
    // 굵게 → 셀 선택 대상으로 SetCellRangeFmt 위임 (editTarget 해석 후 활성).
    await waitFor(() => expect((screen.getByTestId("hw-ctx-bold") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId("hw-ctx-bold"));
    await waitFor(() => {
      const applied = adapter.applied.find((i) => i.intent === "SetCellRangeFmt") as (Intent & { bold: unknown; r0: number }) | undefined;
      expect(applied).toBeTruthy();
      expect(applied!.bold).toBe(true);
      expect(applied!.r0).toBe(1); // the right-clicked cell's row
    });
    // 액션 후 메뉴는 닫힌다.
    await waitFor(() => expect(screen.queryByTestId("hw-context-menu")).toBeNull());
  });

  it("셀 우클릭 → 아래에 행 삽입 → 기존 TableInsertRows op 위임 (at = row+1, cols = 표 열수)", async () => {
    const adapter = new MockAdapter({ table, cell, runs: [{ text: "칸" }], colBoundaries: [40, 140, 240, 340], pages: 1 });
    const { container } = render(<HwpWorkspace adapter={adapter} document={doc} onAiRequest={noAi} enableEditing />);
    const sheet = await sheetOf(container);
    fireEvent.contextMenu(sheet, { clientX: 160, clientY: 110 });
    await screen.findByTestId("hw-ctx-row-below");
    fireEvent.click(screen.getByTestId("hw-ctx-row-below"));
    await waitFor(() => {
      const applied = adapter.applied.find((i) => i.intent === "TableInsertRows") as (Intent & { at: number; cols: number; count: number }) | undefined;
      expect(applied).toBeTruthy();
      expect(applied!.at).toBe(2); // row 1 → below = 2
      expect(applied!.cols).toBe(3);
      expect(applied!.count).toBe(1);
    });
  });

  it("문단 우클릭 → 문단 메뉴(텍스트 편집 + AI만; 굵게·행 삽입 없음)", async () => {
    const para: BlockHit = { section: 0, block: 0, kind: "paragraph", x: 40, y: 400, w: 300, h: 30, text: "문단", editable: true };
    const adapter = new MockAdapter({ hit: para, pages: 1 });
    const { container } = render(<HwpWorkspace adapter={adapter} document={doc} onAiRequest={noAi} enableEditing />);
    const sheet = await sheetOf(container);
    fireEvent.contextMenu(sheet, { clientX: 100, clientY: 410 });
    const menu = await screen.findByTestId("hw-context-menu");
    expect(within(menu).queryByTestId("hw-ctx-edit")).toBeTruthy();
    expect(within(menu).queryByTestId("hw-ctx-ai")).toBeTruthy();
    expect(within(menu).queryByTestId("hw-ctx-bold")).toBeNull(); // 문단엔 셀 서식 없음 (메뉴가 거짓말하지 않는다)
    expect(within(menu).queryByTestId("hw-ctx-row-below")).toBeNull();
  });

  it("바탕(비개체) 우클릭 → 표 추가 그리드(027 픽커) → 2×3 → InsertTableAt 위임 (051 재배선)", async () => {
    const adapter = new MockAdapter({ pages: 1 }); // 아무 것도 히트 안 됨 → 바탕
    const { container } = render(<HwpWorkspace adapter={adapter} document={doc} onAiRequest={noAi} enableEditing />);
    const sheet = await sheetOf(container);
    fireEvent.contextMenu(sheet, { clientX: 500, clientY: 700 });
    const menu = await screen.findByTestId("hw-context-menu");
    expect(within(menu).getByText("표 추가")).toBeTruthy();
    fireEvent.click(within(menu).getByTestId("hw-table-cell-2-3"));
    await waitFor(() => {
      const applied = adapter.applied.find((i) => i.intent === "InsertTableAt") as (Intent & { rows: unknown[][] }) | undefined;
      expect(applied).toBeTruthy();
      expect(applied!.index).toBeNull(); // null = 구역 끝 (엔진이 블록 수를 해석 — INTENT-SCHEMA §6.9)
      expect(applied!.rows).toHaveLength(2);
    });
  });

  it("시트 위에서만 메뉴가 뜬다 — 캔버스 회색 여백 우클릭은 메뉴를 열지 않는다(기본 메뉴 유지)", async () => {
    const adapter = new MockAdapter({ table, cell, pages: 1 });
    const { container } = render(<HwpWorkspace adapter={adapter} document={doc} onAiRequest={noAi} enableEditing />);
    await sheetOf(container);
    const canvas = container.querySelector(".hw-canvas") as HTMLElement;
    // target = 캔버스 자체(시트 아님) → closest('.hw-sheet') 없음 → 메뉴 안 뜸.
    const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "target", { value: canvas });
    canvas.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false); // 기본 메뉴 차단하지 않음
    expect(screen.queryByTestId("hw-context-menu")).toBeNull();
  });

  it("enableEditing 이 꺼져 있으면 우클릭이 메뉴를 열지 않는다(읽기 전용 호스트 무영향)", async () => {
    const adapter = new MockAdapter({ table, cell, pages: 1 });
    const { container } = render(<HwpWorkspace adapter={adapter} document={doc} onAiRequest={noAi} />);
    const sheet = await sheetOf(container);
    const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "target", { value: sheet });
    sheet.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    expect(screen.queryByTestId("hw-context-menu")).toBeNull();
  });

  it("Esc 로 메뉴가 닫히고, 그 Esc 는 선택까지 지우지 않는다(메뉴가 Esc 를 소비)", async () => {
    const adapter = new MockAdapter({ table, cell, runs: [{ text: "칸" }], colBoundaries: [40, 140, 240, 340], pages: 1 });
    const { container } = render(<HwpWorkspace adapter={adapter} document={doc} onAiRequest={noAi} enableEditing />);
    const sheet = await sheetOf(container);
    fireEvent.contextMenu(sheet, { clientX: 160, clientY: 110 });
    await screen.findByTestId("hw-context-menu");
    await waitFor(() => expect(container.querySelector(".hw-anchor")).toBeTruthy()); // 셀이 선택되어 칩이 생겼다
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("hw-context-menu")).toBeNull()); // 메뉴 닫힘
    expect(container.querySelector(".hw-anchor")).toBeTruthy(); // 선택은 유지(메뉴가 Esc 를 소비)
  });
});
