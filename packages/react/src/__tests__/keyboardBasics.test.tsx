import { chatSidePanel } from "../chatSlot";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { HwpWorkspace } from "../components/HwpWorkspace";
import { gridToTsv, joinSelectionText } from "../clipboard";
import type { CellHit, Intent, TableBox, TableGrid } from "../types";
import { MockAdapter } from "./mockAdapter";

// jsdom does no layout — stub getBoundingClientRect to a full A4 box so coords.ts maps clicks to page px.
const origRect = Element.prototype.getBoundingClientRect;
beforeAll(() => {
  Element.prototype.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: 794, bottom: 1123, width: 794, height: 1123, x: 0, y: 0, toJSON() {} }) as DOMRect;
});
afterAll(() => {
  Element.prototype.getBoundingClientRect = origRect;
});
afterEach(() => {
  vi.restoreAllMocks();
});

// jsdom ships no `navigator.clipboard` (it needs a secure context) — install a spy-able one per test so
// the ⌘C path can be observed. `configurable` so each test re-defines it cleanly.
function stubClipboard(): ReturnType<typeof vi.fn> {
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true, writable: true });
  return writeText;
}

const noAi = async () => [] as Intent[];
const doc = { bytes: new Uint8Array([1]), name: "t.hwpx" };
const table: TableBox = { section: 0, block: 1, x: 40, y: 60, w: 300, h: 120, rows: 2, cols: 2, first_row: 0 };
const cell: CellHit = { section: 0, block: 1, row: 1, col: 1, rows: 2, cols: 2, text: "옛 값", x: 190, y: 100, w: 150, h: 40 };
const geom = { w: 794, h: 1123, ml: 90, mt: 90, mr: 90, mb: 90 };

function mount(adapter: MockAdapter) {
  return render(<HwpWorkspace adapter={adapter} document={doc} onAiRequest={noAi} sidePanel={chatSidePanel({ onAiRequest: noAi })} enableEditing />);
}

async function sheetOf(container: HTMLElement): Promise<HTMLElement> {
  return waitFor(() => {
    const el = container.querySelector('.hw-sheet[data-page="0"]');
    expect(el?.querySelector("svg")).toBeTruthy();
    return el as HTMLElement;
  });
}

/** Put ONE batch on the undo stack through the real edit lane (툴바 표 추가 → InsertTableAt), so a ⌘Z has
 *  something genuine to revert — an empty stack would make every assertion below vacuously "pass". */
async function applyOneEdit(adapter: MockAdapter) {
  fireEvent.click(screen.getByTestId("hw-table-insert"));
  fireEvent.mouseEnter(screen.getByTestId("hw-table-cell-2-2"));
  fireEvent.click(screen.getByTestId("hw-table-cell-2-2"));
  await waitFor(() => expect(adapter.applied.length).toBeGreaterThan(0));
}

// 06x drill: a single click marks the WHOLE table; a synchronous double-click drills into the exact CELL.
function drillCell(sheet: HTMLElement, x: number, y: number) {
  fireEvent.pointerDown(sheet, { clientX: x, clientY: y, button: 0, pointerId: 1 });
  fireEvent.pointerUp(sheet, { clientX: x, clientY: y, button: 0, pointerId: 1 });
  fireEvent.pointerDown(sheet, { clientX: x, clientY: y, button: 0, pointerId: 1 });
  fireEvent.pointerUp(sheet, { clientX: x, clientY: y, button: 0, pointerId: 1 });
}

describe("키보드 기본기 — ⌘Z / ⌘⇧Z 실행취소·재실행", () => {
  it("⌘Z 는 툴바 ↶ 버튼과 같은 레인으로 실행취소한다", async () => {
    const adapter = new MockAdapter({ table, pageGeom: geom, pages: 1 });
    const { container } = mount(adapter);
    await sheetOf(container);
    await applyOneEdit(adapter);

    fireEvent.keyDown(window, { key: "z", metaKey: true });
    await waitFor(() => expect(adapter.undos).toBe(1));
    await waitFor(() => expect(screen.getByText("실행취소")).toBeTruthy());
  });

  it("Ctrl+Z 도 같다 (윈도우/리눅스)", async () => {
    const adapter = new MockAdapter({ table, pageGeom: geom, pages: 1 });
    const { container } = mount(adapter);
    await sheetOf(container);
    await applyOneEdit(adapter);

    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    await waitFor(() => expect(adapter.undos).toBe(1));
  });

  it("⌘⇧Z 와 ⌘Y 는 재실행 — 되돌린 배치를 다시 올린다", async () => {
    const adapter = new MockAdapter({ table, pageGeom: geom, pages: 1 });
    const { container } = mount(adapter);
    await sheetOf(container);
    await applyOneEdit(adapter);

    fireEvent.keyDown(window, { key: "z", metaKey: true });
    await waitFor(() => expect(adapter.undos).toBe(1));
    // ⌘⇧Z (맥/한글 관례)
    fireEvent.keyDown(window, { key: "Z", metaKey: true, shiftKey: true });
    await waitFor(() => expect(adapter.redos).toBe(1));
    // ⌘Y (윈도우 관례) — 다시 취소한 뒤 재실행되는지
    fireEvent.keyDown(window, { key: "z", metaKey: true });
    await waitFor(() => expect(adapter.undos).toBe(2));
    fireEvent.keyDown(window, { key: "y", metaKey: true });
    await waitFor(() => expect(adapter.redos).toBe(2));
  });

  it("⌥/Alt 조합은 우리 것이 아니다 (⌥⌘Z 는 무시)", async () => {
    const adapter = new MockAdapter({ table, pageGeom: geom, pages: 1 });
    const { container } = mount(adapter);
    await sheetOf(container);
    await applyOneEdit(adapter);

    fireEvent.keyDown(window, { key: "z", metaKey: true, altKey: true });
    await new Promise((r) => setTimeout(r, 0));
    expect(adapter.undos).toBe(0);
  });

  it("가드 실증 — 채팅 작성창(텍스트 입력 표면)에 포커스가 있으면 가로채지 않는다", async () => {
    const adapter = new MockAdapter({ table, pageGeom: geom, pages: 1 });
    const { container } = mount(adapter);
    await sheetOf(container);
    await applyOneEdit(adapter);

    // 작성창 안에서의 ⌘Z 는 브라우저 기본 실행취소(그 textarea 의 입력 되돌리기)여야 한다.
    const composer = container.querySelector("textarea.hw-textarea") as HTMLTextAreaElement;
    expect(composer).toBeTruthy();
    composer.focus();
    fireEvent.keyDown(composer, { key: "z", metaKey: true });
    await new Promise((r) => setTimeout(r, 0));
    expect(adapter.undos).toBe(0); // 문서 undo 는 일어나지 않았다

    // 양성 대조 — 리스너 자체는 살아 있다: 포커스를 문서로 되돌리면 같은 키가 실행취소를 한다.
    composer.blur();
    fireEvent.keyDown(window, { key: "z", metaKey: true });
    await waitFor(() => expect(adapter.undos).toBe(1));
  });

  it("가드 실증 — 제자리 셀 에디터(contentEditable)가 열려 있으면 가로채지 않는다", async () => {
    const adapter = new MockAdapter({ table, cell, runs: [{ text: "옛 값" }], pageGeom: geom, pages: 1 });
    const { container } = mount(adapter);
    const sheet = await sheetOf(container);
    await applyOneEdit(adapter);

    drillCell(sheet, 200, 100);
    await waitFor(() => expect(container.querySelector(".hw-mark-cell")).toBeTruthy());
    fireEvent.keyDown(window, { key: "Enter" }); // 036: 셀 선택 + Enter = 제자리 편집
    const ed = await screen.findByTestId("hw-inplace-editor");

    fireEvent.keyDown(ed, { key: "z", metaKey: true });
    await new Promise((r) => setTimeout(r, 0));
    // 미커밋 편집이 문서 undo 의 리플로우로 사라지면 안 된다 (규율 6) — 엔진은 건드리지 않는다.
    expect(adapter.undos).toBe(0);
    expect(screen.queryByTestId("hw-inplace-editor")).toBeTruthy();
  });

  it("문서가 없으면 ⌘Z 는 브라우저 기본 실행취소에 양보한다", async () => {
    const adapter = new MockAdapter({ table, pageGeom: geom, pages: 1 });
    render(<HwpWorkspace adapter={adapter} document={null} onAiRequest={noAi} sidePanel={chatSidePanel({ onAiRequest: noAi })} enableEditing />);
    const e = new KeyboardEvent("keydown", { key: "z", metaKey: true, cancelable: true, bubbles: true });
    window.dispatchEvent(e);
    await new Promise((r) => setTimeout(r, 0));
    expect(e.defaultPrevented).toBe(false); // preventDefault 조차 하지 않는다
    expect(adapter.undos).toBe(0);
  });
});

describe("키보드 기본기 — ⌘C 복사", () => {
  it("선택한 셀의 평문을 클립보드에 넣는다", async () => {
    const writeText = stubClipboard();
    const adapter = new MockAdapter({ table, cell, pageGeom: geom, pages: 1 });
    const { container } = mount(adapter);
    const sheet = await sheetOf(container);

    drillCell(sheet, 200, 100);
    await waitFor(() => expect(container.querySelector(".hw-mark-cell")).toBeTruthy());

    fireEvent.keyDown(window, { key: "c", metaKey: true });
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("옛 값"));
  });

  it("표 선택은 셀을 탭·줄바꿈으로 이어 붙인다 (스프레드시트 붙여넣기)", async () => {
    const writeText = stubClipboard();
    const adapter = new MockAdapter({ table, cell, pageGeom: geom, pages: 1 });
    // tableGrid 는 OPTIONAL 메서드 — 이 테스트에서만 있는 백엔드처럼 붙인다 (WasmAdapter 패리티).
    const grid: TableGrid = {
      section: 0,
      block: 1,
      rows: 2,
      cols: 2,
      cells: [
        { row: 0, col: 0, text: "항목" },
        { row: 0, col: 1, text: "값" },
        { row: 1, col: 0, text: "합계" },
        { row: 1, col: 1, text: "1,000" },
      ],
    };
    (adapter as unknown as { tableGrid: () => Promise<TableGrid> }).tableGrid = async () => grid;
    const { container } = mount(adapter);
    const sheet = await sheetOf(container);

    // 단일 클릭 = 표 전체 마크 (드릴 아님).
    fireEvent.pointerDown(sheet, { clientX: 100, clientY: 100, button: 0, pointerId: 1 });
    fireEvent.pointerUp(sheet, { clientX: 100, clientY: 100, button: 0, pointerId: 1 });
    await waitFor(() => expect(container.querySelector(".hw-mark-table")).toBeTruthy());

    fireEvent.keyDown(window, { key: "c", metaKey: true });
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("항목\t값\n합계\t1,000"));
  });

  it("선택이 없으면 no-op — 클립보드를 건드리지 않고 기본 복사에 양보한다", async () => {
    const writeText = stubClipboard();
    const adapter = new MockAdapter({ table, pageGeom: geom, pages: 1 });
    const { container } = mount(adapter);
    await sheetOf(container);

    const e = new KeyboardEvent("keydown", { key: "c", metaKey: true, cancelable: true, bubbles: true });
    window.dispatchEvent(e);
    await new Promise((r) => setTimeout(r, 0));
    expect(writeText).not.toHaveBeenCalled();
    expect(e.defaultPrevented).toBe(false);
  });

  it("가드 실증 — 텍스트 입력 표면에서는 ⌘C 를 가로채지 않는다 (선택이 있어도)", async () => {
    const writeText = stubClipboard();
    const adapter = new MockAdapter({ table, cell, pageGeom: geom, pages: 1 });
    const { container } = mount(adapter);
    const sheet = await sheetOf(container);
    drillCell(sheet, 200, 100);
    await waitFor(() => expect(container.querySelector(".hw-mark-cell")).toBeTruthy());

    const composer = container.querySelector("textarea.hw-textarea") as HTMLTextAreaElement;
    composer.focus();
    fireEvent.keyDown(composer, { key: "c", metaKey: true });
    await new Promise((r) => setTimeout(r, 0));
    expect(writeText).not.toHaveBeenCalled(); // 작성창의 선택 텍스트가 복사되어야 한다

    // 양성 대조 — 문서로 포커스를 돌리면 같은 키가 셀을 복사한다.
    composer.blur();
    fireEvent.keyDown(window, { key: "c", metaKey: true });
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("옛 값"));
  });
});

describe("clipboard 순수 헬퍼 — 표 → TSV", () => {
  const grid: TableGrid = {
    section: 0,
    block: 1,
    rows: 2,
    cols: 3,
    cells: [
      { row: 0, col: 0, text: "A" },
      { row: 0, col: 2, text: "C" }, // (0,1) 은 병합으로 덮인 칸 — cells 에 없다
      { row: 1, col: 0, text: "여러\n문단" },
      { row: 1, col: 1, text: "탭\t포함" },
      { row: 1, col: 2, text: "" },
    ],
  };

  it("덮인 칸은 빈 칸으로 채워 열 정렬을 유지한다", () => {
    expect(gridToTsv(grid).split("\n")[0]).toBe("A\t\tC");
  });

  it("셀 안의 줄바꿈·탭은 공백으로 접는다 (격자가 어긋나지 않게)", () => {
    expect(gridToTsv(grid).split("\n")[1]).toBe("여러 문단\t탭 포함\t");
  });

  it("rows/cols 범위 선택은 부분 격자만 낸다", () => {
    expect(gridToTsv(grid, [0, 0], [0, 1])).toBe("A\t");
    expect(gridToTsv(grid, [1, 1], [2, 2])).toBe(""); // 범위 밖 → 빈 문자열
  });

  it("다중 선택은 줄바꿈으로 잇고 빈 조각은 버린다", () => {
    expect(joinSelectionText(["가", "", "나"])).toBe("가\n나");
    expect(joinSelectionText(["", ""])).toBe("");
  });
});
