import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { HwpWorkspace } from "../components/HwpWorkspace";
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
// Isolation: never let a spied global (e.g. a frozen Date.now for the double-click detector below) leak
// into a following test, even if a test throws before its own restore.
afterEach(() => {
  vi.restoreAllMocks();
});

const noAi = async () => [] as Intent[];
const doc = { bytes: new Uint8Array([1]), name: "t.hwpx" };
const table: TableBox = { section: 0, block: 1, x: 40, y: 60, w: 300, h: 120, rows: 3, cols: 3, first_row: 0 };

async function sheetOf(container: HTMLElement): Promise<HTMLElement> {
  return waitFor(() => {
    const el = container.querySelector('.hw-sheet[data-page="0"]');
    expect(el?.querySelector("svg")).toBeTruthy();
    return el as HTMLElement;
  });
}

// Figma drill (issue 06x): a single click marks the whole table, so SELECTING a cell = a DOUBLE-click
// (two synchronous ups within the 400ms window → drillInto). Kept synchronous so no full-suite-load gap
// pushes the 2nd click out of the window.
function drillCell(sheet: HTMLElement, x: number, y: number) {
  fireEvent.pointerDown(sheet, { clientX: x, clientY: y, button: 0, pointerId: 1 });
  fireEvent.pointerUp(sheet, { clientX: x, clientY: y, button: 0, pointerId: 1 });
  fireEvent.pointerDown(sheet, { clientX: x, clientY: y, button: 0, pointerId: 1 });
  fireEvent.pointerUp(sheet, { clientX: x, clientY: y, button: 0, pointerId: 1 });
}
// Open the in-place editor over a cell: drill to select it, wait for the drill to settle, then Enter
// (issue 036) — the robust editing entry (a 2nd double-click would race the drill).
async function openCellEditorAt(sheet: HTMLElement, container: HTMLElement, x: number, y: number) {
  drillCell(sheet, x, y);
  await waitFor(() => expect(container.querySelector(".hw-anchor")?.textContent ?? "").toMatch(/행/));
  fireEvent.keyDown(window, { key: "Enter" });
}

describe("HwpWorkspace issue-027 editing chrome — opt-in", () => {
  it("is OFF by default: no 표 추가 button, no ruler", async () => {
    const adapter = new MockAdapter({ table, pageGeom: { w: 794, h: 1123, ml: 90, mt: 90, mr: 90, mb: 90 }, pages: 1 });
    const { container } = render(<HwpWorkspace adapter={adapter} document={doc} onAiRequest={noAi} />);
    await sheetOf(container);
    expect(screen.queryByTestId("hw-table-insert")).toBeNull();
    expect(screen.queryByTestId("hw-ruler")).toBeNull();
  });

  it("enableEditing shows the ruler (mm) + 표 추가 button; picking a size inserts a table via InsertTableAt (051 재배선)", async () => {
    const adapter = new MockAdapter({ table, pageGeom: { w: 794, h: 1123, ml: 90, mt: 90, mr: 90, mb: 90 }, pages: 1 });
    const { container } = render(<HwpWorkspace adapter={adapter} document={doc} onAiRequest={noAi} enableEditing />);
    await sheetOf(container);
    await waitFor(() => expect(screen.getByTestId("hw-ruler")).toBeTruthy());

    fireEvent.click(screen.getByTestId("hw-table-insert"));
    fireEvent.mouseEnter(screen.getByTestId("hw-table-cell-2-2"));
    fireEvent.click(screen.getByTestId("hw-table-cell-2-2"));
    await waitFor(() => expect(adapter.applied).toHaveLength(1));
    const intent = adapter.applied[0] as Intent & { rows: unknown[][] };
    // 051: the ApplyContent end-append fallback is retired — the toolbar rides the same InsertTableAt
    // Intent the chat lane uses (index: null = section END; the engine resolves the block count).
    expect(intent.intent).toBe("InsertTableAt");
    expect(intent.index).toBeNull();
    expect(intent.rows).toHaveLength(2);
    expect(intent.rows[0]).toEqual([{}, {}]);
  });

  it("worker_dead 코드 에러 = 트랩과 같은 복구 레인: 복구 토스트, 실패 토스트 아님 (issue 055 사후 #1)", async () => {
    // 워커 죽음은 {code:"worker_dead"} + "engine worker died: …" 메시지로 온다 — 구 onTrap 은
    // "wasm_trap" 문자열만 매치해 이를 일반 실패로 오분류했다(복구 토스트/refresh 사장).
    const adapter = new MockAdapter({ table, pageGeom: { w: 794, h: 1123, ml: 90, mt: 90, mr: 90, mb: 90 }, pages: 1 });
    adapter.applyIntent = async () => {
      throw Object.assign(new Error("engine worker died: out of memory"), { code: "worker_dead" });
    };
    const { container } = render(<HwpWorkspace adapter={adapter} document={doc} onAiRequest={noAi} enableEditing />);
    await sheetOf(container);
    fireEvent.click(screen.getByTestId("hw-table-insert"));
    fireEvent.mouseEnter(screen.getByTestId("hw-table-cell-2-2"));
    fireEvent.click(screen.getByTestId("hw-table-cell-2-2"));
    // 복구 레인 토스트가 뜨고(어댑터가 재스폰+복구를 이미 마친 뒤이므로 사용자 안내 + refresh),
    // 일반 실패 토스트("표 추가 실패")로 새지 않는다.
    await waitFor(() => expect(screen.getByText("엔진 트랩 — 문서를 복구했습니다")).toBeTruthy());
    expect(screen.queryByText(/표 추가 실패/)).toBeNull();
  });

  it("marking a table shows column-resize grips; a drag MOVES the boundary + commits SetTableColWidths (issue 031)", async () => {
    // liveResize: the engine reflects the ratios back so apply-verify confirms movement (SUCCESS path).
    const adapter = new MockAdapter({ table, colBoundaries: [40, 140, 240, 340], liveResize: true, pageGeom: { w: 794, h: 1123, ml: 90, mt: 90, mr: 90, mb: 90 }, pages: 1 });
    const { container } = render(<HwpWorkspace adapter={adapter} document={doc} onAiRequest={noAi} enableEditing />);
    const sheet = await sheetOf(container);
    // click the table → whole-table mark.
    fireEvent.pointerDown(sheet, { clientX: 100, clientY: 100, button: 0, pointerId: 1 });
    fireEvent.pointerUp(sheet, { clientX: 100, clientY: 100, button: 0, pointerId: 1 });
    const grip = await screen.findByTestId("hw-col-grip-1");
    const leftBefore = parseFloat((grip as HTMLElement).style.left); // rendered boundary x (client px)
    const resize = screen.getByTestId("hw-col-resize");
    // Drag the interior boundary to the RIGHT (issue 031 root cause was: this preview never moved).
    fireEvent.pointerDown(grip, { clientX: 140, clientY: 100, pointerId: 2 });
    fireEvent.pointerMove(resize, { clientX: 220, clientY: 100, pointerId: 2 });
    fireEvent.pointerUp(resize, { clientX: 220, clientY: 100, pointerId: 2 });
    await waitFor(() => {
      const applied = adapter.applied.find((i) => i.intent === "SetTableColWidths") as (Intent & { widths: number[] }) | undefined;
      expect(applied).toBeTruthy();
      expect(applied!.widths.length).toBe(3);
    });
    // apply-verify SUCCESS toast (NOT the false-success no-op): the boundary was confirmed moved.
    await waitFor(() => expect(screen.getByText("열 너비를 변경했습니다")).toBeTruthy());
    // the rendered grip actually moved right (the drag preview + re-queried geometry both reflect it).
    await waitFor(() => {
      const g = screen.getByTestId("hw-col-grip-1") as HTMLElement;
      expect(parseFloat(g.style.left)).toBeGreaterThan(leftBefore + 15);
    });
  });

  it("FROZEN engine (no geometry change) → apply-verify ERROR toast, NOT a false success (issue 031)", async () => {
    // No liveResize → tableColBoundaries stays frozen: the classic no-op that used to toast success.
    const adapter = new MockAdapter({ table, colBoundaries: [40, 140, 240, 340], pageGeom: { w: 794, h: 1123, ml: 90, mt: 90, mr: 90, mb: 90 }, pages: 1 });
    const { container } = render(<HwpWorkspace adapter={adapter} document={doc} onAiRequest={noAi} enableEditing />);
    const sheet = await sheetOf(container);
    fireEvent.pointerDown(sheet, { clientX: 100, clientY: 100, button: 0, pointerId: 1 });
    fireEvent.pointerUp(sheet, { clientX: 100, clientY: 100, button: 0, pointerId: 1 });
    const grip = await screen.findByTestId("hw-col-grip-1");
    const resize = screen.getByTestId("hw-col-resize");
    fireEvent.pointerDown(grip, { clientX: 140, clientY: 100, pointerId: 2 });
    fireEvent.pointerMove(resize, { clientX: 220, clientY: 100, pointerId: 2 });
    fireEvent.pointerUp(resize, { clientX: 220, clientY: 100, pointerId: 2 });
    // the intent IS sent (the op-bus tried), but the re-query showed no movement → HONEST error toast.
    await waitFor(() => expect(adapter.applied.some((i) => i.intent === "SetTableColWidths")).toBe(true));
    await waitFor(() => expect(screen.getByText("열 너비 변경이 반영되지 않았습니다 — 다시 시도하세요")).toBeTruthy());
    expect(screen.queryByText("열 너비를 변경했습니다")).toBeNull();
  });

  it("marking a table shows ROW-resize grips; a drag commits SetTableRowHeights (whole-table heights, issue 031)", async () => {
    const adapter = new MockAdapter({ table, rowBoundaries: [60, 100, 140, 180], liveResize: true, pageGeom: { w: 794, h: 1123, ml: 90, mt: 90, mr: 90, mb: 90 }, pages: 1 });
    const { container } = render(<HwpWorkspace adapter={adapter} document={doc} onAiRequest={noAi} enableEditing />);
    const sheet = await sheetOf(container);
    fireEvent.pointerDown(sheet, { clientX: 100, clientY: 100, button: 0, pointerId: 1 });
    fireEvent.pointerUp(sheet, { clientX: 100, clientY: 100, button: 0, pointerId: 1 });
    const grip = await screen.findByTestId("hw-row-grip-1");
    const topBefore = parseFloat((grip as HTMLElement).style.top);
    const resize = screen.getByTestId("hw-row-resize");
    // Drag the interior row boundary DOWN → row 0 grows.
    fireEvent.pointerDown(grip, { clientX: 100, clientY: 90, pointerId: 3 });
    fireEvent.pointerMove(resize, { clientX: 100, clientY: 110, pointerId: 3 });
    fireEvent.pointerUp(resize, { clientX: 100, clientY: 110, pointerId: 3 });
    await waitFor(() => {
      const applied = adapter.applied.find((i) => i.intent === "SetTableRowHeights") as (Intent & { heights: number[] }) | undefined;
      expect(applied).toBeTruthy();
      expect(applied!.heights.length).toBe(3); // WHOLE-table heights (table.rows === 3)
      expect(applied!.heights[0]).toBeGreaterThan(3000); // row 0 grew past its ~40px (3000 HWPUNIT) content
    });
    await waitFor(() => expect(screen.getByText("행 높이를 변경했습니다")).toBeTruthy());
    await waitFor(() => {
      const g = screen.getByTestId("hw-row-grip-1") as HTMLElement;
      expect(parseFloat(g.style.top)).toBeGreaterThan(topBefore); // boundary moved down
    });
  });

  it("SPLIT table: a fragment row drag remaps to a WHOLE-table heights vector, 0 outside the fragment (issue 031 v2)", async () => {
    // A split table whose on-page FRAGMENT covers GLOBAL rows 2..3 (first_row=2) of a 5-row table. The
    // fragment boundaries are page-local; the commit must build a length-5 heights vector with the dragged
    // heights at indices 2,3 and 0 (content-sized) everywhere else — the v1 fail-safe this replaces.
    const split: TableBox = { section: 0, block: 1, x: 40, y: 200, w: 300, h: 80, rows: 5, cols: 3, first_row: 2 };
    const adapter = new MockAdapter({ table: split, rowBoundaries: [200, 240, 280], liveResize: true, pageGeom: { w: 794, h: 1123, ml: 90, mt: 90, mr: 90, mb: 90 }, pages: 1 });
    const { container } = render(<HwpWorkspace adapter={adapter} document={doc} onAiRequest={noAi} enableEditing />);
    const sheet = await sheetOf(container);
    fireEvent.pointerDown(sheet, { clientX: 100, clientY: 210, button: 0, pointerId: 1 });
    fireEvent.pointerUp(sheet, { clientX: 100, clientY: 210, button: 0, pointerId: 1 });
    const grip = await screen.findByTestId("hw-row-grip-1");
    const resize = screen.getByTestId("hw-row-resize");
    fireEvent.pointerDown(grip, { clientX: 100, clientY: 216, pointerId: 3 });
    fireEvent.pointerMove(resize, { clientX: 100, clientY: 232, pointerId: 3 });
    fireEvent.pointerUp(resize, { clientX: 100, clientY: 232, pointerId: 3 });
    await waitFor(() => {
      const applied = adapter.applied.find((i) => i.intent === "SetTableRowHeights") as (Intent & { heights: number[] }) | undefined;
      expect(applied).toBeTruthy();
      expect(applied!.heights.length).toBe(5); // WHOLE table, not the 2-row fragment (v1's engine error)
      expect(applied!.heights[0]).toBe(0); // rows OUTSIDE the fragment stay content-sized
      expect(applied!.heights[1]).toBe(0);
      expect(applied!.heights[4]).toBe(0);
      expect(applied!.heights[2]).toBeGreaterThan(0); // the fragment rows carry the dragged heights
      expect(applied!.heights[3]).toBeGreaterThan(0);
    });
  });

  it("double-click a cell → IN-PLACE rich editor (over the cell rect) → Enter PRESERVES bold via SetTableCellRuns", async () => {
    // issue 032/040: the popover card is gone — the double-click opens the Figma-style contentEditable rich
    // editor over the cell rect (data-testid hw-inplace-editor); Enter serializes the DOM to RUNS and commits
    // through the run-preserving SetTableCellRuns path, so per-run formatting survives (교훈 6).
    const cell: CellHit = { section: 0, block: 1, row: 0, col: 0, rows: 3, cols: 3, text: "굵게", x: 40, y: 60, w: 100, h: 40 };
    const adapter = new MockAdapter({ table, cell, runs: [{ text: "굵게", bold: true }], pages: 1 });
    const { container } = render(<HwpWorkspace adapter={adapter} document={doc} onAiRequest={noAi} enableEditing />);
    const sheet = await sheetOf(container);
    // 06x: double-click DRILLS to the cell, then Enter opens the in-place editor (openCellEditorAt).
    await openCellEditorAt(sheet, container, 60, 80);
    const ta = (await screen.findByTestId("hw-inplace-editor")) as HTMLElement;
    // The editor sits EXACTLY over the cell rect (page px × scale). The default zoom is 0.9, so scale = 0.9:
    // left/top/width = cell box × 0.9 — entering edit mode does not move/resize the cell (issue 032 <4px).
    expect(ta.style.left).toBe("36px"); // 40 × 0.9
    expect(ta.style.top).toBe("54px"); // 60 × 0.9
    expect(ta.style.width).toBe("90px"); // 100 × 0.9
    expect(ta.getAttribute("contenteditable")).toBe("true");
    // Edit the text WITHIN the bold span (the browser keeps the span when typing into the selection) → the
    // bold formatting is PRESERVED (the whole point of the rich editor — no flatten to plain text).
    ta.innerHTML = `<div><span style="font-weight:700">바뀐 값</span></div>`;
    fireEvent.keyDown(ta, { key: "Enter" }); // Enter=저장 (Shift+Enter would be a newline)
    await waitFor(() => {
      const applied = adapter.applied.find((i) => i.intent === "SetTableCellRuns") as (Intent & { runs: unknown[] }) | undefined;
      expect(applied).toBeTruthy();
      expect(applied!.runs).toEqual([{ text: "바뀐 값", bold: true }]); // bold PRESERVED through the rich round-trip
    });
  });

  it("no-op: opening a cell and committing WITHOUT an edit applies NO intent (미접촉 셀 재커밋 = no-op, 교훈 1)", async () => {
    // issue 040 #000 규율: an untouched cell round-trips to the SAME runs, so the commit is a no-op — no
    // SetTableCellRuns write, no undo unit (opening a bold cell and clicking away must not pin a spurious run).
    const cell: CellHit = { section: 0, block: 1, row: 0, col: 0, rows: 3, cols: 3, text: "굵게", x: 40, y: 60, w: 100, h: 40 };
    const adapter = new MockAdapter({ table, cell, runs: [{ text: "굵게", bold: true }], pages: 1 });
    const { container } = render(<HwpWorkspace adapter={adapter} document={doc} onAiRequest={noAi} enableEditing />);
    const sheet = await sheetOf(container);
    await openCellEditorAt(sheet, container, 60, 80);
    const ta = await screen.findByTestId("hw-inplace-editor");
    fireEvent.keyDown(ta, { key: "Enter" }); // commit WITHOUT touching anything
    await waitFor(() => expect(screen.queryByTestId("hw-inplace-editor")).toBeNull()); // editor closed
    expect(adapter.applied.some((i) => i.intent === "SetTableCellRuns")).toBe(false); // no write emitted
  });

  it("PARTIAL edit: only the plain part changes; a bold run stays byte-unchanged (issue 040 run 보존)", async () => {
    // A cell whose runs are [보통][굵게 bold]. Editing the plain leading run must leave the bold run's bytes
    // intact — the whole point of the rich editor (per-run preservation, not a whole-cell flatten).
    const cell: CellHit = { section: 0, block: 1, row: 0, col: 0, rows: 3, cols: 3, text: "보통굵게", x: 40, y: 60, w: 100, h: 40 };
    const adapter = new MockAdapter({ table, cell, runs: [{ text: "보통" }, { text: "굵게", bold: true }], pages: 1 });
    const { container } = render(<HwpWorkspace adapter={adapter} document={doc} onAiRequest={noAi} enableEditing />);
    const sheet = await sheetOf(container);
    await openCellEditorAt(sheet, container, 60, 80);
    const ta = (await screen.findByTestId("hw-inplace-editor")) as HTMLElement;
    // Change ONLY the plain run's text (the bold span is left exactly as it was).
    ta.innerHTML = `<div><span>새로운</span><span style="font-weight:700">굵게</span></div>`;
    fireEvent.keyDown(ta, { key: "Enter" });
    await waitFor(() => {
      const applied = adapter.applied.find((i) => i.intent === "SetTableCellRuns") as (Intent & { runs: unknown[] }) | undefined;
      expect(applied).toBeTruthy();
      expect(applied!.runs).toEqual([{ text: "새로운" }, { text: "굵게", bold: true }]); // bold run untouched
    });
  });

  it("while the in-place editor is open, the 028 floating toolbar is HIDDEN (two chromes must not fight)", async () => {
    const cell: CellHit = { section: 0, block: 1, row: 1, col: 1, rows: 3, cols: 3, text: "칸", x: 140, y: 100, w: 100, h: 40 };
    const adapter = new MockAdapter({ table, cell, runs: [{ text: "칸" }], colBoundaries: [40, 140, 240, 340], pages: 1 });
    const { container } = render(<HwpWorkspace adapter={adapter} document={doc} onAiRequest={noAi} enableEditing />);
    const sheet = await sheetOf(container);
    // 06x drill: a double-click SELECTS the cell → the floating toolbar appears.
    drillCell(sheet, 160, 110);
    await screen.findByTestId("hw-floating-toolbar");
    // Now open the editor (Enter over the drilled cell) → the toolbar must disappear.
    fireEvent.keyDown(window, { key: "Enter" });
    await screen.findByTestId("hw-inplace-editor");
    await waitFor(() => expect(screen.queryByTestId("hw-floating-toolbar")).toBeNull());
  });

  it("marking a cell shows the FLOATING toolbar; 굵게 applies SetCellRangeFmt", async () => {
    const cell: CellHit = { section: 0, block: 1, row: 1, col: 1, rows: 3, cols: 3, text: "칸", x: 140, y: 100, w: 100, h: 40 };
    const adapter = new MockAdapter({ table, cell, runs: [{ text: "칸" }], colBoundaries: [40, 140, 240, 340], pages: 1 });
    const { container } = render(<HwpWorkspace adapter={adapter} document={doc} onAiRequest={noAi} enableEditing />);
    const sheet = await sheetOf(container);
    drillCell(sheet, 160, 110); // 06x: drill to select the cell (single click would mark the whole table)
    // the new capsule toolbar carries the same control testids (issue 028 surface redesign).
    await screen.findByTestId("hw-floating-toolbar");
    const bold = await screen.findByTestId("hw-fmt-bold");
    fireEvent.click(bold);
    await waitFor(() => {
      const applied = adapter.applied.find((i) => i.intent === "SetCellRangeFmt") as (Intent & { bold: unknown; r0: number }) | undefined;
      expect(applied).toBeTruthy();
      expect(applied!.bold).toBe(true);
      expect(applied!.r0).toBe(1); // the clicked cell's row
    });
  });
});

describe("HwpWorkspace issue-028 — floating toolbar show/hide + AI entry", () => {
  const cell: CellHit = { section: 0, block: 1, row: 1, col: 1, rows: 3, cols: 3, text: "칸", x: 140, y: 100, w: 100, h: 40 };
  const mkAdapter = () => new MockAdapter({ table, cell, runs: [{ text: "칸" }], colBoundaries: [40, 140, 240, 340], pages: 1 });

  it("선택→표시, Esc→숨김", async () => {
    const { container } = render(<HwpWorkspace adapter={mkAdapter()} document={doc} onAiRequest={noAi} enableEditing />);
    const sheet = await sheetOf(container);
    fireEvent.pointerDown(sheet, { clientX: 160, clientY: 110, button: 0, pointerId: 1 });
    fireEvent.pointerUp(sheet, { clientX: 160, clientY: 110, button: 0, pointerId: 1 });
    await screen.findByTestId("hw-floating-toolbar");
    // Esc clears the selection → toolbar disappears.
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("hw-floating-toolbar")).toBeNull());
  });

  it("드래그(포인터 제스처) 중 숨김 → 놓으면 재등장", async () => {
    const { container } = render(<HwpWorkspace adapter={mkAdapter()} document={doc} onAiRequest={noAi} enableEditing />);
    const sheet = await sheetOf(container);
    fireEvent.pointerDown(sheet, { clientX: 160, clientY: 110, button: 0, pointerId: 1 });
    fireEvent.pointerUp(sheet, { clientX: 160, clientY: 110, button: 0, pointerId: 1 });
    await screen.findByTestId("hw-floating-toolbar");
    // a new gesture begins → the toolbar hides while dragging…
    fireEvent.pointerDown(sheet, { clientX: 160, clientY: 110, button: 0, pointerId: 2 });
    await waitFor(() => expect(screen.queryByTestId("hw-floating-toolbar")).toBeNull());
    // …and re-appears once the gesture settles.
    fireEvent.pointerUp(sheet, { clientX: 160, clientY: 110, button: 0, pointerId: 2 });
    await screen.findByTestId("hw-floating-toolbar");
  });

  it("AI에게 전달 → 채팅 포커스 + 앵커 칩 유지 (신규 프롬프트 로직 0)", async () => {
    const { container } = render(<HwpWorkspace adapter={mkAdapter()} document={doc} onAiRequest={noAi} enableEditing />);
    const sheet = await sheetOf(container);
    fireEvent.pointerDown(sheet, { clientX: 160, clientY: 110, button: 0, pointerId: 1 });
    fireEvent.pointerUp(sheet, { clientX: 160, clientY: 110, button: 0, pointerId: 1 });
    await screen.findByTestId("hw-floating-toolbar");
    // the marked cell is already an anchor chip.
    await waitFor(() => expect(container.querySelector(".hw-anchor")).toBeTruthy());
    fireEvent.click(screen.getByTestId("hw-fmt-ai"));
    const ta = container.querySelector(".hw-textarea") as HTMLTextAreaElement;
    await waitFor(() => expect(document.activeElement).toBe(ta));
    // the chip is NOT consumed — it rides along with the next message.
    expect(container.querySelector(".hw-anchor")).toBeTruthy();
  });
});
