import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChatPanel } from "../components/ChatPanel";
import type { AgentEvent, AiRequestOptions, Anchor, DocContext, Intent, IntentCard } from "../types";

// Agentic streaming in ChatPanel (isolated): a mocked opts.onEvent sequence renders the live thinking
// TIMELINE (status/reasoning/web-search-with-sources) ABOVE the eventual op-cards, then 적용 commits; and
// send() folds prior turns into opts.history as CONVERSATION MEMORY.
const docContext: DocContext = { format: "hwpx", editable: true, sections: 1, pages: 1, anchors: [] };

type Ai = (i: string, a: Anchor[], c: DocContext, o?: AiRequestOptions) => Promise<Intent[]>;

function renderPanel(onAiRequest: Ai, onApply = vi.fn(async () => 1)) {
  const view = render(
    <ChatPanel
      canEdit
      anchors={[]}
      onRemoveAnchor={() => {}}
      onConsumeAnchors={() => {}}
      onAiRequest={onAiRequest}
      docContext={docContext}
      onApply={onApply}
    />,
  );
  return { ...view, onApply };
}

function sendPrompt(container: HTMLElement, text: string) {
  const textarea = container.querySelector(".hw-textarea") as HTMLTextAreaElement;
  fireEvent.change(textarea, { target: { value: text } });
  fireEvent.keyDown(textarea, { key: "Enter" });
}

const paraIntent: Intent = { intent: "SetParagraphText", section: 0, block: 2, text: "근거 반영" };

describe("ChatPanel — agentic streaming timeline + apply", () => {
  it("renders the step timeline (reasoning + web-search + sources) then the op-card, and applies", async () => {
    const events: AgentEvent[] = [
      { type: "status", phase: "thinking" },
      { type: "thinking_delta", text: "시장 규모를 확인" },
      { type: "thinking_delta", text: "해야겠다." }, // accumulates onto the same reasoning step
      { type: "status", phase: "searching" },
      { type: "tool_call", tool: "web_search", args: { query: "2026 시장 규모" } },
      { type: "tool_result", tool: "web_search", citations: [{ url: "https://ex.com/a", title: "출처 A" }] },
      { type: "status", phase: "composing" },
      { type: "intents", intents: [paraIntent] },
    ];
    const onAiRequest: Ai = async (_i, _a, _c, opts) => {
      for (const ev of events) opts?.onEvent?.(ev);
      opts?.onCitations?.([{ url: "https://ex.com/a", title: "출처 A" }]);
      return [paraIntent];
    };
    const { container, onApply } = renderPanel(onAiRequest);

    sendPrompt(container, "최신 시장 규모 반영해줘");

    const timeline = await screen.findByTestId("hw-timeline");
    // Reasoning deltas accumulate into ONE step.
    expect(screen.getByTestId("hw-step-reasoning").textContent).toContain("시장 규모를 확인해야겠다.");
    // The search step shows the query + the folded sources (safe links).
    const search = within(timeline).getByTestId("hw-step-search");
    expect(search.textContent).toContain("2026 시장 규모");
    const link = within(timeline).getByTestId("hw-citations").querySelector("a.hw-citation-link") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("https://ex.com/a");
    expect(link.getAttribute("rel")).toContain("noopener");

    // The op-card settles below; applying calls onApply with the terminal intents.
    fireEvent.click(await screen.findByText("✓ 적용"));
    await waitFor(() => expect(onApply).toHaveBeenCalledWith([paraIntent]));
    // Timeline stays visible above the applied card.
    expect(screen.getByTestId("hw-timeline")).toBeTruthy();
  });

  it("no proposed edits → an 'empty' turn, and the timeline is preserved (not an error)", async () => {
    const onAiRequest: Ai = async (_i, _a, _c, opts) => {
      opts?.onEvent?.({ type: "status", phase: "thinking" });
      opts?.onEvent?.({ type: "thinking_delta", text: "바꿀 것이 없다." });
      opts?.onEvent?.({ type: "intents", intents: [] });
      return [];
    };
    const { container } = renderPanel(onAiRequest);
    sendPrompt(container, "아무것도 바꾸지 마");
    expect((await screen.findByTestId("hw-empty-result")).textContent).toContain("제안된 편집이 없습니다.");
    expect(screen.getByTestId("hw-timeline")).toBeTruthy();
    expect(screen.queryByText("✓ 적용")).toBeNull();
  });

  it("a host that ignores onEvent still works (non-streaming back-compat: cards render, no timeline)", async () => {
    const onAiRequest: Ai = async () => [paraIntent]; // never calls opts.onEvent
    const { container } = renderPanel(onAiRequest);
    sendPrompt(container, "이 문단 다듬어줘");
    await screen.findByText("✓ 적용"); // cards render
    expect(screen.queryByTestId("hw-timeline")).toBeNull(); // no steps → no timeline
  });

  it("CONVERSATION MEMORY: the second prompt carries prior turns in opts.history (bounded, digested)", async () => {
    const seen: (AiRequestOptions | undefined)[] = [];
    const cards: IntentCard[] = [{ kind: "SetParagraphText", icon: "✎", label: "문단", summary: "문단 교체", section: 0, block: 2 }];
    const onAiRequest: Ai = async (_i, _a, _c, opts) => {
      seen.push(opts);
      return [paraIntent];
    };
    const { container } = renderPanel(onAiRequest);

    sendPrompt(container, "첫 요청");
    fireEvent.click(await screen.findByText("✓ 적용"));
    await waitFor(() => expect(screen.getByText("✓ 적용됨")).toBeTruthy());
    expect(seen[0]?.history).toBeUndefined(); // first request has no memory

    sendPrompt(container, "둘째 요청");
    await waitFor(() => expect(seen).toHaveLength(2));
    const hist = seen[1]?.history ?? [];
    expect(hist[0]).toMatchObject({ role: "user", text: "첫 요청" });
    expect(hist.some((t) => t.role === "assistant" && t.text.startsWith("제안:"))).toBe(true);
    void cards;
  });
});
