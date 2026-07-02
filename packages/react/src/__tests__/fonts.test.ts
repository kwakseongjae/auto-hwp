import { describe, expect, it } from "vitest";
import { FONT_CATALOG, buildFontFaceCss, catalogUrl, isTtc, svgFontFamilies } from "../fonts";

describe("fonts helpers (issue 022)", () => {
  it("catalog is non-empty and every entry is OFL (R8 hard gate)", () => {
    expect(FONT_CATALOG.length).toBeGreaterThan(0);
    for (const e of FONT_CATALOG) {
      expect(e.license).toBe("OFL");
      expect(e.family).toBeTruthy();
      expect(e.label).toBeTruthy();
      expect(e.file).toMatch(/\.(ttf|otf)$/i);
      expect(e.source).toMatch(/^https?:\/\//);
    }
    // The repo-bundled default (NanumGothic) must be present and marked bundled.
    const nanum = FONT_CATALOG.find((e) => e.family === "Nanum Gothic");
    expect(nanum?.bundled).toBe(true);
  });

  it("catalogUrl joins base + file", () => {
    expect(catalogUrl(FONT_CATALOG[0])).toBe(`/fonts/${FONT_CATALOG[0].file}`);
    expect(catalogUrl(FONT_CATALOG[0], "/assets/fonts/")).toBe(`/assets/fonts/${FONT_CATALOG[0].file}`);
  });

  it("buildFontFaceCss defines the face + the NanumGothic alias + the <text> override", () => {
    const css = buildFontFaceCss("Noto Sans KR", "blob:abc");
    expect(css).toContain('@font-face { font-family: "Noto Sans KR"; src: url("blob:abc"); }');
    // Universal SVG fallback name is re-pointed at the selected bytes.
    expect(css).toContain('@font-face { font-family: "NanumGothic"; src: url("blob:abc"); }');
    // Alias rule maps EVERY document font name (via the <text> selector) to the selected face.
    expect(css).toContain('.hw-sheet svg text { font-family: "Noto Sans KR", "NanumGothic", sans-serif !important; }');
  });

  it("buildFontFaceCss escapes a family with a quote", () => {
    const css = buildFontFaceCss('My "Nice" Font', "blob:x");
    expect(css).toContain('font-family: "My \\"Nice\\" Font"');
  });

  it("isTtc detects the ttcf magic only", () => {
    expect(isTtc(new Uint8Array([0x74, 0x74, 0x63, 0x66, 0, 1]))).toBe(true); // "ttcf"
    expect(isTtc(new Uint8Array([0x00, 0x01, 0x00, 0x00]))).toBe(false); // TTF sfnt
    expect(isTtc(new Uint8Array([0x4f, 0x54, 0x54, 0x4f]))).toBe(false); // "OTTO"
    expect(isTtc(new Uint8Array([1, 2]))).toBe(false); // too short
  });

  it("svgFontFamilies extracts the distinct primary families the own-render emits", () => {
    const svg = '<text font-family="함초롬바탕, NanumGothic, sans-serif">가</text><text font-family="NanumGothic, sans-serif">a</text>';
    const fams = svgFontFamilies(svg).sort();
    expect(fams).toEqual(["NanumGothic", "함초롬바탕"]);
  });
});
