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
    const { container } = render(<HwpWorkspace adapter={adapter} document={doc} onAiRequest={noAi} onExport={onExport} />);
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
      const { container } = render(<HwpWorkspace adapter={adapter} document={doc} onAiRequest={noAi} />);
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
    const { container } = render(<HwpWorkspace adapter={adapter} document={doc} onAiRequest={noAi} onExport={onExport} />);
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
    const { container } = render(<HwpWorkspace adapter={adapter} document={doc} onAiRequest={noAi} onExport={onExport} />);
    await waitFor(() => expect(container.querySelector(".hw-sheet svg")).toBeTruthy());

    fireEvent.click(screen.getByTitle("PDF 다운로드"));
    await waitFor(() => expect(onExport).toHaveBeenCalled());
    expect(container.textContent ?? "").not.toContain("자리표시 상자");
  });
});
