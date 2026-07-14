import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HwpWorkspace } from "../components/HwpWorkspace";
import type { CellHit, FindMatch, Intent, TableBox } from "../types";
import { MockAdapter } from "./mockAdapter";

// jsdom does no layout — stub getBoundingClientRect to a full A4 box so coords/scroll geometry resolve.
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

// Three matches on node 1, page 0; a caret resolver brackets each into a box on page 0 (issue 045 geometry).
const MATCHES: FindMatch[] = [
  { node: 1, start: 0, len: 2, section: 0, block: 0 },
  { node: 1, start: 10, len: 2, section: 0, block: 0 },
  { node: 1, start: 20, len: 2, section: 0, block: 0 },
];
const caret = (page: number, _node: number, offset: number) => (page === 0 ? { x: 50 + offset * 5, top: 100, height: 12 } : null);

async function sheetOf(container: HTMLElement): Promise<HTMLElement> {
  return waitFor(() => {
    const el = container.querySelector('.hw-sheet[data-page="0"]');
    expect(el?.querySelector("svg")).toBeTruthy();
    return el as HTMLElement;
  });
}

const cmdF = () => fireEvent.keyDown(window, { key: "f", metaKey: true });

describe("HwpWorkspace 찾기/바꾸기 (issue 045)", () => {
  it("⌘F opens the bar and focuses the query field; Esc closes it", async () => {
    const adapter = new MockAdapter({ find: MATCHES, caret, pages: 1 });
    const { container } = render(<HwpWorkspace adapter={adapter} document={doc} onAiRequest={noAi} />);
    await sheetOf(container);
    expect(screen.queryByTestId("hw-find")).toBeNull();
    cmdF();
    const input = (await screen.findByTestId("hw-find-input")) as HTMLInputElement;
    await waitFor(() => expect(document.activeElement).toBe(input));
    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("hw-find")).toBeNull());
  });

  it("Enter searches → n/m count + highlight overlay; Enter/Shift+Enter cycle the current match", async () => {
    const adapter = new MockAdapter({ find: MATCHES, caret, pages: 1 });
    const { container } = render(<HwpWorkspace adapter={adapter} document={doc} onAiRequest={noAi} />);
    await sheetOf(container);
    cmdF();
    const input = (await screen.findByTestId("hw-find-input")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "가" } });
    fireEvent.keyDown(input, { key: "Enter" }); // first Enter = search
    await waitFor(() => expect(screen.getByTestId("hw-find-count").textContent).toBe("1/3"));
    // highlight overlay: 3 hits drawn, exactly one is the current (강조).
    await waitFor(() => expect(container.querySelectorAll(".hw-find-hit").length).toBe(3));
    expect(container.querySelectorAll(".hw-find-current").length).toBe(1);
    expect(adapter.finds).toEqual([{ query: "가", opts: { caseSensitive: false } }]);

    fireEvent.keyDown(input, { key: "Enter" }); // now searched → next
    await waitFor(() => expect(screen.getByTestId("hw-find-count").textContent).toBe("2/3"));
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Enter" }); // 3/3 → wrap → 1/3
    await waitFor(() => expect(screen.getByTestId("hw-find-count").textContent).toBe("1/3"));
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true }); // prev → wrap → 3/3
    await waitFor(() => expect(screen.getByTestId("hw-find-count").textContent).toBe("3/3"));
  });

  it("the ↑/↓ nav buttons step the current match", async () => {
    const adapter = new MockAdapter({ find: MATCHES, caret, pages: 1 });
    const { container } = render(<HwpWorkspace adapter={adapter} document={doc} onAiRequest={noAi} />);
    await sheetOf(container);
    cmdF();
    const input = (await screen.findByTestId("hw-find-input")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "가" } });
    fireEvent.click(screen.getByTestId("hw-find-close")); // sanity: closes then reopen path is clean
    cmdF();
    const input2 = (await screen.findByTestId("hw-find-input")) as HTMLInputElement;
    fireEvent.change(input2, { target: { value: "가" } });
    fireEvent.keyDown(input2, { key: "Enter" });
    await waitFor(() => expect(screen.getByTestId("hw-find-count").textContent).toBe("1/3"));
    fireEvent.click(screen.getByTestId("hw-find-next"));
    await waitFor(() => expect(screen.getByTestId("hw-find-count").textContent).toBe("2/3"));
    fireEvent.click(screen.getByTestId("hw-find-prev"));
    await waitFor(() => expect(screen.getByTestId("hw-find-count").textContent).toBe("1/3"));
  });

  it("a query with no matches shows 결과 없음 and no highlight", async () => {
    const adapter = new MockAdapter({ find: [], caret, pages: 1 });
    const { container } = render(<HwpWorkspace adapter={adapter} document={doc} onAiRequest={noAi} />);
    await sheetOf(container);
    cmdF();
    const input = (await screen.findByTestId("hw-find-input")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "없음" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(screen.getByTestId("hw-find-count").textContent).toBe("결과 없음"));
    expect(container.querySelectorAll(".hw-find-hit").length).toBe(0);
  });

  it("바꾸기 replaces the first match (all:false); 모두 바꾸기 replaces every match (all:true)", async () => {
    const adapter = new MockAdapter({ find: MATCHES, caret, pages: 1 });
    render(<HwpWorkspace adapter={adapter} document={doc} onAiRequest={noAi} />);
    await sheetOf(document.body as HTMLElement);
    cmdF();
    const input = (await screen.findByTestId("hw-find-input")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "가" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(screen.getByTestId("hw-find-count").textContent).toBe("1/3"));
    fireEvent.change(screen.getByTestId("hw-find-replace-input"), { target: { value: "나" } });

    fireEvent.click(screen.getByTestId("hw-find-replace-one"));
    await waitFor(() => expect(adapter.replaces.length).toBe(1));
    expect(adapter.replaces[0]).toMatchObject({ query: "가", replacement: "나", opts: { all: false } });

    fireEvent.click(screen.getByTestId("hw-find-replace-all"));
    await waitFor(() => expect(adapter.replaces.length).toBe(2));
    expect(adapter.replaces[1].opts.all).toBe(true);
    // A replace-all is recorded as one undo unit → the workspace ↶ undo reverts it via one adapter.undo.
    fireEvent.click(screen.getByTitle("실행취소"));
    await waitFor(() => expect(adapter.undos).toBeGreaterThan(0));
  });

  it("a backend WITHOUT find shows the unsupported note (count/replace disabled)", async () => {
    const adapter = new MockAdapter({ pages: 1 }); // no `find` opt → find/replace omitted
    const { container } = render(<HwpWorkspace adapter={adapter} document={doc} onAiRequest={noAi} />);
    await sheetOf(container);
    cmdF();
    await screen.findByTestId("hw-find");
    expect(screen.getByText("이 문서에서는 찾기를 사용할 수 없습니다.")).toBeTruthy();
  });

  it("a backend that can find but not locate shows count/nav but no highlight box", async () => {
    const adapter = new MockAdapter({ find: MATCHES, pages: 1 }); // no `caret` → canLocate false
    const { container } = render(<HwpWorkspace adapter={adapter} document={doc} onAiRequest={noAi} />);
    await sheetOf(container);
    cmdF();
    const input = (await screen.findByTestId("hw-find-input")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "가" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(screen.getByTestId("hw-find-count").textContent).toBe("1/3"));
    expect(container.querySelectorAll(".hw-find-hit").length).toBe(0); // no geometry → no highlight boxes
  });

  it("⌘F is IGNORED while the in-place editor is open (uncommitted edit is never discarded — 함정 decision)", async () => {
    const table: TableBox = { section: 0, block: 1, x: 40, y: 60, w: 300, h: 120, rows: 3, cols: 3, first_row: 0 };
    const cell: CellHit = { section: 0, block: 1, row: 0, col: 0, rows: 3, cols: 3, text: "값", x: 40, y: 60, w: 100, h: 40 };
    const adapter = new MockAdapter({ table, cell, runs: [{ text: "값" }], find: MATCHES, caret, pages: 1 });
    const { container } = render(<HwpWorkspace adapter={adapter} document={doc} onAiRequest={noAi} enableEditing />);
    const sheet = await sheetOf(container);
    // 06x drill: a double-click SELECTS the cell (single click marks the whole table); Enter over the
    // drilled cell then opens the in-place editor (issue 036) — robust vs the drill race.
    fireEvent.pointerDown(sheet, { clientX: 60, clientY: 80, button: 0, pointerId: 1 });
    fireEvent.pointerUp(sheet, { clientX: 60, clientY: 80, button: 0, pointerId: 1 });
    fireEvent.pointerDown(sheet, { clientX: 60, clientY: 80, button: 0, pointerId: 1 });
    fireEvent.pointerUp(sheet, { clientX: 60, clientY: 80, button: 0, pointerId: 1 });
    await waitFor(() => expect(container.querySelector(".hw-anchor")?.textContent ?? "").toMatch(/행/));
    fireEvent.keyDown(window, { key: "Enter" });
    await screen.findByTestId("hw-inplace-editor");
    cmdF();
    // The find bar must NOT open while editing (the guard); the editor stays put.
    expect(screen.queryByTestId("hw-find")).toBeNull();
    expect(screen.queryByTestId("hw-inplace-editor")).toBeTruthy();
  });
});
