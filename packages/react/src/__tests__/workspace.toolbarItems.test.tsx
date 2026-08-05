import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HwpWorkspace } from "../components/HwpWorkspace";
import { chatSidePanel } from "../chatSlot";
import { MockAdapter } from "./mockAdapter";

// U4 — 상단 툴바 노출 필터(additive). 기본(prop 미지정)은 **전 항목 노출**이라 기존 소비자는 무영향이고,
// 배열을 넘기면 그 항목만 남는다. 숨김은 "표시 계약"일 뿐이라 기능(ops·단축키·컨텍스트 메뉴)은 그대로다.
const doc = { bytes: new Uint8Array([1]), name: "t.hwpx" };
const noAi = async () => [];

function renderBar(toolbarItems?: readonly string[]) {
  return render(
    <HwpWorkspace
      adapter={new MockAdapter({ pages: 1 })}
      document={doc}
      onAiRequest={noAi}
      sidePanel={chatSidePanel({ onAiRequest: noAi })}
      enableEditing
      toolbarItems={toolbarItems as never}
    />,
  );
}

describe("HwpWorkspace toolbarItems (U4)", () => {
  it("기본(미지정)은 기존 그대로 전부 노출한다", async () => {
    const { container } = renderBar();
    await waitFor(() => expect(container.querySelector(".hw-sheet svg")).toBeTruthy());
    expect(screen.getByTitle(/HWPX 다운로드/)).toBeTruthy();
    expect(screen.getByTitle(/HTML/)).toBeTruthy();
    expect(screen.getByTestId("hw-table-insert")).toBeTruthy();
    expect(screen.getByTitle("실행취소")).toBeTruthy();
  });

  it("허용 목록을 주면 그 항목만 남고 나머지는 툴바에서 사라진다", async () => {
    const { container } = renderBar(["zoom", "undo", "redo", "exportHtml", "exportPdf"]);
    await waitFor(() => expect(container.querySelector(".hw-sheet svg")).toBeTruthy());

    // 남는 것
    expect(screen.getByTitle("실행취소")).toBeTruthy();
    expect(screen.getByTitle("다시 실행")).toBeTruthy();
    expect(screen.getByTitle(/HTML/)).toBeTruthy();
    expect(screen.getByTitle(/PDF/)).toBeTruthy();
    expect(container.querySelector(".hw-zoom")).toBeTruthy();

    // 빠지는 것 (기능이 아니라 노출만 — 표 추가는 컨텍스트 메뉴에 그대로 남는다)
    expect(screen.queryByTitle(/HWPX 다운로드/)).toBeNull();
    expect(screen.queryByTestId("hw-table-insert")).toBeNull();
  });

  it("줌은 −/%/+ 를 한 그룹으로 끈다", async () => {
    const { container } = renderBar(["exportPdf"]);
    await waitFor(() => expect(container.querySelector(".hw-sheet svg")).toBeTruthy());
    expect(container.querySelector(".hw-zoom")).toBeNull();
    expect(screen.getByTitle(/PDF/)).toBeTruthy();
  });
});
