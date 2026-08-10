import { chatSidePanel } from "../chatSlot";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HwpWorkspace } from "../components/HwpWorkspace";
import type { DocProfile } from "../types";
import { MockAdapter } from "./mockAdapter";

// 067-follow (진단 U7 정직성) — export 표면 2종:
//  ① HWPX 다운로드 버튼: 내부용이던 toHwpx(052 자동저장 직렬화)를 사용자 버튼으로 노출 — "한글로
//    다시 열 파일"을 받을 수 있는 유일한 경로. onExport(데스크톱 시임) 인터셉트도 HTML/PDF 와 동일.
//  ② PDF 스텁 경고: 수식·차트는 PDF 백엔드가 자리표시 상자로 내보낸다(062 §B2) — 문서 프로필(067)의
//    equation/chart 카운트로 미리 알리되 차단하지 않는다. 프로필 없는 백엔드는 경고 없이 그대로.

const doc = { bytes: new Uint8Array([1]), name: "t.hwpx" };
const noAi = async () => [];

const PROFILE_WITH_STUBS: DocProfile = {
  title: null,
  sections: 1,
  paragraph_count: 3,
  table_count: 0,
  image_count: 0,
  chart_count: 2,
  equation_count: 1,
  headings: [],
  tables: [],
  excerpt: "",
};

afterEach(() => vi.restoreAllMocks());

describe("HWPX 다운로드 버튼 (067-follow, U7)", () => {
  it("클릭 → adapter.toHwpx() 바이트가 .hwpx 이름/hwp+zip mime 으로 onExport 에 전달된다", async () => {
    const adapter = new MockAdapter({ pages: 1 });
    const onExport = vi.fn(async () => {});
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const { container } = render(<HwpWorkspace adapter={adapter} document={doc} onAiRequest={noAi} sidePanel={chatSidePanel({ onAiRequest: noAi })} onExport={onExport} />);
    await waitFor(() => expect(container.querySelector(".hw-sheet svg")).toBeTruthy());

    fireEvent.click(screen.getByTitle(/HWPX 다운로드/));
    await waitFor(() => expect(onExport).toHaveBeenCalledWith(new Uint8Array([0x50, 0x4b]), "t.hwpx.hwpx", "application/hwp+zip"));
    // 호스트 onExport 가 있으면 브라우저 <a download> 는 발화하지 않는다(044 시임 규약 동일).
    expect(clickSpy).not.toHaveBeenCalled();
  });

  it("onExport 없으면(웹) 브라우저 다운로드로 내려간다", async () => {
    const adapter = new MockAdapter({ pages: 1 });
    const origCreate = URL.createObjectURL;
    const origRevoke = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn(() => "blob:mock");
    URL.revokeObjectURL = vi.fn();
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    try {
      const { container } = render(<HwpWorkspace adapter={adapter} document={doc} onAiRequest={noAi} sidePanel={chatSidePanel({ onAiRequest: noAi })} />);
      await waitFor(() => expect(container.querySelector(".hw-sheet svg")).toBeTruthy());
      fireEvent.click(screen.getByTitle(/HWPX 다운로드/));
      await waitFor(() => expect(clickSpy).toHaveBeenCalledTimes(1));
    } finally {
      URL.createObjectURL = origCreate;
      URL.revokeObjectURL = origRevoke;
    }
  });
});

describe("PDF 스텁 경고 (067-follow, U7)", () => {
  it("수식·차트가 있으면 자리표시 안내 토스트를 띄우되 export 는 계속한다", async () => {
    const adapter = new MockAdapter({ pages: 1, profile: PROFILE_WITH_STUBS });
    adapter.fontRegistered = true; // exportPdf 의 font_missing 게이트 통과
    const onExport = vi.fn(async () => {});
    const { container } = render(<HwpWorkspace adapter={adapter} document={doc} onAiRequest={noAi} sidePanel={chatSidePanel({ onAiRequest: noAi })} onExport={onExport} />);
    await waitFor(() => expect(container.querySelector(".hw-sheet svg")).toBeTruthy());

    fireEvent.click(screen.getByTitle("PDF 다운로드"));
    // 경고(수식1+차트2=3개)와 export 완주가 모두 일어난다 — 차단이 아니라 고지.
    await waitFor(() => expect(container.textContent).toContain("수식·차트 3개는 현재 PDF에서 자리표시 상자로 출력됩니다"));
    await waitFor(() => expect(onExport).toHaveBeenCalledWith(expect.any(Uint8Array), "t.hwpx.pdf", "application/pdf"));
  });

  it("프로필이 없는 백엔드(docProfile 생략)는 경고 없이 그대로 export 한다(회귀 안전)", async () => {
    const adapter = new MockAdapter({ pages: 1 }); // profile 생략 → docProfile 메서드 자체가 없음
    adapter.fontRegistered = true;
    const onExport = vi.fn(async () => {});
    const { container } = render(<HwpWorkspace adapter={adapter} document={doc} onAiRequest={noAi} sidePanel={chatSidePanel({ onAiRequest: noAi })} onExport={onExport} />);
    await waitFor(() => expect(container.querySelector(".hw-sheet svg")).toBeTruthy());

    fireEvent.click(screen.getByTitle("PDF 다운로드"));
    await waitFor(() => expect(onExport).toHaveBeenCalled());
    expect(container.textContent ?? "").not.toContain("자리표시 상자");
  });
});

// 이슈 6 — PDF 미리보기(opt-in `pdfPreview`): export 버튼이 곧장 다운로드하지 않고 방금 만든 바이트를
// 모달(iframe)로 보여준다. "다운로드"가 그 **같은 바이트**를 호스트 레인(onExport/브라우저)으로 보낸다.
describe("PDF 미리보기 모달 (이슈 6)", () => {
  it("pdfPreview 켜면: 클릭 → 모달이 열리고 즉시 다운로드는 없다 → 다운로드 버튼이 그 바이트를 저장", async () => {
    const adapter = new MockAdapter({ pages: 3 });
    adapter.fontRegistered = true;
    const onExport = vi.fn(async () => {});
    const origCreate = URL.createObjectURL;
    const origRevoke = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn(() => "blob:pdf-preview");
    URL.revokeObjectURL = vi.fn();
    try {
      const { container } = render(
        <HwpWorkspace adapter={adapter} document={doc} onAiRequest={noAi} sidePanel={chatSidePanel({ onAiRequest: noAi })} onExport={onExport} pdfPreview />,
      );
      await waitFor(() => expect(container.querySelector(".hw-sheet svg")).toBeTruthy());

      fireEvent.click(screen.getByTitle("PDF 다운로드"));
      // 모달이 열린다 — 그리고 이 시점에는 아직 아무것도 저장되지 않았다(미리보기가 먼저).
      await waitFor(() => expect(screen.getByTestId("pdf-preview")).toBeTruthy());
      expect(onExport).not.toHaveBeenCalled();
      const frame = screen.getByTestId("pdf-preview-frame") as HTMLIFrameElement;
      expect(frame.getAttribute("src")).toBe("blob:pdf-preview");
      // 파일명 + 쪽수가 정직하게 표시된다.
      expect(screen.getByTestId("pdf-preview").textContent).toContain("t.hwpx.pdf");
      expect(screen.getByTestId("pdf-preview").textContent).toContain("3쪽");

      // 다운로드 → 미리 본 그 바이트가 호스트 레인으로 나간다.
      fireEvent.click(screen.getByTestId("pdf-preview-download"));
      await waitFor(() => expect(onExport).toHaveBeenCalledWith(expect.any(Uint8Array), "t.hwpx.pdf", "application/pdf"));

      // 닫기 → 모달이 사라지고 blob 이 회수된다(누수 금지).
      fireEvent.click(screen.getByTestId("pdf-preview-close"));
      await waitFor(() => expect(screen.queryByTestId("pdf-preview")).toBeNull());
      expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:pdf-preview");
    } finally {
      URL.createObjectURL = origCreate;
      URL.revokeObjectURL = origRevoke;
    }
  });

  it("pdfPreview 를 안 켠 호스트는 예전 그대로 즉시 내보낸다(회귀 안전)", async () => {
    const adapter = new MockAdapter({ pages: 1 });
    adapter.fontRegistered = true;
    const onExport = vi.fn(async () => {});
    const { container } = render(
      <HwpWorkspace adapter={adapter} document={doc} onAiRequest={noAi} sidePanel={chatSidePanel({ onAiRequest: noAi })} onExport={onExport} />,
    );
    await waitFor(() => expect(container.querySelector(".hw-sheet svg")).toBeTruthy());
    fireEvent.click(screen.getByTitle("PDF 다운로드"));
    await waitFor(() => expect(onExport).toHaveBeenCalledWith(expect.any(Uint8Array), "t.hwpx.pdf", "application/pdf"));
    expect(screen.queryByTestId("pdf-preview")).toBeNull();
  });
});
