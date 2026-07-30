import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HwpWorkspace } from "../components/HwpWorkspace";
import { ChatPanel } from "../components/ChatPanel";
import { StatusBar } from "../components/StatusBar";
import { koKR, mergeMessages, WorkspaceMessagesProvider, type DeepPartial, type WorkspaceMessages } from "../i18n";
import { describeIntent } from "../describeIntent";
import { chatSidePanel } from "../chatSlot";
import { MockAdapter } from "./mockAdapter";
import type { DocContext } from "../types";

// 077 — SDK i18n 주입 계약.
//
// 왜 이 파일이 계약을 잠그는가: 문자열을 카탈로그로 옮기는 변경은 "기능 변화 0" 이어야 한다. 그래서
// ① messages 를 주지 않은 기본 렌더가 종전 한국어 그대로인지, ② enUS 부분 catalog 를 주입하면
// 업로드→편집→export 의 chrome 이 영어로 바뀌는지, ③ 주지 않은 키가 koKR 로 안전하게 폴백하는지를
// 각각 컴포넌트 렌더 단위로 확인한다. (e2e 는 통합 verify 몫 — 여기서는 DOM 만 본다.)

const doc = { bytes: new Uint8Array([1]), name: "t.hwpx" };
const docContext: DocContext = { format: "hwpx", editable: true, sections: 1, pages: 1, anchors: [] };
const noAi = async () => [];

/** 호스트가 넘기는 PARTIAL catalog — 스모크가 확인하는 chrome 만 덮는다(나머지는 koKR 폴백). */
const enUS: DeepPartial<WorkspaceMessages> = {
  workspace: {
    noDocument: "No document",
    docMeta: (format, pages) => `${format} · ${pages} pages`,
    zoomIn: "Zoom in",
    zoomOut: "Zoom out",
    undo: "Undo",
    redo: "Redo",
    downloadHtml: "Download HTML",
    downloadHwpx: "Download HWPX",
    downloadPdf: "Download PDF",
    emptyCanvas: "Open a document to see its pages here.",
    opened: (name, pages) => `Opened: ${name} · ${pages} pages`,
    insertImageTitle: "Insert image",
    insertImage: "Image",
  },
  statusBar: {
    pageOf: (page, pageCount) => `${page} / ${pageCount}`,
    editMode: "Edit mode",
    viewMode: "View mode",
    readOnly: "Read only",
  },
  ribbon: { toolbarLabel: "Character format", modeSelection: "Applies to the selected cell/range" },
  table: { insert: "Insert table" },
  chat: { send: "Send", title: "Vibe edit" },
};

describe("mergeMessages (077 병합 규칙)", () => {
  it("override 가 없으면 기본 카탈로그를 그대로 돌려준다 (재생성 없음)", () => {
    expect(mergeMessages(koKR, undefined)).toBe(koKR);
  });

  it("깊은 부분 override — 명시한 키만 바뀌고 형제 키는 koKR 로 남는다", () => {
    const merged = mergeMessages(koKR, { statusBar: { editMode: "Edit mode" } });
    expect(merged.statusBar.editMode).toBe("Edit mode");
    expect(merged.statusBar.viewMode).toBe(koKR.statusBar.viewMode);
    // 건드리지 않은 그룹은 참조까지 그대로여서 하위 consumer 가 헛되이 리렌더되지 않는다.
    expect(merged.format).toBe(koKR.format);
  });

  it("함수 메시지는 통째로 교체된다 (구조화된 인자 유지)", () => {
    const merged = mergeMessages(koKR, { statusBar: { pageOf: (p, n) => `${p} of ${n}` } });
    expect(merged.statusBar.pageOf(2, 8)).toBe("2 of 8");
    expect(koKR.statusBar.pageOf(2, 8)).toBe("2 / 8쪽"); // 원본 카탈로그는 변형되지 않는다
  });

  it("undefined 값은 '기본값 유지' 로 읽는다", () => {
    const merged = mergeMessages(koKR, { statusBar: { editMode: undefined } });
    expect(merged.statusBar.editMode).toBe(koKR.statusBar.editMode);
  });
});

describe("messages 미주입 = 종전 한국어 (077 수용 기준 1)", () => {
  it("워크스페이스 chrome 이 한국어 그대로다", async () => {
    const adapter = new MockAdapter({ pages: 2 });
    const { container } = render(
      <HwpWorkspace adapter={adapter} document={doc} onAiRequest={noAi} sidePanel={chatSidePanel({ onAiRequest: noAi })} enableEditing />,
    );
    await waitFor(() => expect(container.querySelector(".hw-sheet svg")).toBeTruthy());

    expect(screen.getByTitle("실행취소")).toBeTruthy();
    expect(screen.getByTitle("다시 실행")).toBeTruthy();
    expect(screen.getByTitle("HTML 다운로드")).toBeTruthy();
    expect(screen.getByTitle(/HWPX 다운로드/)).toBeTruthy();
    expect(screen.getByTitle("PDF 다운로드")).toBeTruthy();
    expect(screen.getByTestId("hw-table-insert").textContent).toBe("표 추가");
    expect(screen.getByTestId("hw-statusbar-page").textContent).toMatch(/^\d+ \/ 2쪽$/);
    expect(screen.getByTestId("hw-statusbar-mode").textContent).toBe("편집 모드");
    expect(container.querySelector(".hw-doc-meta")?.textContent).toBe("HWPX · 2쪽");
  });
});

describe("enUS 부분 catalog 주입 스모크 (077 수용 기준 2)", () => {
  it("업로드→편집→export 의 chrome 이 영어로 나온다", async () => {
    const adapter = new MockAdapter({ pages: 2 });
    const { container } = render(
      <HwpWorkspace adapter={adapter} document={doc} onAiRequest={noAi} sidePanel={chatSidePanel({ onAiRequest: noAi })} enableEditing messages={enUS} />,
    );
    await waitFor(() => expect(container.querySelector(".hw-sheet svg")).toBeTruthy());

    // ① 업로드(문서 열기) — 상태 토스트 + 문서 메타
    await waitFor(() => expect(container.querySelector(".hw-status")?.textContent).toBe("Opened: t.hwpx · 2 pages"));
    expect(container.querySelector(".hw-doc-meta")?.textContent).toBe("HWPX · 2 pages");

    // ② 편집 chrome — 리본 / 표 삽입 / 상태바
    expect(screen.getByTestId("hw-format-ribbon").getAttribute("aria-label")).toBe("Character format");
    expect(screen.getByTestId("hw-ribbon-mode").textContent).toBe("Applies to the selected cell/range");
    expect(screen.getByTestId("hw-table-insert").textContent).toBe("Insert table");
    expect(screen.getByTestId("hw-statusbar-page").textContent).toMatch(/^\d+ \/ 2$/); // "쪽" 이 사라졌다
    expect(screen.getByTestId("hw-statusbar-mode").textContent).toBe("Edit mode");

    // ③ export — 세 버튼 모두 영어
    expect(screen.getByTitle("Download HTML")).toBeTruthy();
    expect(screen.getByTitle("Download HWPX")).toBeTruthy();
    expect(screen.getByTitle("Download PDF")).toBeTruthy();

    // ④ 사이드 패널(채팅)까지 provider 가 닿는다
    expect(container.querySelector(".hw-chat-title")?.textContent).toBe("Vibe edit");
    expect(container.querySelector(".hw-btn-send")?.textContent).toBe("Send");
  });

  it("주지 않은 키는 koKR 로 폴백한다 (077 수용 기준 4)", async () => {
    const adapter = new MockAdapter({ pages: 2 });
    const { container } = render(
      <HwpWorkspace adapter={adapter} document={doc} onAiRequest={noAi} sidePanel={chatSidePanel({ onAiRequest: noAi })} enableEditing messages={enUS} />,
    );
    await waitFor(() => expect(container.querySelector(".hw-sheet svg")).toBeTruthy());
    // enUS 는 리본의 개별 서식 버튼을 덮지 않았다 → 한국어 그대로.
    expect(screen.getByTestId("hw-ribbon-bold").textContent).toBe("가");
    expect(screen.getByTestId("hw-ribbon-shade-clear").textContent).toBe("배경 지움");
    // 다른 그룹(chat)의 미지정 키도 마찬가지 — enUS 는 chat.title/send 만 덮었다.
    expect(container.querySelector(".hw-chat-sub")?.textContent).toBe(koKR.chat.subtitle);
  });
});

describe("헤드리스 코어까지 카탈로그가 닿는다 (077 — editor-core 절반)", () => {
  it("mergeMessages 가 core 그룹도 깊게 병합한다 (형제 키는 koKR)", () => {
    const merged = mergeMessages(koKR, { core: { anchor: { cellWhere: (r, c) => `row ${r}, col ${c}` } } });
    expect(merged.core.anchor.cellWhere(2, 3)).toBe("row 2, col 3");
    expect(merged.core.anchor.tableAt(4)).toBe(koKR.core.anchor.tableAt(4)); // 미지정 → 한국어
    expect(merged.core.intent).toBe(koKR.core.intent); // 손대지 않은 하위 그룹은 참조 그대로
  });

  it("describeIntent 는 카탈로그를 받으면 그 문구로, 안 받으면 koKR 로 카드를 만든다", () => {
    const intent = { intent: "SetTableCell", section: 0, block: 1, row: 0, col: 0, text: "x" } as never;
    expect(describeIntent(intent).label).toBe("칸 채우기");
    expect(describeIntent(intent, { ...koKR.core.intent, op: { SetTableCell: "Fill cell" } }).label).toBe("Fill cell");
  });
});

describe("provider 없는 단독 컴포넌트 (077 결정: 기본 한국어)", () => {
  it("provider 밖에서는 koKR 로 렌더된다", () => {
    render(<StatusBar currentPage={0} pageCount={3} editing={false} canEdit />);
    expect(screen.getByTestId("hw-statusbar-page").textContent).toBe("1 / 3쪽");
    expect(screen.getByTestId("hw-statusbar-mode").textContent).toBe("보기 모드");
  });

  it("WorkspaceMessagesProvider 로 감싸면 호스트 문자열을 쓴다", () => {
    render(
      <WorkspaceMessagesProvider messages={enUS}>
        <StatusBar currentPage={0} pageCount={3} editing={false} canEdit />
      </WorkspaceMessagesProvider>,
    );
    expect(screen.getByTestId("hw-statusbar-page").textContent).toBe("1 / 3");
    expect(screen.getByTestId("hw-statusbar-mode").textContent).toBe("View mode");
  });

  it("독립 export 된 ChatPanel 도 같은 계약을 따른다", () => {
    const { container, rerender } = render(
      <ChatPanel canEdit anchors={[]} onRemoveAnchor={() => {}} onConsumeAnchors={() => {}} onAiRequest={noAi} onApply={async () => 0} docContext={docContext} />,
    );
    expect(container.querySelector(".hw-btn-send")?.textContent).toBe("보내기");
    rerender(
      <WorkspaceMessagesProvider messages={enUS}>
        <ChatPanel canEdit anchors={[]} onRemoveAnchor={() => {}} onConsumeAnchors={() => {}} onAiRequest={noAi} onApply={async () => 0} docContext={docContext} />
      </WorkspaceMessagesProvider>,
    );
    expect(container.querySelector(".hw-btn-send")?.textContent).toBe("Send");
  });
});
