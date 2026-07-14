import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HwpWorkspace } from "../components/HwpWorkspace";
import type { AiRequestOptions, Anchor, DocContext, Intent } from "../types";
import { MockAdapter } from "./mockAdapter";

// jsdom does no layout, so getBoundingClientRect returns zeros → clicks can't map to page px. Stub it to a
// full A4 box so the coordinate math resolves a real page point (same as the other workspace flow tests).
const origRect = Element.prototype.getBoundingClientRect;
beforeAll(() => {
  Element.prototype.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: 794, bottom: 1123, width: 794, height: 1123, x: 0, y: 0, toJSON() {} }) as DOMRect;
});
afterAll(() => {
  Element.prototype.getBoundingClientRect = origRect;
});

const paraHit = { section: 0, block: 2, kind: "paragraph", x: 10, y: 10, w: 100, h: 20, text: "결론", editable: true } as const;
const doc = { bytes: new Uint8Array([1]), name: "t.hwpx" };

async function openDoc(adapter: MockAdapter, onAiRequest: HwpWorkspaceAi) {
  const view = render(<HwpWorkspace adapter={adapter} document={doc} onAiRequest={onAiRequest} enableEditing />);
  await waitFor(() => expect(view.container.querySelector(".hw-sheet svg")).toBeTruthy());
  return view;
}
type HwpWorkspaceAi = (instruction: string, anchors: Anchor[], ctx: DocContext, opts?: AiRequestOptions) => Promise<Intent[]>;

async function sendPrompt(container: HTMLElement, text: string) {
  const textarea = container.querySelector(".hw-textarea") as HTMLTextAreaElement;
  fireEvent.change(textarea, { target: { value: text } });
  fireEvent.keyDown(textarea, { key: "Enter" });
}

// ── Feature C: persistent per-card 되돌리기 on applied chat turns ─────────────────────────────────────
describe("HwpWorkspace chat — persistent per-card 되돌리기 (Feature C)", () => {
  it("applied turn shows 되돌리기; clicking it reverts the top-of-stack batch via session.undo", async () => {
    const adapter = new MockAdapter({ hit: paraHit, pages: 1 });
    const onAiRequest: HwpWorkspaceAi = async () => [{ intent: "SetParagraphText", section: 0, block: 2, text: "새 문단" } as Intent];
    const { container } = await openDoc(adapter, onAiRequest);

    await sendPrompt(container, "이 문단 바꿔줘");
    fireEvent.click(await screen.findByText("✓ 적용"));
    await waitFor(() => expect(adapter.applied).toHaveLength(1));

    // The applied turn carries a persistent, ENABLED 되돌리기 (this batch is top-of-stack).
    const revert = await screen.findByTestId("hw-revert");
    expect((revert as HTMLButtonElement).disabled).toBe(false);
    expect(adapter.undos).toBe(0);

    // Clicking it reverts exactly this batch (session.undo → one adapter.undo for a 1-op batch).
    fireEvent.click(revert);
    await waitFor(() => {
      expect(adapter.undos).toBe(1);
      expect(screen.getByText("↩ 되돌림")).toBeTruthy();
    });
    // The button is gone once reverted (no double-revert).
    expect(screen.queryByTestId("hw-revert")).toBeNull();
  });

  it("an earlier applied turn's 되돌리기 is DISABLED once another edit piles on top (honest v1)", async () => {
    const adapter = new MockAdapter({ hit: paraHit, pages: 1 });
    const onAiRequest: HwpWorkspaceAi = async () => [{ intent: "SetParagraphText", section: 0, block: 2, text: "값" } as Intent];
    const { container } = await openDoc(adapter, onAiRequest);

    // Apply edit A.
    await sendPrompt(container, "첫 번째 편집");
    fireEvent.click(await screen.findByText("✓ 적용"));
    await waitFor(() => expect(adapter.applied).toHaveLength(1));
    // Apply edit B (piles on top of A).
    await sendPrompt(container, "두 번째 편집");
    fireEvent.click(await screen.findByText("✓ 적용"));
    await waitFor(() => expect(adapter.applied).toHaveLength(2));

    const buttons = screen.getAllByTestId("hw-revert") as HTMLButtonElement[];
    expect(buttons).toHaveLength(2);
    expect(buttons[0].disabled).toBe(true); // A is no longer top → disabled (never reverts the wrong batch)
    expect(buttons[1].disabled).toBe(false); // B is top → revertable
    expect(buttons[0].title).toContain("다른 편집이 있어");

    // Reverting B (top) makes A the top again → A becomes enabled.
    fireEvent.click(buttons[1]);
    await waitFor(() => expect(adapter.undos).toBe(1));
    await waitFor(() => {
      const only = screen.getByTestId("hw-revert") as HTMLButtonElement; // B's is gone (reverted); A's remains
      expect(only.disabled).toBe(false);
    });
  });
});

// ── Feature A: web-search grounding + citations ────────────────────────────────────────────────────
describe("HwpWorkspace chat — web-search grounding + citations (Feature A)", () => {
  it("toggling 🔎 웹 검색 sends opts.webSearch=true and renders the returned 근거 source links", async () => {
    const adapter = new MockAdapter({ hit: paraHit, pages: 1 });
    const seen: (AiRequestOptions | undefined)[] = [];
    const onAiRequest: HwpWorkspaceAi = async (_i, _a, _c, opts) => {
      seen.push(opts);
      // The host reports web-search sources through the citations sink (display-only), then returns intents.
      opts?.onCitations?.([{ url: "https://example.com/report", title: "Example 2026 Report" }]);
      return [{ intent: "SetParagraphText", section: 0, block: 2, text: "근거 반영" } as Intent];
    };
    const { container } = await openDoc(adapter, onAiRequest);

    // Turn the web-search toggle on, then send.
    const toggle = (await screen.findByTestId("hw-websearch-toggle")) as HTMLButtonElement;
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");

    await sendPrompt(container, "최신 시장 규모를 찾아서 반영해줘");

    // The 근거 list renders clickable, safe (target=_blank rel=noopener) source links.
    const cites = await screen.findByTestId("hw-citations");
    const link = cites.querySelector("a.hw-citation-link") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("https://example.com/report");
    expect(link.textContent).toContain("Example 2026 Report");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");

    // The toggle drove opts.webSearch = true for that request.
    expect(seen.at(-1)?.webSearch).toBe(true);
  });

  it("without toggling, opts.webSearch is false (no search/billing on ordinary edits)", async () => {
    const adapter = new MockAdapter({ hit: paraHit, pages: 1 });
    const seen: (AiRequestOptions | undefined)[] = [];
    const onAiRequest: HwpWorkspaceAi = async (_i, _a, _c, opts) => {
      seen.push(opts);
      return [{ intent: "SetParagraphText", section: 0, block: 2, text: "일반 편집" } as Intent];
    };
    const { container } = await openDoc(adapter, onAiRequest);
    await sendPrompt(container, "이 문단 다듬어줘");
    await screen.findByText("✓ 적용");
    expect(seen.at(-1)?.webSearch).toBe(false);
    // No citations were reported → no 근거 block.
    expect(screen.queryByTestId("hw-citations")).toBeNull();
  });
});
