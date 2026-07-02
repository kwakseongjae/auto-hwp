import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { HwpWorkspace } from "../components/HwpWorkspace";
import { FONT_CATALOG } from "../fonts";
import { MockAdapter } from "./mockAdapter";

// Issue 022 workspace wiring: the default font auto-registers on open (metrics + PDF), the @font-face
// <style> is injected (screen == PDF), and the FontPicker is shown. SelectionOverlay is untouched (021).
describe("HwpWorkspace font system (issue 022)", () => {
  it("auto-registers the defaultFont on open and injects the @font-face style + FontPicker", async () => {
    const adapter = new MockAdapter({ pages: 2 });
    const defaultFont = { family: "Nanum Gothic", bytes: new Uint8Array([0x00, 0x01, 0x00, 0x00, 1, 2, 3]) };

    const { container } = render(
      <HwpWorkspace
        adapter={adapter}
        document={{ bytes: new Uint8Array([1]), name: "t.hwpx" }}
        onAiRequest={async () => []}
        fontCatalog={FONT_CATALOG}
        defaultFont={defaultFont}
      />,
    );

    // The default font is registered exactly once (drives metrics + PDF), with the given family.
    await waitFor(() => expect(adapter.registeredFonts.length).toBe(1));
    expect(adapter.registeredFonts[0].family).toBe("Nanum Gothic");

    // The FontPicker is present and reflects the current font.
    expect(screen.getByTestId("font-picker")).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/현재: Nanum Gothic/)).toBeTruthy());

    // The screen @font-face/alias style is injected (so the SVG matches the PDF).
    await waitFor(() => {
      const style = container.querySelector('[data-testid="hw-fontface"]');
      expect(style?.textContent).toContain(".hw-sheet svg text");
      expect(style?.textContent).toContain('"Nanum Gothic"');
    });
  });

  it("without a fontCatalog, no FontPicker is shown (opt-in)", async () => {
    const adapter = new MockAdapter({ pages: 1 });
    render(<HwpWorkspace adapter={adapter} document={{ bytes: new Uint8Array([1]), name: "t.hwpx" }} onAiRequest={async () => []} />);
    await waitFor(() => expect(screen.queryByTestId("font-picker")).toBeNull());
  });
});
