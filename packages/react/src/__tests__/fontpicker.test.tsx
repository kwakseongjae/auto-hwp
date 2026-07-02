import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FontPicker } from "../components/FontPicker";
import { FONT_CATALOG } from "../fonts";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("FontPicker (issue 022)", () => {
  it("renders the catalog options + upload button with Korean labels", () => {
    render(<FontPicker catalog={FONT_CATALOG} selected={null} onPick={() => {}} />);
    expect(screen.getByLabelText("글꼴 선택")).toBeTruthy();
    expect(screen.getByText("업로드")).toBeTruthy();
    // The bundled default label is present.
    expect(screen.getByRole("option", { name: /나눔고딕 \(기본\)/ })).toBeTruthy();
  });

  it("selecting a catalog font fetches its bytes and calls onPick", async () => {
    const bytes = new Uint8Array([0x00, 0x01, 0x00, 0x00, 5, 6]); // TTF sfnt magic
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, arrayBuffer: async () => bytes.buffer })),
    );
    const picks: { family: string; bytes: Uint8Array }[] = [];
    render(<FontPicker catalog={FONT_CATALOG} selected={null} onPick={(f) => void picks.push(f)} />);
    fireEvent.change(screen.getByLabelText("글꼴 선택"), { target: { value: "Noto Sans KR" } });
    await waitFor(() => expect(picks.length).toBe(1));
    expect(picks[0].family).toBe("Noto Sans KR");
    expect(picks[0].bytes.length).toBe(6);
  });

  it("rejects an uploaded TTC with a Korean error (no onPick)", async () => {
    const ttc = new File([new Uint8Array([0x74, 0x74, 0x63, 0x66, 0, 1])], "collection.ttf");
    let picked = false;
    let error: string | null = null;
    render(
      <FontPicker catalog={FONT_CATALOG} selected={null} onPick={() => { picked = true; }} onError={(m) => { error = m; }} />,
    );
    fireEvent.change(screen.getByTestId("font-upload-input"), { target: { files: [ttc] } });
    await waitFor(() => expect(error).toBeTruthy());
    expect(error!).toContain("TTC");
    expect(picked).toBe(false);
  });

  it("accepts an uploaded TTF and calls onPick with the file stem as the family", async () => {
    const ttf = new File([new Uint8Array([0x00, 0x01, 0x00, 0x00, 9])], "MyFont.ttf");
    const picks: { family: string; bytes: Uint8Array }[] = [];
    render(<FontPicker catalog={FONT_CATALOG} selected={null} onPick={(f) => void picks.push(f)} />);
    fireEvent.change(screen.getByTestId("font-upload-input"), { target: { files: [ttf] } });
    await waitFor(() => expect(picks.length).toBe(1));
    expect(picks[0].family).toBe("MyFont");
  });

  it("surfaces a download error when the catalog fetch fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404 })));
    let error: string | null = null;
    render(<FontPicker catalog={FONT_CATALOG} selected={null} onPick={() => {}} onError={(m) => (error = m)} />);
    fireEvent.change(screen.getByLabelText("글꼴 선택"), { target: { value: "Pretendard" } });
    await waitFor(() => expect(error).toBeTruthy());
    expect(error!).toContain("불러오지 못했습니다");
  });

  it("shows the current font when one is selected", () => {
    render(<FontPicker catalog={FONT_CATALOG} selected="Nanum Gothic" onPick={() => {}} />);
    expect(screen.getByText(/현재: Nanum Gothic/)).toBeTruthy();
  });
});
