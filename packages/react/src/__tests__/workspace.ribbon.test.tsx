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
  // jsdom has no document.execCommand — install a no-op stub so the live-style path (applyLiveStyle) can run
  // and tests can spy/mock it. restoreAllMocks (afterEach) restores to THIS stub.
  if (typeof document.execCommand !== "function") (document as { execCommand?: unknown }).execCommand = () => false;
});
afterAll(() => {
  Element.prototype.getBoundingClientRect = origRect;
});
afterEach(() => vi.restoreAllMocks());

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

/** Figma drill (issue 06x): a single click marks the whole table, so SELECTING the cell (140..240 ×
 *  100..140 page px) = a DOUBLE-click (drill). Two synchronous ups within the 400ms window. */
function clickCell(sheet: HTMLElement) {
  fireEvent.pointerDown(sheet, { clientX: 160, clientY: 110, button: 0, pointerId: 1 });
  fireEvent.pointerUp(sheet, { clientX: 160, clientY: 110, button: 0, pointerId: 1 });
  fireEvent.pointerDown(sheet, { clientX: 160, clientY: 110, button: 0, pointerId: 1 });
  fireEvent.pointerUp(sheet, { clientX: 160, clientY: 110, button: 0, pointerId: 1 });
}
/** Open the in-place editor over the cell: drill to select it, wait for the drill to settle, then Enter
 *  (issue 036) — the robust editing entry over a drilled cell (a 2nd double-click would race the drill). */
async function dblClickCell(sheet: HTMLElement, container: HTMLElement) {
  clickCell(sheet);
  await waitFor(() => expect(container.querySelector(".hw-anchor")?.textContent ?? "").toMatch(/행/));
  fireEvent.keyDown(window, { key: "Enter" });
}

describe("HwpWorkspace issue-048 — persistent format ribbon (선택+편집 겸용)", () => {
  it("is part of the editing chrome only: no ribbon without enableEditing", async () => {
    const adapter = new MockAdapter({ table, cell, runs: [{ text: "칸" }], colBoundaries: [40, 140, 240, 340], pages: 1 });
    const { container } = render(<HwpWorkspace adapter={adapter} document={doc} onAiRequest={noAi} />);
    await sheetOf(container);
    expect(screen.queryByTestId("hw-format-ribbon")).toBeNull();
  });

  it("비편집 + 셀 선택 → 리본 굵게가 SetCellRangeFmt 를 적용 (028 툴바와 동일 op)", async () => {
    const adapter = new MockAdapter({ table, cell, runs: [{ text: "칸" }], colBoundaries: [40, 140, 240, 340], pages: 1 });
    const { container } = render(<HwpWorkspace adapter={adapter} document={doc} onAiRequest={noAi} enableEditing />);
    const sheet = await sheetOf(container);
    // the ribbon is persistent (present as soon as a doc is open in the editing chrome).
    expect(screen.getByTestId("hw-format-ribbon")).toBeTruthy();
    clickCell(sheet);
    await waitFor(() => expect((screen.getByTestId("hw-ribbon-bold") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId("hw-ribbon-bold"));
    await waitFor(() => {
      const applied = adapter.applied.find((i) => i.intent === "SetCellRangeFmt") as (Intent & { bold: unknown; r0: number }) | undefined;
      expect(applied).toBeTruthy();
      expect(applied!.bold).toBe(true);
      expect(applied!.r0).toBe(1); // the clicked cell's row
    });
  });

  it("리본과 028 플로팅 툴바가 같은 op 을 낸다 (공용 유틸 하나 — useSelectionActions)", async () => {
    const adapter = new MockAdapter({ table, cell, runs: [{ text: "칸" }], colBoundaries: [40, 140, 240, 340], pages: 1 });
    const { container } = render(<HwpWorkspace adapter={adapter} document={doc} onAiRequest={noAi} enableEditing />);
    const sheet = await sheetOf(container);
    clickCell(sheet);
    // both chromes are present over a selection (피그마식 이중), no visual conflict (ribbon in header, bar floats).
    await screen.findByTestId("hw-floating-toolbar");
    expect(screen.getByTestId("hw-format-ribbon")).toBeTruthy();
    // the FLOATING toolbar's 굵게 → SetCellRangeFmt (same op the ribbon just proved).
    fireEvent.click(screen.getByTestId("hw-fmt-bold"));
    await waitFor(() => expect(adapter.applied.some((i) => i.intent === "SetCellRangeFmt")).toBe(true));
  });

  it("편집 중: 리본 굵게는 applyLiveStyle(execCommand) 로 라이브 선택만 스타일 — SetCellRange* 미커밋 (latch 무접촉), 에디터 유지", async () => {
    const adapter = new MockAdapter({ table, cell, runs: [{ text: "칸" }], colBoundaries: [40, 140, 240, 340], pages: 1 });
    const exec = vi.spyOn(document, "execCommand").mockReturnValue(true); // jsdom lacks execCommand
    const { container } = render(<HwpWorkspace adapter={adapter} document={doc} onAiRequest={noAi} enableEditing />);
    const sheet = await sheetOf(container);
    await dblClickCell(sheet, container);
    await screen.findByTestId("hw-inplace-editor");
    // while editing, 밑줄/취소선 become enabled (live-run styles) and 배경/정렬 disable (cell ops).
    await waitFor(() => expect((screen.getByTestId("hw-ribbon-underline") as HTMLButtonElement).disabled).toBe(false));
    expect((screen.getByTestId("hw-ribbon-shade") as HTMLInputElement).disabled).toBe(true);
    exec.mockClear();
    fireEvent.click(screen.getByTestId("hw-ribbon-bold"));
    // it styled the LIVE selection (execCommand "bold"), NOT a cell-range op — and the editor stays open.
    expect(exec.mock.calls.some((c) => c[0] === "bold")).toBe(true);
    expect(adapter.applied.some((i) => i.intent === "SetCellRangeFmt")).toBe(false);
    expect(adapter.applied.some((i) => i.intent === "SetTableCellRuns")).toBe(false);
    expect(screen.getByTestId("hw-inplace-editor")).toBeTruthy();
  });

  it("편집 중 부분 선택 굵게 → 커밋 시 부분 run 보존 (SetTableCellRuns, run 보존)", async () => {
    // Polyfill execCommand("bold") to wrap the live selection in a bold span (what a real browser does), so the
    // ribbon → applyLiveStyle → execCommand → serialize → SetTableCellRuns path is exercised end-to-end.
    vi.spyOn(document, "execCommand").mockImplementation(((cmd: string) => {
      if (cmd !== "bold") return true; // styleWithCSS etc — no-op
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return false;
      const range = sel.getRangeAt(0);
      if (range.collapsed) return false;
      const span = document.createElement("span");
      span.style.fontWeight = "700";
      try {
        span.appendChild(range.extractContents());
        range.insertNode(span);
      } catch {
        return false;
      }
      sel.removeAllRanges();
      const r = document.createRange();
      r.selectNodeContents(span);
      sel.addRange(r);
      return true;
    }) as typeof document.execCommand);
    const midCell: CellHit = { ...cell, text: "가나다" };
    const adapter = new MockAdapter({ table, cell: midCell, runs: [{ text: "가나다" }], colBoundaries: [40, 140, 240, 340], pages: 1 });
    const { container } = render(<HwpWorkspace adapter={adapter} document={doc} onAiRequest={noAi} enableEditing />);
    const sheet = await sheetOf(container);
    await dblClickCell(sheet, container);
    const editorEl = (await screen.findByTestId("hw-inplace-editor")) as HTMLElement;
    // Select ONLY the middle glyph "나" (offset 1..2 of the rendered run's text node).
    const textNode = editorEl.querySelector("span")!.firstChild as Text;
    const range = document.createRange();
    range.setStart(textNode, 1);
    range.setEnd(textNode, 2);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
    // Ribbon 굵게 → applyLiveStyle wraps "나" in bold; Enter commits the serialized runs.
    fireEvent.click(screen.getByTestId("hw-ribbon-bold"));
    fireEvent.keyDown(editorEl, { key: "Enter" });
    await waitFor(() => {
      const applied = adapter.applied.find((i) => i.intent === "SetTableCellRuns") as (Intent & { runs: { text: string; bold?: boolean }[] }) | undefined;
      expect(applied).toBeTruthy();
      expect(applied!.runs.map((r) => r.text)).toEqual(["가", "나", "다"]);
      expect(applied!.runs.map((r) => !!r.bold)).toEqual([false, true, false]); // ONLY the selected glyph bold
    });
  });

  it("토글 상태 반영: 선택한 셀이 굵게면 리본 굵게가 눌린 상태 (028 curBold 재사용)", async () => {
    const boldCell: CellHit = { ...cell, text: "굵게" };
    const adapter = new MockAdapter({ table, cell: boldCell, runs: [{ text: "굵게", bold: true }], colBoundaries: [40, 140, 240, 340], pages: 1 });
    const { container } = render(<HwpWorkspace adapter={adapter} document={doc} onAiRequest={noAi} enableEditing />);
    const sheet = await sheetOf(container);
    clickCell(sheet);
    await waitFor(() => expect(screen.getByTestId("hw-ribbon-bold").getAttribute("aria-pressed")).toBe("true"));
  });

  it("비편집: 밑줄/취소선은 편집 상태에서만 활성(사유), 배경/정렬은 선택 셀에 활성", async () => {
    const adapter = new MockAdapter({ table, cell, runs: [{ text: "칸" }], colBoundaries: [40, 140, 240, 340], pages: 1 });
    const { container } = render(<HwpWorkspace adapter={adapter} document={doc} onAiRequest={noAi} enableEditing />);
    const sheet = await sheetOf(container);
    clickCell(sheet);
    await waitFor(() => expect((screen.getByTestId("hw-ribbon-bold") as HTMLButtonElement).disabled).toBe(false));
    const underline = screen.getByTestId("hw-ribbon-underline") as HTMLButtonElement;
    expect(underline.disabled).toBe(true);
    expect(underline.getAttribute("title")).toContain("편집");
    // 배경/정렬 are cell ops → enabled for the marked cell (no reason).
    expect((screen.getByTestId("hw-ribbon-shade") as HTMLInputElement).disabled).toBe(false);
    expect((screen.getByTestId("hw-ribbon-align-center") as HTMLButtonElement).disabled).toBe(false);
  });

  it("편집 중엔 028 플로팅 툴바는 숨고 리본은 유지 (두 크롬 시각 충돌 없음)", async () => {
    const adapter = new MockAdapter({ table, cell, runs: [{ text: "칸" }], colBoundaries: [40, 140, 240, 340], pages: 1 });
    vi.spyOn(document, "execCommand").mockReturnValue(true);
    const { container } = render(<HwpWorkspace adapter={adapter} document={doc} onAiRequest={noAi} enableEditing />);
    const sheet = await sheetOf(container);
    clickCell(sheet);
    await screen.findByTestId("hw-floating-toolbar");
    await dblClickCell(sheet, container);
    await screen.findByTestId("hw-inplace-editor");
    // the floating capsule hides (two chromes must not fight), but the persistent ribbon stays up.
    await waitFor(() => expect(screen.queryByTestId("hw-floating-toolbar")).toBeNull());
    expect(screen.getByTestId("hw-format-ribbon")).toBeTruthy();
  });
});
