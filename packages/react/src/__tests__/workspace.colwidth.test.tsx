import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HwpWorkspace, consumeShield, disarmShield } from "../components/HwpWorkspace";
import { ColumnWidthDialog } from "../components/ColumnWidthDialog";
import { CellShadePalette } from "../components/CellShadePalette";
import type { CellHit, Intent, TableBox } from "../types";
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

const noAi = async () => [] as Intent[];
const doc = { bytes: new Uint8Array([1]), name: "t.hwpx" };
const table: TableBox = { section: 0, block: 1, x: 40, y: 60, w: 300, h: 120, rows: 3, cols: 3, first_row: 0 };
// A cell at col 1 (interior column) of a 3-col table; UNEQUAL boundaries so 균등 분배 actually changes them.
const cellC1: CellHit = { section: 0, block: 1, row: 1, col: 1, rows: 3, cols: 3, text: "칸", x: 120, y: 100, w: 120, h: 40 };
const unevenCols = [40, 120, 240, 340]; // widths 80 / 120 / 100 (px) — NOT equal

async function sheetOf(container: HTMLElement): Promise<HTMLElement> {
  return waitFor(() => {
    const el = container.querySelector('.hw-sheet[data-page="0"]');
    expect(el?.querySelector("svg")).toBeTruthy();
    return el as HTMLElement;
  });
}

// Figma drill (issue 06x): a single click marks the whole table, so opening the in-place editor over a
// cell = DRILL (double-click → select the cell), wait for the drill to settle, then Enter (issue 036).
async function openCellEditorAt(sheet: HTMLElement, container: HTMLElement, x: number, y: number) {
  fireEvent.pointerDown(sheet, { clientX: x, clientY: y, button: 0, pointerId: 1 });
  fireEvent.pointerUp(sheet, { clientX: x, clientY: y, button: 0, pointerId: 1 });
  fireEvent.pointerDown(sheet, { clientX: x, clientY: y, button: 0, pointerId: 1 });
  fireEvent.pointerUp(sheet, { clientX: x, clientY: y, button: 0, pointerId: 1 });
  await waitFor(() => expect(container.querySelector(".hw-anchor")?.textContent ?? "").toMatch(/행/));
  fireEvent.keyDown(window, { key: "Enter" });
}

// ── ColumnWidthDialog — presentational unit (issue 047) ───────────────────────────────────────────────
describe("ColumnWidthDialog (issue 047) — mm 표시/입력 + 균등 분배 버튼", () => {
  it("shows the current mm, applies a typed mm on Enter, and equalize fires with the column count", () => {
    let appliedMm = -1;
    let equalized = 0;
    render(
      <ColumnWidthDialog
        x={50}
        y={50}
        currentMm={31.8}
        columnLabel="2열"
        equalizeCount={3}
        onApplyMm={(mm) => (appliedMm = mm)}
        onEqualize={() => (equalized++)}
        onClose={() => {}}
      />,
    );
    const dialog = screen.getByTestId("hw-colwidth-dialog");
    expect(dialog.getAttribute("role")).toBe("dialog");
    // current mm readout (실측값) is shown to 1dp (no false precision).
    expect(dialog.textContent).toContain("31.8");
    const input = screen.getByTestId("hw-colwidth-input") as HTMLInputElement;
    expect(input.value).toBe("31.8");
    fireEvent.change(input, { target: { value: "20" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(appliedMm).toBe(20);
    // 균등 분배 shows the count and fires.
    const eq = screen.getByTestId("hw-colwidth-equalize");
    expect(eq.textContent).toContain("3열");
    fireEvent.click(eq);
    expect(equalized).toBe(1);
  });

  it("disables 균등 분배 when only one column is in scope (미지원은 조용한 무시 금지)", () => {
    render(
      <ColumnWidthDialog x={0} y={0} currentMm={10} columnLabel="1열" equalizeCount={1} onApplyMm={() => {}} onEqualize={() => {}} onClose={() => {}} />,
    );
    expect((screen.getByTestId("hw-colwidth-equalize") as HTMLButtonElement).disabled).toBe(true);
  });

  it("rejects a below-minimum mm (거짓 커밋 금지)", () => {
    let appliedMm = -1;
    render(
      <ColumnWidthDialog x={0} y={0} currentMm={10} columnLabel="1열" equalizeCount={2} onApplyMm={(mm) => (appliedMm = mm)} onEqualize={() => {}} onClose={() => {}} />,
    );
    const input = screen.getByTestId("hw-colwidth-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "0.5" } }); // < MIN_MM (2)
    fireEvent.keyDown(input, { key: "Enter" });
    expect(appliedMm).toBe(-1); // not applied
  });
});

// ── CellShadePalette — presentational unit (issue 047) ────────────────────────────────────────────────
describe("CellShadePalette (issue 047) — 편집 중 셀음영 스와치", () => {
  it("a swatch preventDefaults its mousedown (편집기 blur→commit 방지) and picks the color on click", () => {
    let picked: string | null | undefined;
    render(<CellShadePalette box={{ x: 40, y: 60, w: 100, h: 40 }} scale={1} onPick={(c) => (picked = c)} />);
    const swatch = screen.getByTestId("hw-cell-shade-#D8D8D8");
    // mousedown is preventDefaulted so the click never blurs (→ commits) the open contentEditable editor.
    const md = fireEvent.mouseDown(swatch);
    expect(md).toBe(false); // preventDefault → dispatchEvent returns false
    fireEvent.click(swatch);
    expect(picked).toBe("#D8D8D8");
    // clear picks null.
    fireEvent.click(screen.getByTestId("hw-cell-shade-clear"));
    expect(picked).toBeNull();
  });
});

// ── HwpWorkspace integration — 열 너비 mm 다이얼로그 (적용-확인) ────────────────────────────────────────
describe("HwpWorkspace 열 너비 mm 다이얼로그 (issue 047)", () => {
  it("셀 우클릭 → '열 너비…' → 다이얼로그(현재 mm 표시); mm 입력·Enter → SetTableColWidths + 적용-확인 성공 토스트", async () => {
    const adapter = new MockAdapter({ table, cell: cellC1, runs: [{ text: "칸" }], colBoundaries: unevenCols, liveResize: true, pages: 1 });
    const { container } = render(<HwpWorkspace adapter={adapter} document={doc} onAiRequest={noAi} enableEditing />);
    const sheet = await sheetOf(container);
    fireEvent.contextMenu(sheet, { clientX: 160, clientY: 110 });
    // the '열 너비…' item is present + enabled once editTarget (boundaries) resolves.
    const item = await screen.findByTestId("hw-ctx-colwidth");
    await waitFor(() => expect((item as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(item);
    const dialog = await screen.findByTestId("hw-colwidth-dialog");
    // current width of column 1 = pxToMm(240-120)=pxToMm(120) — an honest 1dp readout of the ACTUAL float
    // (31.749996… → 31.7, NOT a fabricated 31.8): the 거짓 정밀도 금지 rule made visible.
    expect(dialog.textContent).toContain("31.7");
    const input = screen.getByTestId("hw-colwidth-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "20" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => {
      const applied = adapter.applied.find((i) => i.intent === "SetTableColWidths") as (Intent & { widths: number[] }) | undefined;
      expect(applied).toBeTruthy();
      expect(applied!.widths.length).toBe(3); // whole-table column widths
    });
    // apply-verify SUCCESS (the re-queried boundary moved) — NOT a false success.
    await waitFor(() => expect(screen.getByText("열 너비를 변경했습니다")).toBeTruthy());
  });

  it("FROZEN engine → 열 너비 다이얼로그 적용이 반영 안 되면 정직한 실패 토스트 (적용-확인)", async () => {
    // No liveResize → the boundaries stay frozen: the apply-verify must surface the honest failure.
    const adapter = new MockAdapter({ table, cell: cellC1, runs: [{ text: "칸" }], colBoundaries: unevenCols, pages: 1 });
    const { container } = render(<HwpWorkspace adapter={adapter} document={doc} onAiRequest={noAi} enableEditing />);
    const sheet = await sheetOf(container);
    fireEvent.contextMenu(sheet, { clientX: 160, clientY: 110 });
    const item = await screen.findByTestId("hw-ctx-colwidth");
    await waitFor(() => expect((item as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(item);
    const input = (await screen.findByTestId("hw-colwidth-input")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "20" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(adapter.applied.some((i) => i.intent === "SetTableColWidths")).toBe(true));
    await waitFor(() => expect(screen.getByText("열 너비 변경이 반영되지 않았습니다 — 다시 시도하세요")).toBeTruthy());
    expect(screen.queryByText("열 너비를 변경했습니다")).toBeNull();
  });

  it("균등 분배 → 전 열 등폭 SetTableColWidths (widths 모두 동일)", async () => {
    const adapter = new MockAdapter({ table, cell: cellC1, runs: [{ text: "칸" }], colBoundaries: unevenCols, liveResize: true, pages: 1 });
    const { container } = render(<HwpWorkspace adapter={adapter} document={doc} onAiRequest={noAi} enableEditing />);
    const sheet = await sheetOf(container);
    fireEvent.contextMenu(sheet, { clientX: 160, clientY: 110 });
    const item = await screen.findByTestId("hw-ctx-colwidth");
    await waitFor(() => expect((item as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(item);
    await screen.findByTestId("hw-colwidth-dialog");
    fireEvent.click(screen.getByTestId("hw-colwidth-equalize"));
    await waitFor(() => {
      const applied = adapter.applied.find((i) => i.intent === "SetTableColWidths") as (Intent & { widths: number[] }) | undefined;
      expect(applied).toBeTruthy();
      expect(applied!.widths.length).toBe(3);
      // whole-table equalize → every column ratio equal.
      expect(applied!.widths[0]).toBe(applied!.widths[1]);
      expect(applied!.widths[1]).toBe(applied!.widths[2]);
    });
    // the dialog closes after equalize (the reselect-after-repaint lesson: the selection is by index, so it
    // stays valid; the geometry re-resolves via refreshToken).
    await waitFor(() => expect(screen.queryByTestId("hw-colwidth-dialog")).toBeNull());
  });
});

// ── consumeShield/disarmShield — 카운티드 refreshToken 실드의 순수 계약 (issue 055 사후 #4/#9) ─────────
describe("consumeShield/disarmShield (issue 055 사후) — 셀음영/Tab이동/이미지커밋 공용 실드", () => {
  it("중첩 arm(2) + 코얼레스된 델타 2 → 전부 소비, 잔여 누수 0 (React 배칭 대응)", () => {
    const shield = { current: 2 };
    expect(consumeShield(shield, 2)).toBe(0); // 두 재플로우 모두 우리 것 — 닫지 않는다
    expect(shield.current).toBe(0); // 다음 정상 닫힘을 삼킬 카운트가 남지 않는다
  });
  it("실드보다 많은 재플로우 → 초과분이 unshielded 로 남는다(진짜 닫힘 신호)", () => {
    const shield = { current: 1 };
    expect(consumeShield(shield, 2)).toBe(1);
    expect(shield.current).toBe(0);
  });
  it("델타 0(마운트/무변화) → 소비도 닫힘도 없다", () => {
    const shield = { current: 1 };
    expect(consumeShield(shield, 0)).toBe(0);
    expect(shield.current).toBe(1);
  });
  it("disarmShield 는 0 밑으로 내려가지 않는다(실패 경로 이중 해제 안전)", () => {
    const shield = { current: 0 };
    disarmShield(shield);
    expect(shield.current).toBe(0);
    shield.current = 2;
    disarmShield(shield);
    expect(shield.current).toBe(1);
  });
});

// ── HwpWorkspace integration — 편집 중 셀음영 (에디터 유지 · 경합 금지) ─────────────────────────────────
describe("HwpWorkspace 편집 중 셀음영 (issue 047 목표 3)", () => {
  const cellEdit: CellHit = { section: 0, block: 1, row: 0, col: 0, rows: 3, cols: 3, text: "칸", x: 40, y: 60, w: 100, h: 40 };

  it("리치 에디터 열림 중 셀음영 스와치 → 1셀 SetCellRangeShade + 에디터 유지(uncommitted text 보존)", async () => {
    const adapter = new MockAdapter({ table, cell: cellEdit, runs: [{ text: "칸" }], pages: 1 });
    const { container } = render(<HwpWorkspace adapter={adapter} document={doc} onAiRequest={noAi} enableEditing />);
    const sheet = await sheetOf(container);
    // double-click a cell → the in-place editor opens.
    await openCellEditorAt(sheet, container, 60, 80);
    const editor = (await screen.findByTestId("hw-inplace-editor")) as HTMLElement;
    // the 편집 중 셀음영 palette appears over the editing cell.
    const palette = await screen.findByTestId("hw-cell-shade-palette");
    expect(palette).toBeTruthy();
    // pick a swatch → a 1-cell SetCellRangeShade on the edited cell (row 0, col 0).
    fireEvent.click(screen.getByTestId("hw-cell-shade-#E3F2FD"));
    await waitFor(() => {
      const applied = adapter.applied.find((i) => i.intent === "SetCellRangeShade") as (Intent & { r0: number; c0: number; r1: number; c1: number; shade: string }) | undefined;
      expect(applied).toBeTruthy();
      expect(applied).toMatchObject({ r0: 0, c0: 0, r1: 0, c1: 0, shade: "#E3F2FD" });
    });
    // 에디터 유지: the shade re-flow did NOT close the editor (shielded refreshToken close).
    await waitFor(() => expect(screen.getByText("배경색 적용")).toBeTruthy());
    expect(screen.queryByTestId("hw-inplace-editor")).toBe(editor);
    // and NO text commit was emitted by the shade (커밋/에디터 상태와 경합 금지).
    expect(adapter.applied.some((i) => i.intent === "SetTableCellRuns")).toBe(false);
  });

  it("중첩 셀음영(둘 다 인플라이트) — 실드 카운터가 두 재플로우를 모두 소비해 에디터가 유지된다 (issue 055 사후 #4)", async () => {
    // 워커 지연 시뮬레이션: applyGate 로 두 스와치 적용을 동시에 인플라이트로 묶고 하나씩 놓아준다.
    // 구 boolean 실드는 첫 재플로우가 소비하고 두 번째 재플로우가 에디터를 닫아 미커밋 텍스트를 잃었다.
    const gates: (() => void)[] = [];
    const adapter = new MockAdapter({
      table,
      cell: cellEdit,
      runs: [{ text: "칸" }],
      pages: 1,
      applyGate: () => new Promise<void>((r) => gates.push(r)),
    });
    const { container } = render(<HwpWorkspace adapter={adapter} document={doc} onAiRequest={noAi} enableEditing />);
    const sheet = await sheetOf(container);
    await openCellEditorAt(sheet, container, 60, 80);
    await screen.findByTestId("hw-inplace-editor");
    await screen.findByTestId("hw-cell-shade-palette");
    // 연속 스와치 2회 — 둘 다 커밋 전(인플라이트).
    fireEvent.click(screen.getByTestId("hw-cell-shade-#E3F2FD"));
    fireEvent.click(screen.getByTestId("hw-cell-shade-#D8D8D8"));
    await waitFor(() => expect(gates.length).toBe(2));
    // 첫 적용 완료 → 첫 재플로우가 실드 1개를 소비한다.
    gates.shift()!();
    await waitFor(() => expect(adapter.applied.filter((i) => i.intent === "SetCellRangeShade")).toHaveLength(1));
    expect(screen.queryByTestId("hw-inplace-editor")).toBeTruthy();
    // 두 번째 적용 완료 → 두 번째 재플로우도 실드가 소비해야 한다 (구 코드는 여기서 에디터가 닫혔다).
    gates.shift()!();
    await waitFor(() => expect(adapter.applied.filter((i) => i.intent === "SetCellRangeShade")).toHaveLength(2));
    await waitFor(() => expect(screen.getByText("배경색 적용")).toBeTruthy());
    expect(screen.queryByTestId("hw-inplace-editor")).toBeTruthy(); // 미커밋 텍스트가 살아 있다
  });

  it("셀음영 지움 → shade=null 1셀 SetCellRangeShade, 에디터 유지", async () => {
    const adapter = new MockAdapter({ table, cell: cellEdit, runs: [{ text: "칸" }], pages: 1 });
    const { container } = render(<HwpWorkspace adapter={adapter} document={doc} onAiRequest={noAi} enableEditing />);
    const sheet = await sheetOf(container);
    await openCellEditorAt(sheet, container, 60, 80);
    await screen.findByTestId("hw-inplace-editor");
    fireEvent.click(await screen.findByTestId("hw-cell-shade-clear"));
    await waitFor(() => {
      const applied = adapter.applied.find((i) => i.intent === "SetCellRangeShade") as (Intent & { shade: string | null }) | undefined;
      expect(applied).toBeTruthy();
      expect(applied!.shade).toBeNull();
    });
    expect(screen.queryByTestId("hw-inplace-editor")).toBeTruthy();
  });
});
