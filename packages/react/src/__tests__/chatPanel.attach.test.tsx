import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChatPanel } from "../components/ChatPanel";
import type { AiRequestOptions, Anchor, DocContext, Intent } from "../types";

// Multimodal chat input — the 📎 picker/paste path adds attachment CHIPS, and send() forwards them via the
// additive `opts.attachments` (the inline-edit surface omits it, so OnAiRequest stays 3-arg compatible).
const docContext: DocContext = { format: "hwpx", editable: true, sections: 1, pages: 1, anchors: [] };

function renderPanel(onAiRequest: (i: string, a: Anchor[], c: DocContext, o?: AiRequestOptions) => Promise<Intent[]>) {
  return render(
    <ChatPanel
      canEdit
      anchors={[]}
      onRemoveAnchor={() => {}}
      onConsumeAnchors={() => {}}
      onAiRequest={onAiRequest}
      docContext={docContext}
      onApply={async () => 1}
    />,
  );
}

// A tiny 1x1 PNG (bytes → base64 dataUrl via jsdom FileReader).
const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]);

describe("ChatPanel — multimodal attachments", () => {
  it("picking an IMAGE shows a chip and send() forwards it in opts.attachments (with the base64 dataUrl)", async () => {
    const seen: (AiRequestOptions | undefined)[] = [];
    const onAiRequest = vi.fn(async (_i: string, _a: Anchor[], _c: DocContext, opts?: AiRequestOptions) => {
      seen.push(opts);
      return [{ intent: "SetTableCell", section: 0, index: 3, row: 0, col: 0, text: "x" } as Intent];
    });
    const { container } = renderPanel(onAiRequest);

    // Drive the hidden file input (the 📎 button just clicks it).
    const input = container.querySelector('[data-testid="hw-attach-input"]') as HTMLInputElement;
    const file = new File([pngBytes], "table.png", { type: "image/png" });
    fireEvent.change(input, { target: { files: [file] } });

    // A removable chip appears (image thumbnail path).
    const chip = await screen.findByTestId("hw-attachment");
    expect(chip.textContent).toContain("table.png");
    expect(chip.querySelector("img.hw-attachment-thumb")).toBeTruthy();

    // Type + send. The image rides along in opts.attachments.
    const textarea = container.querySelector(".hw-textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "이 표 사진대로 채워줘" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => expect(onAiRequest).toHaveBeenCalledTimes(1));
    const opts = seen.at(-1);
    expect(opts?.attachments).toHaveLength(1);
    expect(opts?.attachments?.[0]).toMatchObject({ kind: "image", name: "table.png", mime: "image/png" });
    expect(opts?.attachments?.[0].dataUrl).toMatch(/^data:image\/png;base64,/);
    // UI-only fields are stripped before the wire (note/size never sent).
    expect(opts?.attachments?.[0]).not.toHaveProperty("note");
    expect(opts?.attachments?.[0]).not.toHaveProperty("size");

    // Chips are cleared after sending.
    await waitFor(() => expect(screen.queryByTestId("hw-attachment")).toBeNull());
  });

  it("an UNSUPPORTED binary DOC (e.g. .pdf) shows a '미지원' chip and is NOT forwarded", async () => {
    const seen: (AiRequestOptions | undefined)[] = [];
    const onAiRequest = vi.fn(async (_i: string, _a: Anchor[], _c: DocContext, opts?: AiRequestOptions) => {
      seen.push(opts);
      return [{ intent: "SetParagraphText", section: 0, block: 0, text: "x" } as Intent];
    });
    const { container } = renderPanel(onAiRequest);

    const input = container.querySelector('[data-testid="hw-attach-input"]') as HTMLInputElement;
    const pdf = new File([new Uint8Array([37, 80, 68, 70])], "ref.pdf", { type: "application/pdf" });
    fireEvent.change(input, { target: { files: [pdf] } });

    const chip = await screen.findByTestId("hw-attachment");
    expect(chip.className).toContain("hw-attachment-unsupported");
    expect(chip.textContent).toContain("미지원");

    // With only an unsupported (payload-less) attachment, sending text alone forwards NO attachments.
    const textarea = container.querySelector(".hw-textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "그냥 편집해줘" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => expect(onAiRequest).toHaveBeenCalled());
    expect(seen.at(-1)?.attachments).toBeUndefined();
  });

  it("a text-like DOC (.txt) is extracted client-side and forwarded as doc text", async () => {
    const seen: (AiRequestOptions | undefined)[] = [];
    const onAiRequest = vi.fn(async (_i: string, _a: Anchor[], _c: DocContext, opts?: AiRequestOptions) => {
      seen.push(opts);
      return [{ intent: "SetParagraphText", section: 0, block: 0, text: "x" } as Intent];
    });
    const { container } = renderPanel(onAiRequest);

    const input = container.querySelector('[data-testid="hw-attach-input"]') as HTMLInputElement;
    const txt = new File(["매출 100\n비용 40"], "data.txt", { type: "text/plain" });
    fireEvent.change(input, { target: { files: [txt] } });

    await screen.findByTestId("hw-attachment");
    const textarea = container.querySelector(".hw-textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "이 내용으로 채워줘" } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => expect(onAiRequest).toHaveBeenCalled());
    const att = seen.at(-1)?.attachments;
    expect(att).toHaveLength(1);
    expect(att?.[0]).toMatchObject({ kind: "doc", name: "data.txt" });
    expect(att?.[0].text).toContain("매출 100");
  });
});
