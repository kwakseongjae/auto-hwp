/// Font system v1 (issue 022): the curated OFL catalog + the screen `@font-face`/alias helpers.
///
/// The own-render SVG draws every glyph with `font-family="<doc font>, NanumGothic, sans-serif"` (or
/// just `"NanumGothic, sans-serif"` when the run carries no explicit family) — measured from
/// `hwp-render`'s SvgSink. So the browser needs the SELECTED font under those names, or it substitutes a
/// system face and the screen diverges from the PDF. [`buildFontFaceCss`] solves both halves:
///   1. an `@font-face` binding the selected font's BYTES (same bytes registered for metrics + PDF), and
///   2. an ALIAS rule that maps EVERY document font name to that face — v1's "모든 문서 폰트명 → 현재
///      선택 폰트 1개" (issue §3) — by overriding the `<text>` `font-family` presentation attribute
///      (author CSS beats presentation attributes) AND re-defining the universal `NanumGothic` fallback.
/// Bold/italic/size presentation attributes are left intact (the browser synthesizes bold/oblique from
/// the one injected face — v1 injects a single Regular face).

/** One curated, redistributable font (R8 hard gate — every entry is OFL; see `docs/FONT-CATALOG.md`).
 *  `family` is the CSS/registration name; `label` is the Korean UI label; `file` is the basename the
 *  app serves from its font dir (the lab's `public/fonts/`); `source` is the official download origin. */
export interface FontCatalogEntry {
  family: string;
  label: string;
  license: "OFL";
  file: string;
  source: string;
  /** True for the repo-bundled default (NanumGothic) — always available offline; others need fetch. */
  bundled?: boolean;
}

/** The v1 curated catalog — **all OFL, redistribution-legal** (issue §카탈로그 v1 / R8). Download URLs
 *  are the app's concern (it serves these `file`s from its own font dir); `docs/FONT-CATALOG.md` carries
 *  the license table + original-source links. A host maps each entry to a URL via `catalogUrl`. */
export const FONT_CATALOG: readonly FontCatalogEntry[] = [
  { family: "Nanum Gothic", label: "나눔고딕", license: "OFL", file: "NanumGothic-Regular.ttf", source: "https://github.com/google/fonts/tree/main/ofl/nanumgothic", bundled: true },
  { family: "Nanum Myeongjo", label: "나눔명조", license: "OFL", file: "NanumMyeongjo-Regular.ttf", source: "https://github.com/google/fonts/tree/main/ofl/nanummyeongjo" },
  { family: "Noto Sans KR", label: "본고딕 (Noto Sans KR)", license: "OFL", file: "NotoSansKR-Regular.ttf", source: "https://github.com/notofonts/noto-cjk" },
  { family: "Noto Serif KR", label: "본명조 (Noto Serif KR)", license: "OFL", file: "NotoSerifKR-Regular.ttf", source: "https://github.com/notofonts/noto-cjk" },
  { family: "IBM Plex Sans KR", label: "IBM Plex Sans KR", license: "OFL", file: "IBMPlexSansKR-Regular.ttf", source: "https://github.com/IBM/plex" },
  { family: "Gowun Dodum", label: "고운돋움", license: "OFL", file: "GowunDodum-Regular.ttf", source: "https://github.com/google/fonts/tree/main/ofl/gowundodum" },
  { family: "Gowun Batang", label: "고운바탕", license: "OFL", file: "GowunBatang-Regular.ttf", source: "https://github.com/google/fonts/tree/main/ofl/gowunbatang" },
  { family: "Pretendard", label: "프리텐다드", license: "OFL", file: "Pretendard-Regular.otf", source: "https://github.com/orioncactus/pretendard" },
] as const;

/** Map a catalog entry to the URL the app serves it from (default: `<base>/<file>`, base = `/fonts`). */
export function catalogUrl(entry: FontCatalogEntry, base = "/fonts"): string {
  return `${base.replace(/\/$/, "")}/${entry.file}`;
}

/** Quote a CSS `font-family` value safely (families carry spaces / Hangul / punctuation). */
function quoteFamily(name: string): string {
  return `"${String(name).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** True iff `bytes` begins with the TTC ("ttcf") magic — a collection krilla/our shaper reject (§함정). */
export function isTtc(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x74 && bytes[1] === 0x74 && bytes[2] === 0x63 && bytes[3] === 0x66;
}

/** Build the screen `@font-face` + alias CSS for the selected font (issue 022 §3). `url` is a blob/URL
 *  for the SAME bytes fed to `registerFont` (metrics + PDF), so screen == PDF. The alias rule targets
 *  `<text>` inside `.hw-sheet` (where HwpPageView draws the SVG) so every document font name renders in
 *  the selected face; the `NanumGothic` re-definition covers the SVG's universal fallback name too. */
export function buildFontFaceCss(family: string, url: string): string {
  const fam = quoteFamily(family);
  const src = `url("${url}")`;
  // No font-weight/style descriptors → the one face matches any request; the browser synthesizes
  // bold/oblique for the SVG's font-weight="700"/font-style="italic" presentation attributes.
  return [
    `@font-face { font-family: ${fam}; src: ${src}; }`,
    `@font-face { font-family: "NanumGothic"; src: ${src}; }`,
    `.hw-sheet svg text { font-family: ${fam}, "NanumGothic", sans-serif !important; }`,
  ].join("\n");
}

/** Extract the distinct primary document font-family names the own-render SVG emits (the part before
 *  the first comma of each `font-family="…"`). Diagnostics / the "실측" of issue §3 — the alias in
 *  [`buildFontFaceCss`] handles them uniformly, but this lets a host inspect what the doc requested. */
export function svgFontFamilies(svg: string): string[] {
  const out = new Set<string>();
  const re = /font-family="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(svg))) {
    const first = m[1].split(",")[0].trim().replace(/^["']|["']$/g, "");
    if (first) out.add(first);
  }
  return [...out];
}
