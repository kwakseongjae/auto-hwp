import { render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HwpPageView } from "../components/HwpPageView";
import { MockAdapter } from "./mockAdapter";

// R7 end-to-end: a malicious adapter returns SVG carrying <script>/onload/javascript:. HwpPageView must
// route it through sanitizeSvg, so the injected DOM never contains active content. This proves the
// injection gate is enforced in the component (not just the standalone sanitizer).
// Well-formed XML (image/svg+xml is parsed strictly) so the sanitizer PROCESSES it and we prove the
// dangerous parts are scrubbed out — not merely rejected for being malformed.
const MALICIOUS = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 794 1123" width="794" height="1123" onload="window.__pwned=1">
  <script>window.__pwned = 2;</script>
  <a xlink:href="javascript:window.__pwned=3"><text>click</text></a>
  <foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><img src="x" onerror="window.__pwned=4" /></div></foreignObject>
  <rect width="794" height="1123" fill="#fff" />
</svg>`;

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__pwned;
});

describe("HwpPageView forces sanitize (R7)", () => {
  it("never injects <script>/onload/javascript:/foreignObject into the DOM", async () => {
    const adapter = new MockAdapter({ svg: () => MALICIOUS, pages: 1 });
    const { container } = render(<HwpPageView adapter={adapter} pageCount={1} />);

    await waitFor(() => {
      const sheet = container.querySelector(".hw-sheet");
      expect(sheet?.querySelector("svg")).toBeTruthy(); // benign SVG rendered
    });

    const sheet = container.querySelector(".hw-sheet")!;
    // No dangerous nodes survived.
    expect(sheet.querySelector("script")).toBeNull();
    expect(sheet.querySelector("foreignObject")).toBeNull();
    // No dangerous attributes survived.
    const svg = sheet.querySelector("svg")!;
    expect(svg.getAttribute("onload")).toBeNull();
    expect(sheet.innerHTML.toLowerCase()).not.toContain("javascript:");
    expect(sheet.innerHTML.toLowerCase()).not.toContain("onerror");
    // The safe content is still there.
    expect(sheet.querySelector("rect")).toBeTruthy();
    // And nothing executed.
    expect((window as unknown as Record<string, unknown>).__pwned).toBeUndefined();
  });

  it("scripts embedded in SVG do not execute when inserted", async () => {
    const spy = vi.fn();
    (window as unknown as Record<string, unknown>).__spy = spy;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" width="10" height="10"><script>window.__spy()</script></svg>`;
    render(<HwpPageView adapter={new MockAdapter({ svg: () => svg, pages: 1 })} pageCount={1} />);
    await waitFor(() => {});
    expect(spy).not.toHaveBeenCalled();
    delete (window as unknown as Record<string, unknown>).__spy;
  });
});
