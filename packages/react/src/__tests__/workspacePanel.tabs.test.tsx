import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WorkspacePanel } from "../components/WorkspacePanel";
import type { WorkspaceSidePanel } from "../components/HwpWorkspace";
import type { DocContext, Intent } from "../types";

// U1 — 바이브↔디자인 탭 왕복은 **표시**만 바꾼다. 대화 기록·작성 중이던 입력은 그대로 살아 있어야 한다.
// (두 pane 은 항상 마운트된 채 display 로만 갈린다 — 언마운트는 곧 상태 소실이다.)
const docContext: DocContext = { format: "hwpx", editable: true, sections: 1, pages: 1, anchors: [] };

function makeApi(overrides: Partial<WorkspaceSidePanel> = {}): WorkspaceSidePanel {
  return {
    canEdit: true,
    anchors: [],
    modLabel: "⌘",
    removeAnchor: () => {},
    clearAnchors: () => {},
    docContext,
    apply: async () => 1,
    jumpToPage: () => {},
    revealTarget: () => {},
    focusToken: 0,
    previewCards: async () => [],
    revert: async () => true,
    undoDepth: () => 0,
    designSelection: null,
    ...overrides,
  };
}

describe("WorkspacePanel — 탭 왕복 상태 보존 (U1)", () => {
  it("메시지와 입력 중 텍스트가 디자인 탭 왕복 후에도 남는다", async () => {
    const onAiRequest = vi.fn(
      async (): Promise<Intent[]> => [
        { intent: "SetParagraphText", section: 0, block: 0, text: "안녕" } as Intent,
      ],
    );
    const { container } = render(<WorkspacePanel api={makeApi()} onAiRequest={onAiRequest} />);

    const textarea = container.querySelector(".hw-textarea") as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.change(textarea, { target: { value: "표 채워줘" } });
      fireEvent.keyDown(textarea, { key: "Enter" });
    });
    await waitFor(() => expect(onAiRequest).toHaveBeenCalled());
    await screen.findByText("표 채워줘");

    // 보낸 뒤 다시 초안을 쓰던 중 …
    const composer = container.querySelector(".hw-textarea") as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "그리고 제목도" } });

    // 디자인 탭 → 바이브 탭 왕복
    fireEvent.click(screen.getByTestId("hw-design-tab"));
    fireEvent.click(screen.getByRole("tab", { name: /바이브|Vibe/ }));

    // 대화도 초안도 살아 있다.
    expect(screen.getByText("표 채워줘")).toBeTruthy();
    const after = container.querySelector(".hw-textarea") as HTMLTextAreaElement;
    expect(after.value).toBe("그리고 제목도");
  });

  it("패널 접기→펴기 후에도 대화가 남는다", async () => {
    const onAiRequest = vi.fn(
      async (): Promise<Intent[]> => [
        { intent: "SetParagraphText", section: 0, block: 0, text: "안녕" } as Intent,
      ],
    );
    const { container } = render(<WorkspacePanel api={makeApi()} onAiRequest={onAiRequest} />);
    const textarea = container.querySelector(".hw-textarea") as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.change(textarea, { target: { value: "표 채워줘" } });
      fireEvent.keyDown(textarea, { key: "Enter" });
    });
    await screen.findByText("표 채워줘");

    fireEvent.click(container.querySelector(".hw-sidepanel-collapse") as HTMLButtonElement);
    fireEvent.click(container.querySelector(".hw-sidepanel-expand") as HTMLButtonElement);

    expect(screen.getByText("표 채워줘")).toBeTruthy();
  });
});
