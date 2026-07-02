import { describe, expect, it } from "vitest";
import { sanitizeSvg } from "../sanitize";

// R7 (SVG web injection): a malicious .hwp/.hwpx can smuggle <script>, on* handlers, javascript: URLs,
// or <foreignObject> into its rendered SVG. sanitizeSvg is the SINGLE gate every SVG string passes
// through before HwpPageView injects it. These tests fix that active content NEVER survives the gate.
describe("sanitizeSvg (R7)", () => {
  it("strips <script> elements", () => {
    const out = sanitizeSvg(
      `<svg xmlns="http://www.w3.org/2000/svg"><script>window.__pwned=1</script><rect/></svg>`,
    );
    expect(out).not.toMatch(/<script/i);
    expect(out).not.toMatch(/__pwned/);
    expect(out).toMatch(/<rect/); // benign content preserved
  });

  it("strips on* event-handler attributes (e.g. onload)", () => {
    const out = sanitizeSvg(
      `<svg xmlns="http://www.w3.org/2000/svg" onload="window.__pwned=1"><rect onclick="alert(1)"/></svg>`,
    );
    expect(out.toLowerCase()).not.toMatch(/onload/);
    expect(out.toLowerCase()).not.toMatch(/onclick/);
    expect(out).not.toMatch(/__pwned/);
  });

  it("strips javascript: URLs in href / xlink:href", () => {
    const out = sanitizeSvg(
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><a xlink:href="javascript:alert(1)"><text>x</text></a><a href="javascript:evil()"/></svg>`,
    );
    expect(out.toLowerCase()).not.toMatch(/javascript:/);
  });

  it("strips <foreignObject> (arbitrary HTML smuggling)", () => {
    const out = sanitizeSvg(
      `<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><body xmlns="http://www.w3.org/1999/xhtml"><img src=x onerror="window.__pwned=1"></body></foreignObject></svg>`,
    );
    expect(out.toLowerCase()).not.toMatch(/foreignobject/);
    expect(out).not.toMatch(/__pwned/);
  });

  it("refuses (returns empty) on malformed / non-svg markup", () => {
    expect(sanitizeSvg("<not-svg><script>x</script></not-svg>")).toBe("");
    expect(sanitizeSvg("<<< broken")).toBe("");
  });

  it("keeps a safe data:image raster href but drops data:image/svg+xml (nested script vector)", () => {
    const png = sanitizeSvg(
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><image xlink:href="data:image/png;base64,iVBOR"/></svg>`,
    );
    expect(png.toLowerCase()).toMatch(/data:image\/png/);
    const svgData = sanitizeSvg(
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><image xlink:href="data:image/svg+xml;base64,PHN2Zz4="/></svg>`,
    );
    expect(svgData.toLowerCase()).not.toMatch(/data:image\/svg/);
  });
});
