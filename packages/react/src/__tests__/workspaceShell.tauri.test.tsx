import { fireEvent, render, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { HwpWorkspace } from "../components/HwpWorkspace";
import { TauriAdapter } from "../TauriAdapter";

// Issue 044 — the DESKTOP shell (crates/hwp-viewer/ui WorkspaceShell) mounts THIS assembly:
// HwpWorkspace over a TauriAdapter whose `invoke` hits the Rust commands. This suite drives that exact
// path headlessly with a MOCK invoke (no Tauri runtime) — proving open → pageSvg → cell click resolve
// through the TauriAdapter, and that the opt-in `onExport` intercepts the browser download on desktop
// while its OMISSION leaves the web default (a browser `<a download>`) unchanged.

// jsdom does no layout, so getBoundingClientRect returns zeros → clicks can't map to page px. Stub it to
// a full A4 box (mirrors workspace.flow.test) so coords.ts resolves a real page point.
const origRect = Element.prototype.getBoundingClientRect;
beforeAll(() => {
  Element.prototype.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: 794, bottom: 1123, width: 794, height: 1123, x: 0, y: 0, toJSON() {} }) as DOMRect;
});
afterAll(() => {
  Element.prototype.getBoundingClientRect = origRect;
});
afterEach(() => vi.restoreAllMocks());

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 794 1123" width="794" height="1123"><rect width="794" height="1123" fill="#fff"/></svg>`;
const CELL = { section: 0, block: 1, row: 0, col: 0, rows: 3, cols: 2, text: "셀", x: 40, y: 60, w: 120, h: 40 };
const TABLE = { x: 40, y: 60, w: 240, h: 120, section: 0, block: 1, rows: 3, cols: 2, first_row: 0 };

/** A mock Tauri `invoke` covering the desktop commands the open→render→click→export path drives. Records
 *  every (cmd) so the test can assert which commands the TauriAdapter reached. */
function makeInvoke(calls: string[]) {
  return async <T,>(cmd: string, _args?: Record<string, unknown>): Promise<T> => {
    calls.push(cmd);
    const table = <R,>(v: R) => v as unknown as T;
    switch (cmd) {
      case "open_doc": return table({ pages: 1, editable: true, format: "hwpx" });
      case "own_page_count": return table(1);
      case "render_own_page": return table(SVG);
      case "own_hit_test": return table(null);
      case "table_at": return table(TABLE);
      case "table_cell_at": return table(CELL);
      case "get_block_runs": return table([]);
      case "table_col_boundaries": return table([40, 160, 280]);
      case "table_row_boundaries": return table([60, 100, 140, 180]);
      case "page_geometry": return table(null);
      case "render_doc_html": return table("<html><body>desktop</body></html>");
      case "export_pdf_bytes": return table([0x25, 0x50, 0x44, 0x46]);
      case "apply_intent_json": return table({ kind: "applied", ops: 1 });
      default: return table(null);
    }
  };
}

// The path the shell hands to `document.bytes`; resolveOpenPath decodes it straight back (no temp file).
const PATH = "/tmp/자가진단표.hwpx";
const docProp = () => ({ bytes: new TextEncoder().encode(PATH), name: "자가진단표.hwpx" });
const makeAdapter = (calls: string[]) =>
  new TauriAdapter({ invoke: makeInvoke(calls), resolveOpenPath: async (bytes) => new TextDecoder().decode(bytes) });
const noAi = async () => [];

describe("WorkspaceShell assembly (HwpWorkspace over TauriAdapter, mock invoke)", () => {
  it("mount smoke: open → pageSvg → cell click resolve through the TauriAdapter", async () => {
    const calls: string[] = [];
    const { container } = render(
      <HwpWorkspace adapter={makeAdapter(calls)} document={docProp()} onAiRequest={noAi} enableEditing />,
    );

    // Open + page render: open_doc bridged through resolveOpenPath, render_own_page paints the sheet.
    const sheet = await waitFor(() => {
      const el = container.querySelector('.hw-sheet[data-page="0"]');
      expect(el?.querySelector("svg")).toBeTruthy();
      return el as HTMLElement;
    });
    expect(calls).toContain("open_doc");
    expect(calls).toContain("render_own_page");

    // Click the page → the selection model resolves a CELL via the TauriAdapter (table_cell_at) → a mark.
    fireEvent.pointerDown(sheet, { clientX: 100, clientY: 100, button: 0, pointerId: 1 });
    fireEvent.pointerUp(sheet, { clientX: 100, clientY: 100, button: 0, pointerId: 1 });
    await waitFor(() => expect(container.querySelector(".hw-mark")).toBeTruthy());
    expect(calls).toContain("table_cell_at");
  });

  it("desktop onExport intercepts the HTML button (no browser download)", async () => {
    const calls: string[] = [];
    const onExport = vi.fn(async () => {});
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const { container } = render(
      <HwpWorkspace adapter={makeAdapter(calls)} document={docProp()} onAiRequest={noAi} onExport={onExport} />,
    );
    await waitFor(() => expect(container.querySelector(".hw-sheet svg")).toBeTruthy());

    fireEvent.click(container.querySelector('button[title="HTML 다운로드"]') as HTMLButtonElement);
    await waitFor(() =>
      expect(onExport).toHaveBeenCalledWith("<html><body>desktop</body></html>", "자가진단표.hwpx.html", "text/html"),
    );
    // The web `<a download>` convention must NOT fire when a host onExport is supplied.
    expect(clickSpy).not.toHaveBeenCalled();
  });

  it("web invariant: WITHOUT onExport the HTML button still uses the browser download (unchanged)", async () => {
    const calls: string[] = [];
    const origCreate = URL.createObjectURL;
    const origRevoke = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn(() => "blob:mock");
    URL.revokeObjectURL = vi.fn();
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    try {
      const { container } = render(
        <HwpWorkspace adapter={makeAdapter(calls)} document={docProp()} onAiRequest={noAi} />,
      );
      await waitFor(() => expect(container.querySelector(".hw-sheet svg")).toBeTruthy());
      fireEvent.click(container.querySelector('button[title="HTML 다운로드"]') as HTMLButtonElement);
      await waitFor(() => expect(clickSpy).toHaveBeenCalledTimes(1));
    } finally {
      URL.createObjectURL = origCreate;
      URL.revokeObjectURL = origRevoke;
    }
  });
});
