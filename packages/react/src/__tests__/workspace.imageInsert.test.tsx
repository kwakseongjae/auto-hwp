import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { HwpWorkspace } from "../components/HwpWorkspace";
import { imageInsertSize } from "@auto-hwp/editor-core";
import type { BlockHit, Intent, TableBox } from "../types";
import { MockAdapter } from "./mockAdapter";

// jsdom does no layout — stub getBoundingClientRect to a full A4 box so coords.ts maps the drop point to
// page px (mirrors workspace.editing.test.tsx). Also stub `Image` (jsdom never fires onload) so the
// natural-dimension read in `readImageFile` resolves with a fixed 1000×500 (a 2:1 image).
const origRect = Element.prototype.getBoundingClientRect;
const origImage = globalThis.Image;
class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  naturalWidth = 1000;
  naturalHeight = 500;
  set src(_v: string) {
    queueMicrotask(() => this.onload?.());
  }
}
beforeAll(() => {
  Element.prototype.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: 794, bottom: 1123, width: 794, height: 1123, x: 0, y: 0, toJSON() {} }) as DOMRect;
  (globalThis as { Image: unknown }).Image = FakeImage as unknown as typeof Image;
  // jsdom has no `document.elementFromPoint` — define it (default: a miss) so the drop resolver can be
  // spied per-test to point at the sheet under the cursor.
  if (typeof document.elementFromPoint !== "function") {
    (document as unknown as { elementFromPoint: () => Element | null }).elementFromPoint = () => null;
  }
});
afterAll(() => {
  Element.prototype.getBoundingClientRect = origRect;
  (globalThis as { Image: unknown }).Image = origImage;
});
afterEach(() => {
  vi.restoreAllMocks();
});

const noAi = async () => [] as Intent[];
const doc = { bytes: new Uint8Array([1]), name: "t.hwpx" };
const PNG_SIG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3]);
const pngFile = () => new File([PNG_SIG], "pic.png", { type: "image/png" });
// The size the UI derives for a 1000×500 image at the default display width (120mm): 2:1 → 120×60mm.
const EXPECT_SIZE = imageInsertSize(1000, 500);

async function sheetOf(container: HTMLElement): Promise<HTMLElement> {
  return waitFor(() => {
    const el = container.querySelector('.hw-sheet[data-page="0"]');
    expect(el?.querySelector("svg")).toBeTruthy();
    return el as HTMLElement;
  });
}

function insertIntents(adapter: MockAdapter): (Intent & { block: number | null; data_b64: string; width: number; height: number })[] {
  return adapter.applied.filter((i) => i.intent === "InsertImage") as never;
}

describe("HwpWorkspace image insert (issue 050) — upload button", () => {
  it("shows the 이미지 button only under enableEditing", async () => {
    const plain = new MockAdapter({ pages: 1 });
    const { container, rerender } = render(<HwpWorkspace adapter={plain} document={doc} onAiRequest={noAi} />);
    await sheetOf(container);
    expect(screen.queryByTestId("hw-image-input")).toBeNull();
    rerender(<HwpWorkspace adapter={plain} document={doc} onAiRequest={noAi} enableEditing />);
    await waitFor(() => expect(screen.getByTestId("hw-image-input")).toBeTruthy());
  });

  it("upload with NO selection inserts InsertImage at the section end (block:null), sized from the image aspect", async () => {
    const adapter = new MockAdapter({ pages: 1 });
    const { container } = render(<HwpWorkspace adapter={adapter} document={doc} onAiRequest={noAi} enableEditing />);
    await sheetOf(container);

    fireEvent.change(screen.getByTestId("hw-image-input"), { target: { files: [pngFile()] } });
    await waitFor(() => expect(insertIntents(adapter)).toHaveLength(1));
    const ins = insertIntents(adapter)[0];
    expect(ins).toMatchObject({ intent: "InsertImage", section: 0, block: null, width: EXPECT_SIZE.width, height: EXPECT_SIZE.height });
    expect(ins.data_b64.length).toBeGreaterThan(0); // the base64 payload actually rode through (bytes → model)

    // undo is ONE unit (the toolbar ↶ button reverts the insert).
    fireEvent.click(screen.getByTitle("실행취소"));
    await waitFor(() => expect(adapter.undos).toBe(1));
  });

  it("upload WITH a selected block inserts AFTER that block (현재 선택 앵커)", async () => {
    // Select a TABLE (block 1) — a table click reliably yields a block-addressed selection anchor.
    const table: TableBox = { section: 0, block: 1, x: 40, y: 60, w: 300, h: 120, rows: 3, cols: 3, first_row: 0 };
    const adapter = new MockAdapter({ pages: 1, table });
    const { container } = render(<HwpWorkspace adapter={adapter} document={doc} onAiRequest={noAi} enableEditing />);
    const sheet = await sheetOf(container);
    fireEvent.pointerDown(sheet, { clientX: 100, clientY: 100, button: 0, pointerId: 1 });
    fireEvent.pointerUp(sheet, { clientX: 100, clientY: 100, button: 0, pointerId: 1 });
    await waitFor(() => expect(container.querySelector(".hw-mark")).toBeTruthy()); // the table mark is drawn

    fireEvent.change(screen.getByTestId("hw-image-input"), { target: { files: [pngFile()] } });
    await waitFor(() => expect(insertIntents(adapter)).toHaveLength(1));
    expect(insertIntents(adapter)[0]).toMatchObject({ intent: "InsertImage", section: 0, block: 1 });
  });
});

describe("HwpWorkspace image insert (issue 050) — drop zone branch rules", () => {
  it("dropping an IMAGE on a page inserts it AFTER the pointed block (drop→hitTest anchor)", async () => {
    const hit: BlockHit = { section: 0, block: 3, kind: "paragraph", x: 0, y: 0, w: 794, h: 100, text: "", editable: true };
    const adapter = new MockAdapter({ pages: 1, hit });
    const { container } = render(<HwpWorkspace adapter={adapter} document={doc} onAiRequest={noAi} enableEditing />);
    const sheet = await sheetOf(container);
    const canvas = container.querySelector(".hw-canvas") as HTMLElement;
    // jsdom has no hit-testing — point the drop resolver at the sheet under the cursor.
    vi.spyOn(document, "elementFromPoint").mockReturnValue(sheet);

    fireEvent.drop(canvas, { clientX: 120, clientY: 200, dataTransfer: { files: [pngFile()], types: ["Files"] } });
    await waitFor(() => expect(insertIntents(adapter)).toHaveLength(1));
    expect(insertIntents(adapter)[0]).toMatchObject({ intent: "InsertImage", section: 0, block: 3, width: EXPECT_SIZE.width, height: EXPECT_SIZE.height });
  });

  it("dropping a .hwpx DOCUMENT forwards it to onOpenFile (문서=열기), NEVER InsertImage", async () => {
    const adapter = new MockAdapter({ pages: 1 });
    const onOpenFile = vi.fn();
    const { container } = render(
      <HwpWorkspace adapter={adapter} document={doc} onAiRequest={noAi} enableEditing onOpenFile={onOpenFile} />,
    );
    const canvas = container.querySelector(".hw-canvas") as HTMLElement;
    const hwpx = new File([new Uint8Array([0x50, 0x4b, 3, 4])], "report.hwpx");

    fireEvent.drop(canvas, { clientX: 120, clientY: 200, dataTransfer: { files: [hwpx], types: ["Files"] } });
    await waitFor(() => expect(onOpenFile).toHaveBeenCalledTimes(1));
    expect(onOpenFile.mock.calls[0][1]).toBe("report.hwpx"); // (bytes, name)
    expect(insertIntents(adapter)).toHaveLength(0); // a document drop is an OPEN, not an image insert
  });

  it("dropping a NON-image, NON-document file is refused honestly (no InsertImage, no crash)", async () => {
    const adapter = new MockAdapter({ pages: 1 });
    const { container } = render(<HwpWorkspace adapter={adapter} document={doc} onAiRequest={noAi} enableEditing />);
    const canvas = container.querySelector(".hw-canvas") as HTMLElement;
    const txt = new File([new Uint8Array([1, 2, 3])], "notes.txt", { type: "text/plain" });

    fireEvent.drop(canvas, { clientX: 120, clientY: 200, dataTransfer: { files: [txt], types: ["Files"] } });
    await waitFor(() => expect(screen.getByText(/PNG.*JPEG.*또는.*hwp/)).toBeTruthy());
    expect(insertIntents(adapter)).toHaveLength(0);
  });

  it("dropping a .hwp with NO onOpenFile shows honest guidance (not a silent no-op), no InsertImage", async () => {
    const adapter = new MockAdapter({ pages: 1 });
    const { container } = render(<HwpWorkspace adapter={adapter} document={doc} onAiRequest={noAi} enableEditing />);
    const canvas = container.querySelector(".hw-canvas") as HTMLElement;
    const hwp = new File([new Uint8Array([1, 2, 3])], "old.hwp");

    fireEvent.drop(canvas, { clientX: 120, clientY: 200, dataTransfer: { files: [hwp], types: ["Files"] } });
    await waitFor(() => expect(screen.getByText(/문서 열기는 상단/)).toBeTruthy());
    expect(insertIntents(adapter)).toHaveLength(0);
  });
});
