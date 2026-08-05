import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DesignPanel } from "../components/DesignPanel";
import { WorkspacePanel, WorkspacePanelFrame } from "../components/WorkspacePanel";
import type { WorkspaceDesignSelection, WorkspaceSidePanel } from "../components/HwpWorkspace";

const selection: WorkspaceDesignSelection = {
  kind: "cell",
  label: "2행 3열",
  page: 1,
  section: 0,
  block: 4,
  text: "사업계획서",
  box: { x: 120, y: 80, w: 240, h: 48 },
  format: { font: "Nanum Gothic", sizePt: 18, color: "#112233", bold: true, italic: false },
  canTextStyle: true,
  canCellStyle: true,
};

describe("DesignPanel", () => {
  it("선택의 프레임·현재 글자 서식을 보여주고 변경 delta만 보낸다", () => {
    const onPatch = vi.fn();
    render(<DesignPanel selection={selection} fonts={["Nanum Gothic", "Nanum Myeongjo"]} onPatch={onPatch} />);

    expect(screen.getByText("2행 3열")).toBeTruthy();
    expect(screen.getByText("240.0")).toBeTruthy();
    expect((screen.getByTestId("hw-design-size") as HTMLInputElement).value).toBe("18");
    expect(screen.getByTestId("hw-design-bold").getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(screen.getByTestId("hw-design-bold"));
    expect(onPatch).toHaveBeenCalledWith({ bold: false });
    fireEvent.change(screen.getByTestId("hw-design-shade"), { target: { value: "#aabbcc" } });
    expect(onPatch).toHaveBeenCalledWith({ shade: "#aabbcc" });
  });

  it("문단은 글자 디자인만 활성화하고 셀 배경·정렬은 비활성화한다", () => {
    render(
      <DesignPanel
        selection={{ ...selection, kind: "paragraph", label: "제목 문단", canCellStyle: false }}
        onPatch={() => {}}
      />,
    );
    expect((screen.getByTestId("hw-design-bold") as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByTestId("hw-design-shade") as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(/표 셀 또는 셀 범위/)).toBeTruthy();
  });

  it("텍스트 편집 중에는 프레임·셀 장식을 접고 타이포그래피만 유지한다", () => {
    render(<DesignPanel selection={selection} textEditing onPatch={() => {}} />);
    expect(screen.getByText("텍스트 편집 중")).toBeTruthy();
    expect(screen.getByText("텍스트")).toBeTruthy();
    expect(screen.queryByText("프레임")).toBeNull();
    expect(screen.queryByText("셀")).toBeNull();
    expect(screen.getByTestId("hw-design-bold")).toBeTruthy();
  });
});

describe("WorkspacePanel", () => {
  it("배치 셸은 하단·모달·무스타일 프리셋을 제공하고 닫힘 상태도 호스트가 제어한다", () => {
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <WorkspacePanelFrame presentation="bottom" onOpenChange={onOpenChange}>
        <div>호스트 도구</div>
      </WorkspacePanelFrame>,
    );
    expect(screen.getByTestId("hw-panel-layer").className).toContain("hw-panel-layer-bottom");
    fireEvent.click(screen.getByRole("button", { name: "편집 패널 닫기" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);

    rerender(
      <WorkspacePanelFrame presentation="modal" open={false} onOpenChange={onOpenChange}>
        <div>호스트 도구</div>
      </WorkspacePanelFrame>,
    );
    fireEvent.click(screen.getByRole("button", { name: "편집 패널 열기" }));
    expect(onOpenChange).toHaveBeenCalledWith(true);

    rerender(
      <WorkspacePanelFrame presentation="unstyled">
        <div>내 디자인</div>
      </WorkspacePanelFrame>,
    );
    // U1 구조 변경: children 은 이제 접힘/펼침에서 위치가 고정된 `.hw-sidepanel-body` 안에 산다
    // (언마운트=상태 소실을 막기 위한 래퍼). 프리셋 클래스는 여전히 바깥 aside 가 갖는다.
    expect(screen.getByText("내 디자인").closest(".hw-sidepanel")?.className).toContain("hw-sidepanel-unstyled");
  });

  it("기본은 바이브이고, 선택이 생기면 디자인으로 자동 전환한다", async () => {
    const api: WorkspaceSidePanel = {
      canEdit: true,
      anchors: [],
      modLabel: "⌘",
      removeAnchor: () => {},
      clearAnchors: () => {},
      docContext: { format: "hwp", editable: true, sections: 1, pages: 1, anchors: [] },
      apply: async () => 0,
      jumpToPage: () => {},
      revealTarget: () => {},
      focusToken: 0,
      previewCards: async () => [],
      revert: async () => false,
      undoDepth: () => 0,
      designSelection: selection,
      applyDesign: () => {},
      designFonts: ["Nanum Gothic"],
    };
    const { rerender } = render(
      <WorkspacePanel api={{ ...api, designSelection: null }} onAiRequest={async () => []} />,
    );

    expect(screen.getByRole("tab", { name: /바이브 편집/ }).getAttribute("aria-selected")).toBe("true");
    rerender(<WorkspacePanel api={api} onAiRequest={async () => []} />);
    await waitFor(() =>
      expect(screen.getByTestId("hw-design-tab").getAttribute("aria-selected")).toBe("true"),
    );
    expect(screen.getByTestId("hw-design-panel")).toBeTruthy();
    expect(screen.getByText("2행 3열")).toBeTruthy();
  });

  it("AI에게 전달 focusToken은 같은 프레임의 선택 갱신보다 우선해 바이브로 전환한다", async () => {
    const api: WorkspaceSidePanel = {
      canEdit: true,
      anchors: [],
      modLabel: "⌘",
      removeAnchor: () => {},
      clearAnchors: () => {},
      docContext: { format: "hwp", editable: true, sections: 1, pages: 1, anchors: [] },
      apply: async () => 0,
      jumpToPage: () => {},
      revealTarget: () => {},
      focusToken: 0,
      previewCards: async () => [],
      revert: async () => false,
      undoDepth: () => 0,
      designSelection: selection,
      applyDesign: () => {},
    };
    const { rerender } = render(<WorkspacePanel api={api} onAiRequest={async () => []} />);
    await waitFor(() =>
      expect(screen.getByTestId("hw-design-tab").getAttribute("aria-selected")).toBe("true"),
    );

    rerender(
      <WorkspacePanel
        api={{ ...api, focusToken: 1, designSelection: { ...selection, label: "변경된 선택" } }}
        onAiRequest={async () => []}
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: /바이브 편집/ }).getAttribute("aria-selected")).toBe("true"),
    );
  });
});
