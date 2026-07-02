import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HwpWorkspace } from "../components/HwpWorkspace";
import type { Intent } from "../types";
import { MockAdapter } from "./mockAdapter";

// jsdom does no layout, so getBoundingClientRect returns zeros → clicks can't map to page px. Stub it
// to a full A4 box so the coordinate math (coords.ts) resolves a real page point in tests.
const origRect = Element.prototype.getBoundingClientRect;
beforeAll(() => {
  Element.prototype.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: 794, bottom: 1123, width: 794, height: 1123, x: 0, y: 0, toJSON() {} }) as DOMRect;
});
afterAll(() => {
  Element.prototype.getBoundingClientRect = origRect;
});

// End-to-end mock flow (issue 016 acceptance): open → mark a table (click) → anchor chip appears →
// prompt → mock onAiRequest returns a SetTableCell Intent → preview card → 적용 → adapter.applyIntent
// receives that Intent. No wasm, no LLM.
describe("HwpWorkspace mock flow", () => {
  it("open → mark → prompt → mock AI → preview → apply", async () => {
    const table = { section: 0, block: 1, x: 40, y: 60, w: 300, h: 120, rows: 3, cols: 2, first_row: 0 };
    const adapter = new MockAdapter({ table, pages: 1 });

    // The host AI bridge: deterministic canned Intent for the demo (no LLM).
    const cannedIntent: Intent = { intent: "SetTableCell", section: 0, index: 1, row: 0, col: 0, text: "채워진 값" };
    const onAiRequest = async () => [cannedIntent];

    const { container } = render(
      <HwpWorkspace adapter={adapter} document={{ bytes: new Uint8Array([1]), name: "t.hwpx" }} onAiRequest={onAiRequest} isMock />,
    );

    // Page renders.
    const sheet = await waitFor(() => {
      const el = container.querySelector('.hw-sheet[data-page="0"]');
      expect(el?.querySelector("svg")).toBeTruthy();
      return el as HTMLElement;
    });

    // Press-release the page (no movement → a click) → tableAt hit → mark + anchor chip (replace model).
    fireEvent.pointerDown(sheet, { clientX: 100, clientY: 100, button: 0, pointerId: 1 });
    fireEvent.pointerUp(sheet, { clientX: 100, clientY: 100, button: 0, pointerId: 1 });
    await waitFor(() => {
      expect(container.querySelector(".hw-mark")).toBeTruthy();
      expect(container.querySelector(".hw-anchor")).toBeTruthy();
    });

    // Type a prompt and send.
    const textarea = container.querySelector(".hw-textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "이 표 첫 칸을 채워줘" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    // Preview card appears, then apply.
    const applyBtn = await screen.findByText("✓ 적용");
    fireEvent.click(applyBtn);

    await waitFor(() => {
      expect(adapter.applied).toHaveLength(1);
      expect(adapter.applied[0]).toEqual(cannedIntent);
      expect(screen.getByText("✓ 적용됨")).toBeTruthy();
    });

    // Anchors were consumed on send.
    expect(container.querySelector(".hw-anchor")).toBeNull();
  });

  it("undo replays the applied batch through the adapter", async () => {
    const adapter = new MockAdapter({ hit: { section: 0, block: 2, kind: "paragraph", x: 10, y: 10, w: 100, h: 20, text: "결론", editable: true }, pages: 1 });
    const onAiRequest = async () => [
      { intent: "SetParagraphText", section: 0, block: 2, text: "새 문단" } as Intent,
      { intent: "SetParagraphText", section: 0, block: 3, text: "또 하나" } as Intent,
    ];
    const { container } = render(
      <HwpWorkspace adapter={adapter} document={{ bytes: new Uint8Array([1]), name: "t.hwpx" }} onAiRequest={onAiRequest} />,
    );
    await waitFor(() => expect(container.querySelector(".hw-sheet svg")).toBeTruthy());
    const textarea = container.querySelector(".hw-textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "두 문단 바꿔줘" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    fireEvent.click(await screen.findByText("✓ 적용"));
    await waitFor(() => expect(adapter.applied).toHaveLength(2));

    // Undo the whole 2-op batch → adapter.undo() called twice.
    fireEvent.click(container.querySelector('button[title="실행취소"]') as HTMLButtonElement);
    await waitFor(() => expect(adapter.undos).toBe(2));
  });
});
