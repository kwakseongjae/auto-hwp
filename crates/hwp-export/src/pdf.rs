//! PDF export from OUR OWN layout — the paint-IR → krilla bridge (feature `pdf`).
//!
//! Pipeline (so PDF == own-render, NOT a browser print): a [`SemanticDoc`] is paginated + positioned
//! by `hwp-render`/`hwp-typeset` into per-page [`PageLayerTree`]s (paint IR, schemaVersion 1); this
//! module replays each tree's [`PaintOp`]s onto a krilla page — `Glyph` → real text (font subset
//! embedded), `Rect` → filled/stroked path, `Image` → embedded PNG/JPEG (else a stub box). Page size
//! and margins come from the section's [`PageSetup`] (already baked into the placed coordinates and
//! the page width/height, so we only convert units here).
//!
//! Font embedding: we load the SAME face the shaper prefers — the vendored FREE NanumGothic (OFL,
//! Hangul + Latin in one family), then system Korean faces, then a vendored Noto fallback — and hand
//! the bytes to krilla, which subsets to exactly the glyphs we draw. One consistent face for Hangul
//! AND Latin means the PDF glyph SHAPES match our metrics (no AppleGothic-shaped Latin). If NO font is
//! found, glyphs become outline-stub rects so the box stays visible (geometry is still our own); this
//! never panics headless/CI. Use [`is_font_real`] to check which path was taken.
//!
//! Coordinate system: the paint IR is HWPUNIT, page-top-left origin, y-down. krilla's user space is
//! PDF points (1pt = 1/72in), top-left origin, y-down — the SAME orientation — so we only scale by
//! `HWPUNIT_PER_PT` (1in = 7200 HWPUNIT = 72pt ⇒ 100 HWPUNIT/pt). No y-flip needed.

use hwp_model::document::{LineStyle, SemanticDoc};
use hwp_model::font_class::{classify, FontCategory};
use hwp_model::layout::{PageLayerTree, PaintOp};
use hwp_model::prelude::FontMetricsProvider;
use hwp_model::types::Color;

use krilla::color::rgb;
use krilla::geom::{PathBuilder, Point, Rect};
use krilla::num::NormalizedF32;
use krilla::page::PageSettings;
use krilla::paint::{Fill, Stroke, StrokeDash};
use krilla::text::{Font, TextDirection};
use krilla::Document;

/// 1 PDF point = 1/72 inch; 1 inch = 7200 HWPUNIT ⇒ 100 HWPUNIT per point.
const HWPUNIT_PER_PT: f64 = 7200.0 / 72.0;

/// HWPUNIT → PDF points.
fn pt(v: f64) -> f32 {
    (v / HWPUNIT_PER_PT) as f32
}

/// Same candidate list the shaper prefers — vendored NanumGothic first (one free face for Hangul +
/// Latin so the embedded shapes match our metrics), then system Korean faces, then a Noto fallback.
/// krilla subsets whichever loads first to exactly the glyphs we draw.
const FONT_CANDIDATES: &[(&str, u32)] = &[
    // Vendored FREE font (OFL) FIRST — the SAME face the shaper prefers, so the PDF embeds and draws
    // every glyph (Hangul AND Latin) in NanumGothic, matching our own metrics. This is what fixes the
    // Latin glyph SHAPES (no more AppleGothic-shaped Latin) on the PDF/own-render path.
    (
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../assets/fonts/NanumGothic-Regular.ttf"
        ),
        0,
    ),
    ("/System/Library/Fonts/Supplemental/AppleGothic.ttf", 0),
    ("/System/Library/Fonts/Supplemental/AppleMyungjo.ttf", 0),
    ("/System/Library/Fonts/AppleSDGothicNeo.ttc", 0),
    ("/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc", 0),
    (
        "/usr/share/fonts/opentype/noto/NotoSansCJKkr-Regular.otf",
        0,
    ),
    ("/usr/share/fonts/truetype/nanum/NanumGothic.ttf", 0),
    // Vendored in hwp-typeset (drop a Noto Sans KR there to make CI deterministic).
    (
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../hwp-typeset/assets/NotoSansKR-Regular.ttf"
        ),
        0,
    ),
];

/// Bold faces for bold runs — vendored NanumGothic-Bold first, then Linux Nanum bold. If none load,
/// bold runs fall back to the regular face (no synthetic bolding). macOS AppleGothic ships no separate
/// bold file, so the bundled NanumGothic-Bold is what gives the gov-doc its visible bold weight.
const BOLD_FONT_CANDIDATES: &[(&str, u32)] = &[
    (
        concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../assets/fonts/NanumGothic-Bold.ttf"
        ),
        0,
    ),
    ("/usr/share/fonts/truetype/nanum/NanumGothicBold.ttf", 0),
];

/// SERIF (명조/바탕) faces for glyphs whose document face classifies as [`FontCategory::Serif`] (issue
/// 058). No serif is bundled (the OFL serif substitute — Nanum Myeongjo — is host-injected, R8), so this
/// is a best-effort SYSTEM discovery: macOS AppleMyungjo, then Linux Noto Serif CJK / Nanum Myeongjo. If
/// none loads, the serif slot stays `None` and 명조 glyphs draw with the gothic body face (pre-058). On
/// the wasm/web path the serif face is INJECTED by family name instead (see [`EmbedFont::from_injected`]).
const SERIF_FONT_CANDIDATES: &[(&str, u32)] = &[
    ("/System/Library/Fonts/Supplemental/AppleMyungjo.ttf", 0),
    (
        "/usr/share/fonts/opentype/noto/NotoSerifCJKkr-Regular.otf",
        0,
    ),
    ("/usr/share/fonts/truetype/noto/NotoSerifCJK-Regular.ttc", 0),
    ("/usr/share/fonts/truetype/nanum/NanumMyeongjo.ttf", 0),
];

/// A loaded text face for embedding, paired with the path it came from (diagnostics) and whether it
/// is a real Korean-capable face vs. a last-resort fallback.
struct EmbedFont {
    font: Font,
    /// Bold face for bold runs; `None` → bold runs draw with the regular face (no synthetic bolding).
    bold: Option<Font>,
    /// SERIF (명조/바탕) face for glyphs whose document face classifies as [`FontCategory::Serif`] (issue
    /// 058). `None` → 명조 glyphs draw with the gothic body face (pre-058 behavior). Discovered from the
    /// system on native, or INJECTED by family name on wasm/web.
    serif: Option<Font>,
    /// EVERY parseable injected face by its EXACT family name (폰트 제공): a glyph whose IR `font`
    /// names a registered family (the own-render explicit-family bypass stamps it verbatim) embeds
    /// with THAT face — e.g. a run set to "Pretendard" ships real Pretendard, not the class
    /// substitute. Empty on the discover/native path (no behavior change without injection).
    extra: Vec<(String, Font)>,
    path: String,
    /// True when a candidate from [`FONT_CANDIDATES`] loaded (Korean-capable). False = no font found
    /// (glyphs become stub rects so the box stays visible).
    real: bool,
}

impl EmbedFont {
    /// Load the first parseable candidate as a krilla [`Font`] (+ a bold companion when available).
    /// `None` only if NO candidate exists on this machine — callers then render glyphs as stub boxes
    /// (never panic).
    fn discover() -> Option<EmbedFont> {
        for &(path, index) in FONT_CANDIDATES {
            let Ok(bytes) = std::fs::read(path) else {
                continue;
            };
            if let Some(font) = Font::new(bytes.into(), index) {
                return Some(EmbedFont {
                    font,
                    bold: Self::discover_from(BOLD_FONT_CANDIDATES),
                    serif: Self::discover_from(SERIF_FONT_CANDIDATES),
                    extra: Vec::new(),
                    path: path.to_string(),
                    real: true,
                });
            }
        }
        None
    }

    /// Load the first parseable candidate from `candidates` as a krilla [`Font`], or `None`. Shared by
    /// the bold ([`BOLD_FONT_CANDIDATES`]) and serif ([`SERIF_FONT_CANDIDATES`]) auxiliary slots.
    fn discover_from(candidates: &[(&str, u32)]) -> Option<Font> {
        for &(path, index) in candidates {
            let Ok(bytes) = std::fs::read(path) else {
                continue;
            };
            if let Some(font) = Font::new(bytes.into(), index) {
                return Some(font);
            }
        }
        None
    }

    /// Build an [`EmbedFont`] from CALLER-INJECTED bytes (the wasm/web path where `std::fs` has no
    /// fonts — issue 018). The first parseable `(family, bytes)` becomes the body face; per the issue,
    /// v1 does NOT do document-level font-family matching (that's a follow-up) — the injected face is
    /// simply used as the default face for ALL runs. Bold runs reuse the regular face (no synthetic
    /// bolding) unless an injected family name contains "bold". `None` if nothing parses → the caller
    /// falls back to `discover` (native) or stub boxes (wasm). TTF/OTF single-face bytes only (krilla's
    /// `simple-text` can't take a TTC collection).
    fn from_injected(injected: &[(String, Vec<u8>)]) -> Option<EmbedFont> {
        // Best-effort bold: an injected face whose family hints "bold" backs bold runs (still v1-simple
        // — no family-to-run mapping). Parsed lazily so a non-bold-only injection costs nothing.
        let bold = injected
            .iter()
            .find(|(family, _)| family.to_ascii_lowercase().contains("bold"))
            .and_then(|(_, bytes)| Font::new(bytes.clone().into(), 0));
        // Issue 058: an injected face whose family classifies 명조/serif (e.g. "Noto Serif KR") backs the
        // serif slot, so 명조 glyphs (whose IR `font` is the serif substitute) draw with it. A "bold"
        // serif is skipped here (it feeds the bold slot); serif+bold falls back to the serif regular.
        let serif = injected
            .iter()
            .find(|(family, _)| {
                !family.to_ascii_lowercase().contains("bold")
                    && classify(family) == FontCategory::Serif
            })
            .and_then(|(_, bytes)| Font::new(bytes.clone().into(), 0));
        // The BODY (default gothic) face: the first injected face that is NOT the serif/bold slot, so a
        // host that injects [NanumGothic, Noto Serif KR] keeps NanumGothic as the body (and the metric
        // path — `own_render_fonts_with` — picks the same first face). Falls back to the first parseable.
        let body = injected
            .iter()
            .find(|(family, _)| {
                !family.to_ascii_lowercase().contains("bold")
                    && classify(family) != FontCategory::Serif
            })
            .or_else(|| {
                injected
                    .iter()
                    .find(|(f, _)| !f.to_ascii_lowercase().contains("bold"))
            })
            .or_else(|| injected.first());
        let (family, bytes) = body?;
        let font = Font::new(bytes.clone().into(), 0)?;
        // 폰트 제공: keep EVERY parseable injected face by family for the per-glyph explicit match.
        let extra = injected
            .iter()
            .filter_map(|(fam, b)| Font::new(b.clone().into(), 0).map(|f| (fam.clone(), f)))
            .collect();
        Some(EmbedFont {
            font,
            bold,
            serif,
            extra,
            path: format!("injected:{family}"),
            real: true,
        })
    }
}

/// Options for [`export_pdf`].
#[derive(Clone, Debug, Default)]
pub struct PdfOptions {
    /// Document title for the PDF metadata (optional).
    pub title: Option<String>,
}

/// Result of a PDF export: the bytes plus what font path (if any) backed the glyphs.
#[derive(Clone, Debug)]
pub struct PdfExport {
    pub bytes: Vec<u8>,
    pub pages: usize,
    /// Path of the embedded font, or `None` when no Korean face was found (glyphs are stub boxes).
    pub font_path: Option<String>,
}

/// True iff a real (Korean-capable) font is available to embed — i.e. a future [`export_pdf`] will
/// render glyphs as real, selectable text rather than stub boxes. Diagnostics for the CLI/tests.
pub fn is_font_real() -> bool {
    EmbedFont::discover().map(|f| f.real).unwrap_or(false)
}

/// Export `doc` to a PDF byte buffer, driving OUR paginator/placer over `fonts` (inject
/// `hwp_typeset::RealFontMetrics` under `--features shaper`, else `ApproxFontMetrics`). Every page of
/// the paint IR is replayed onto a krilla page so the PDF matches own-render. Korean glyphs embed a
/// subset of the DISCOVERED face (`std::fs` candidates). Returns the bytes + page count + the embedded
/// font path.
///
/// This is the NATIVE entry point (viewer/CLI) and its behavior is byte-for-byte unchanged — it simply
/// forwards to [`export_pdf_with_fonts`] with no injected fonts, so the discover path is taken exactly
/// as before.
pub fn export_pdf(
    doc: &SemanticDoc,
    fonts: &dyn FontMetricsProvider,
    opts: &PdfOptions,
) -> Result<PdfExport, String> {
    export_pdf_with_fonts(doc, fonts, opts, &[])
}

/// Like [`export_pdf`], but the caller may INJECT font faces `(family, bytes)` — the wasm/web path
/// where `std::fs` holds no fonts (issue 018). Selection policy: if `injected_fonts` is non-empty and
/// at least one face parses, that injected face backs the glyphs (**preferred over discover**); if the
/// injected bytes don't parse we fall back to `discover`; and with an EMPTY slice we go straight to
/// `discover` — i.e. the native path is unchanged. Font-family→run matching is intentionally NOT done
/// in v1 (the injected face is the single body default; a document-level mapping is a follow-up).
pub fn export_pdf_with_fonts(
    doc: &SemanticDoc,
    fonts: &dyn FontMetricsProvider,
    opts: &PdfOptions,
    injected_fonts: &[(String, Vec<u8>)],
) -> Result<PdfExport, String> {
    // One PageLayerTree per page from our own pipeline — the SAME IR the SVG sink replays.
    let trees = hwp_render::render_doc_trees(doc, fonts);
    // Injected bytes win over discover (wasm has no fs fonts); an empty slice → pure discover (native
    // path, byte-identical). A non-empty-but-unparseable injection still falls back to discover.
    let embed = if injected_fonts.is_empty() {
        EmbedFont::discover()
    } else {
        EmbedFont::from_injected(injected_fonts).or_else(EmbedFont::discover)
    };

    let mut document = Document::new();
    if let Some(title) = &opts.title {
        let mut meta = krilla::metadata::Metadata::new();
        meta = meta.title(title.clone());
        document.set_metadata(meta);
    }

    for tree in &trees {
        lower_tree_to_page(&mut document, tree, doc, embed.as_ref());
    }

    let bytes = document
        .finish()
        .map_err(|e| format!("krilla finish: {e:?}"))?;
    Ok(PdfExport {
        pages: trees.len(),
        bytes,
        font_path: embed.as_ref().map(|f| f.path.clone()),
    })
}

/// Replay one page's paint IR onto a fresh krilla page. Paint order is preserved from the IR (fills →
/// borders → images → glyphs) so overdraw matches the SVG/own-render.
fn lower_tree_to_page(
    document: &mut Document,
    tree: &PageLayerTree,
    doc: &SemanticDoc,
    embed: Option<&EmbedFont>,
) {
    let w = pt(tree.width).max(1.0);
    let h = pt(tree.height).max(1.0);
    let settings = PageSettings::from_wh(w, h).unwrap_or_else(|| PageSettings::new(default_size()));
    let mut page = document.start_page_with(settings);
    let mut surface = page.surface();

    for op in &tree.ops {
        match op {
            PaintOp::Rect { x, y, w, h, fill } => {
                paint_rect(&mut surface, *x, *y, *w, *h, *fill);
            }
            PaintOp::Line {
                x1,
                y1,
                x2,
                y2,
                color,
                style,
                width,
            } => {
                paint_line(&mut surface, *x1, *y1, *x2, *y2, *color, *style, *width);
            }
            PaintOp::Image {
                x,
                y,
                w,
                h,
                bin_ref,
                // Equation SVG (issue 062-5) is ignored by the PDF backend — v1 defers SVG→PDF (no
                // resvg), so an equation renders as the same stub box `paint_image` draws for it.
                svg: _,
            } => {
                paint_image(&mut surface, *x, *y, *w, *h, bin_ref, doc);
            }
            PaintOp::Glyph {
                x,
                y,
                ch,
                size,
                color,
                bold,
                italic,
                font,
                cluster,
            } => {
                // Issue 058: the IR `font` is the OFL substitute family the own-render resolved (Some(
                // "Noto Serif KR") for 명조 glyphs, `None` for 고딕/기타). `paint_glyph` routes serif-
                // classified glyphs to the embedded serif face so the PDF distinguishes 명조 from 고딕.
                // Issue 062-2: `cluster` (Some) is an 옛한글 자모 시퀀스 drawn in place of `ch` (the
                // metric proxy) — krilla shapes it with the embedded face (composes if that face carries
                // conjoining jamo; else notdef, mirroring the on-screen limitation).
                paint_glyph(
                    &mut surface,
                    *x,
                    *y,
                    *ch,
                    *size,
                    *color,
                    *bold,
                    *italic,
                    font.as_deref(),
                    cluster.as_deref(),
                    embed,
                );
            }
        }
    }

    surface.finish();
    page.finish();
}

/// A minimal A4 size in points as a last-resort page size (only hit if width/height were non-finite).
fn default_size() -> krilla::geom::Size {
    krilla::geom::Size::from_wh(595.0, 842.0).unwrap()
}

/// `crate` `Color` → krilla RGB.
fn rgb_of(c: Color) -> rgb::Color {
    rgb::Color::new(c.r, c.g, c.b)
}

/// Paint a `Rect`: `fill = Some` → a filled box (shading); `None` → a thin black stroked outline
/// (cell/line border). Mirrors the SVG sink's stroke width — the SAME hairline weight as the per-edge
/// lines (`BORDER_HAIRLINE_PX` px → pt) so legacy-box and per-edge cells read identically.
fn paint_rect(
    surface: &mut krilla::surface::Surface,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    fill: Option<Color>,
) {
    let Some(rect) = Rect::from_xywh(pt(x), pt(y), pt(w).max(0.01), pt(h).max(0.01)) else {
        return;
    };
    let mut pb = PathBuilder::new();
    pb.push_rect(rect);
    let Some(path) = pb.finish() else { return };

    match fill {
        Some(c) => {
            surface.set_stroke(None);
            surface.set_fill(Some(Fill {
                paint: rgb_of(c).into(),
                opacity: NormalizedF32::ONE,
                rule: Default::default(),
            }));
            surface.draw_path(&path);
        }
        None => {
            surface.set_fill(None);
            surface.set_stroke(Some(Stroke {
                paint: rgb::Color::black().into(),
                width: BORDER_HAIRLINE_PX * PT_PER_PX,
                ..Default::default()
            }));
            surface.draw_path(&path);
        }
    }
}

/// 1 CSS px (the unit of `PaintOp::Line.width`) @ 96 DPI = 72/96 pt = 0.75 pt.
const PT_PER_PX: f32 = 0.75;

/// Thinnest border stroke (CSS px) — the gov-doc hairline floor, shared by the legacy box stroke and
/// the per-edge/diagonal lines so both border paths print at the same weight. Mirrors the SVG sink's
/// `BORDER_HAIRLINE_PX`. At `PT_PER_PX` this is 0.375 pt (the old hand-tuned box-stroke weight).
const BORDER_HAIRLINE_PX: f32 = 0.5;

/// Paint a styled line (a cell edge or diagonal) as a stroked path. `style` maps to a dash pattern
/// (dashed/dotted) or a solid stroke (solid/double — double is a single solid line for now, matching
/// the SVG sink). `width` is in device px → scaled to pt. A `LineStyle::None` never reaches here (the
/// placer skips suppressed edges), but we guard anyway.
#[allow(clippy::too_many_arguments)]
fn paint_line(
    surface: &mut krilla::surface::Surface,
    x1: f64,
    y1: f64,
    x2: f64,
    y2: f64,
    color: Color,
    style: LineStyle,
    width: f64,
) {
    if style == LineStyle::None {
        return;
    }
    // Clamp at the shared hairline floor (in px) BEFORE the pt conversion so a 0.4px gov-doc border
    // and the legacy box stroke print at the exact same weight.
    let w = (width as f32).max(BORDER_HAIRLINE_PX) * PT_PER_PX;
    let dash = match style {
        LineStyle::Dashed => Some(StrokeDash {
            array: vec![w * 4.0, w * 3.0],
            offset: 0.0,
        }),
        LineStyle::Dotted => Some(StrokeDash {
            array: vec![w, w * 2.0],
            offset: 0.0,
        }),
        _ => None,
    };
    let mut pb = PathBuilder::new();
    pb.move_to(pt(x1), pt(y1));
    pb.line_to(pt(x2), pt(y2));
    let Some(path) = pb.finish() else { return };
    surface.set_fill(None);
    surface.set_stroke(Some(Stroke {
        paint: rgb_of(color).into(),
        width: w,
        dash,
        ..Default::default()
    }));
    surface.draw_path(&path);
}

/// Paint an embedded image box. Looks up `bin_ref` in `doc.bin_data`; PNG/JPEG bytes are embedded via
/// krilla (subset of the page). Unknown/equation/absent objects draw a light stub box (so the slot is
/// visible — never silently dropped), matching the SVG sink.
fn paint_image(
    surface: &mut krilla::surface::Surface,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    bin_ref: &str,
    doc: &SemanticDoc,
) {
    let size = match krilla::geom::Size::from_wh(pt(w).max(0.01), pt(h).max(0.01)) {
        Some(s) => s,
        None => return,
    };

    if let Some(img) = decode_image(bin_ref, doc) {
        // krilla draws the image into a 1x1 unit box at the origin, scaled by `size`; translate so the
        // box lands at (x, y) in page points.
        surface.push_transform(&krilla::geom::Transform::from_translate(pt(x), pt(y)));
        surface.draw_image(img, size);
        surface.pop();
    } else {
        // Stub box: light fill + grey outline, same intent as the SVG `#F0F0F0` placeholder.
        paint_rect(
            surface,
            x,
            y,
            w,
            h,
            Some(Color {
                r: 0xF0,
                g: 0xF0,
                b: 0xF0,
                a: 0xFF,
            }),
        );
        paint_rect(surface, x, y, w, h, None);
    }
}

/// Decode a `bin_ref`'s bytes into a krilla [`Image`] if they are a supported raster (PNG/JPEG/GIF).
/// Returns `None` for OLE/equation/unknown kinds → caller draws a stub.
fn decode_image(bin_ref: &str, doc: &SemanticDoc) -> Option<krilla::image::Image> {
    if bin_ref.is_empty() {
        return None;
    }
    let bin = doc.bin_data.iter().find(|b| b.bin_ref == bin_ref)?;
    let data: krilla::Data = bin.bytes.clone().into();
    let kind = bin.kind.to_ascii_lowercase();
    match kind.as_str() {
        "png" => krilla::image::Image::from_png(data, false).ok(),
        "jpg" | "jpeg" => krilla::image::Image::from_jpeg(data, false).ok(),
        "gif" => krilla::image::Image::from_gif(data, false).ok(),
        "webp" => krilla::image::Image::from_webp(data, false).ok(),
        // krilla has no `from_bmp`, so we decode the common uncompressed BMP variants ourselves to
        // rgba8 and embed via `from_rgba8` — closing the parity gap with the SVG sink (which embeds BMP
        // as data:image/bmp for the WebView). Unsupported BMP variants fall through to the stub box.
        "bmp" => decode_bmp_image(&bin.bytes),
        // Unknown kind: sniff the magic bytes so a mislabeled raster still embeds.
        _ => sniff_image(&bin.bytes),
    }
}

/// Decode an uncompressed BMP to rgba8 and wrap it as a krilla [`Image`] (`from_rgba8`). `None` for
/// RLE/exotic/corrupt BMPs → the caller keeps the honest stub box.
fn decode_bmp_image(bytes: &[u8]) -> Option<krilla::image::Image> {
    let (rgba, w, h) = crate::bmp::decode_bmp_to_rgba8(bytes)?;
    Some(krilla::image::Image::from_rgba8(rgba, w, h))
}

/// Best-effort magic-byte sniff for a raster whose declared `kind` was unhelpful.
fn sniff_image(bytes: &[u8]) -> Option<krilla::image::Image> {
    let data: krilla::Data = bytes.to_vec().into();
    if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        krilla::image::Image::from_png(data, false).ok()
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        krilla::image::Image::from_jpeg(data, false).ok()
    } else if bytes.starts_with(b"GIF8") {
        krilla::image::Image::from_gif(data, false).ok()
    } else if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        krilla::image::Image::from_webp(data, false).ok()
    } else if bytes.starts_with(b"BM") {
        decode_bmp_image(bytes)
    } else {
        None
    }
}

/// Paint ONE glyph as real text at its exact baseline position. We own the x (each glyph is drawn at
/// its placed advance), so per-glyph drawing keeps the kerning faithful to our layout. When no font is
/// available, fall back to a small stub box so the glyph slot stays visible. Whitespace draws nothing.
#[allow(clippy::too_many_arguments)]
fn paint_glyph(
    surface: &mut krilla::surface::Surface,
    x: f64,
    y: f64,
    ch: char,
    size: f64,
    color: Color,
    bold: bool,
    italic: bool,
    font: Option<&str>,
    cluster: Option<&str>,
    embed: Option<&EmbedFont>,
) {
    if ch.is_whitespace() {
        return;
    }
    match embed {
        Some(f) => {
            surface.set_stroke(None);
            surface.set_fill(Some(Fill {
                paint: rgb_of(color).into(),
                opacity: NormalizedF32::ONE,
                rule: Default::default(),
            }));
            // Issue 062-2: draw the 옛한글 자모 cluster (Some) as one shaped run; else the single `ch`.
            let mut buf = [0u8; 4];
            let s = match cluster {
                Some(c) => c,
                None => ch.encode_utf8(&mut buf),
            };
            // Face selection (issue 058): a 명조/serif glyph (IR `font` classifies Serif) draws with the
            // embedded serif face when present; else it falls through to the bold/regular gothic body
            // (pre-058 behavior). Serif+bold uses the serif regular in v1 (no bundled serif-bold).
            let is_serif = font
                .map(|n| classify(n) == FontCategory::Serif)
                .unwrap_or(false)
                && f.serif.is_some();
            // 폰트 제공 (explicit-family embed): the own-render bypass stamps a REGISTERED family
            // verbatim — embed with exactly that face when we hold it; else the 058 serif/body route.
            let explicit = font.and_then(|n| {
                f.extra
                    .iter()
                    .find(|(fam, _)| fam.trim().eq_ignore_ascii_case(n.trim()))
                    .map(|(_, face)| face)
            });
            let face = if let Some(face) = explicit {
                face
            } else if is_serif {
                f.serif.as_ref().unwrap()
            } else if bold {
                f.bold.as_ref().unwrap_or(&f.font)
            } else {
                &f.font
            };
            let (bx, by) = (pt(x), pt(y));
            // Italic: NanumGothic has no italic face, so synthesize an oblique by shearing the glyph
            // about its baseline (x' = x - SLANT*y + SLANT*baseline) — ascenders lean right, the
            // baseline origin stays put. Matches the webview's font-style:italic synthesis.
            if italic {
                const SLANT: f32 = 0.21; // ≈ 12°, the conventional faux-italic angle
                surface.push_transform(&krilla::geom::Transform::from_row(
                    1.0,
                    0.0,
                    -SLANT,
                    1.0,
                    SLANT * by,
                    0.0,
                ));
            }
            // y is the baseline in our IR; krilla's draw_text `start` is the text baseline too.
            surface.draw_text(
                Point::from_xy(bx, by),
                face.clone(),
                pt(size),
                s,
                false,
                TextDirection::Auto,
            );
            if italic {
                surface.pop();
            }
        }
        None => {
            // No font: outline the glyph's EM box so the layout is still inspectable.
            let baseline = y;
            let top = baseline - size * 0.8;
            paint_rect(surface, x, top, size, size, None);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hwp_model::prelude::*;
    use hwp_typeset::ApproxFontMetrics;

    fn para(text: &str) -> Paragraph {
        Paragraph {
            runs: vec![Run {
                char_shape: 0,
                content: vec![Inline::Text(text.into())],
                ..Default::default()
            }],
            ..Default::default()
        }
    }

    fn doc_with(blocks: Vec<Block>) -> SemanticDoc {
        let mut doc = SemanticDoc::default();
        doc.char_shapes.push(CharShape::default());
        doc.para_shapes.push(ParaShape::default());
        let sec = Section {
            blocks,
            ..Default::default()
        };
        doc.sections.push(sec);
        doc
    }

    #[test]
    fn exports_valid_pdf_with_pages() {
        let doc = doc_with(vec![
            Block::Paragraph(para("한글 문서 export 테스트")),
            Block::Paragraph(para("두 번째 문단")),
        ]);
        let out = export_pdf(&doc, &ApproxFontMetrics, &PdfOptions::default()).unwrap();
        assert!(out.bytes.starts_with(b"%PDF-"), "valid PDF header");
        assert!(
            out.bytes.ends_with(b"%%EOF") || out.bytes.windows(5).any(|w| w == b"%%EOF"),
            "PDF has an EOF marker"
        );
        assert!(out.pages >= 1, "at least one page");
        assert!(
            out.bytes.len() > 400,
            "non-trivial PDF size, got {}",
            out.bytes.len()
        );
    }

    #[test]
    fn empty_doc_still_makes_a_pdf() {
        let doc = doc_with(vec![Block::Paragraph(para(""))]);
        let out = export_pdf(&doc, &ApproxFontMetrics, &PdfOptions::default()).unwrap();
        assert!(out.bytes.starts_with(b"%PDF-"));
        assert!(out.pages >= 1);
    }

    /// Issue 062-follow (AI-generated charts): a generated chart is an `Inline::Chart` on the
    /// `PaintOp::Image.svg` channel. The PDF backend ignores the SVG and draws its reserved box (v1 —
    /// no SVG→PDF vector path yet, exactly like the 062 OOXML chart). Assert the export doesn't panic
    /// and the chart page is present.
    #[test]
    fn exports_a_doc_with_a_generated_chart_without_panicking() {
        let mut chart_para = Paragraph::default();
        chart_para.runs.push(Run {
            char_shape: 0,
            content: vec![Inline::Chart(ChartRef {
                width: 30000,
                height: 19500,
                rendered_svg: Some(
                    "<g class=\"hwp-gen-chart\"><rect x=\"0\" y=\"0\" width=\"10\" height=\"10\"/></g>"
                        .into(),
                ),
            })],
            ..Default::default()
        });
        let doc = doc_with(vec![
            Block::Paragraph(para("차트 문서")),
            Block::Paragraph(chart_para),
        ]);
        let out = export_pdf(&doc, &ApproxFontMetrics, &PdfOptions::default()).unwrap();
        assert!(out.bytes.starts_with(b"%PDF-"), "valid PDF header");
        assert!(out.pages >= 1, "the chart box is laid out on a page");
    }

    #[test]
    fn title_metadata_is_accepted() {
        let doc = doc_with(vec![Block::Paragraph(para("제목"))]);
        let opts = PdfOptions {
            title: Some("My Doc".into()),
        };
        let out = export_pdf(&doc, &ApproxFontMetrics, &opts).unwrap();
        assert!(out.bytes.starts_with(b"%PDF-"));
    }

    #[test]
    fn unit_conversion_is_72pt_per_inch() {
        // 7200 HWPUNIT = 1 inch = 72 pt.
        assert!((pt(7200.0) - 72.0).abs() < 1e-3);
        assert!((pt(100.0) - 1.0).abs() < 1e-3);
    }

    #[test]
    fn glyph_color_maps_to_krilla_rgb_not_black() {
        // The PDF glyph path fills with `rgb_of(color)` — confirm a per-run color (not black) is what
        // flows to krilla. (krilla compresses the content stream, so we assert the conversion, which
        // is the load-bearing step: the run's CharShape.text_color reaches the fill paint.)
        let blue = Color {
            r: 0,
            g: 0,
            b: 0xFF,
            a: 0xFF,
        };
        let c = rgb_of(blue);
        // krilla rgb::Color is constructed from the same 8-bit channels — round-trip via a fresh ctor.
        assert_eq!(
            c,
            rgb::Color::new(0, 0, 0xFF),
            "blue run maps to krilla blue, not black"
        );
        assert_ne!(
            c,
            rgb::Color::black(),
            "color is not forced to black on the PDF path"
        );
    }

    #[test]
    fn injected_font_is_preferred_over_discover() {
        // Inject the vendored NanumGothic bytes; the export must embed the INJECTED face (font_path
        // "injected:…"), proving bytes thread through to krilla instead of the fs-discovered face.
        let bytes = std::fs::read(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../assets/fonts/NanumGothic-Regular.ttf"
        ))
        .expect("vendored NanumGothic present for the test");
        let doc = doc_with(vec![Block::Paragraph(para("한글 주입 폰트"))]);
        let injected = vec![("Nanum Gothic".to_string(), bytes)];
        let out =
            export_pdf_with_fonts(&doc, &ApproxFontMetrics, &PdfOptions::default(), &injected)
                .unwrap();
        assert!(out.bytes.starts_with(b"%PDF-"));
        assert_eq!(
            out.font_path.as_deref(),
            Some("injected:Nanum Gothic"),
            "injected face is preferred over discover"
        );
    }

    #[test]
    fn injected_serif_family_populates_the_serif_slot_and_keeps_gothic_body() {
        // Issue 058: injecting a gothic body + a serif-named face must (1) keep the gothic as the BODY
        // (first face → also backs metrics) and (2) load the serif-named face into the serif slot, so
        // 명조 glyphs (IR font = the serif substitute) draw with it. Bytes are the vendored NanumGothic
        // for both — routing is by family NAME (classify), not the bytes.
        let bytes = std::fs::read(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../assets/fonts/NanumGothic-Regular.ttf"
        ))
        .expect("vendored NanumGothic present for the test");
        let injected = vec![
            ("Nanum Gothic".to_string(), bytes.clone()),
            ("Nanum Myeongjo".to_string(), bytes.clone()),
        ];
        let embed = EmbedFont::from_injected(&injected).expect("body face parses");
        assert_eq!(
            embed.path, "injected:Nanum Gothic",
            "the gothic body is the first (metric-backing) face"
        );
        assert!(
            embed.serif.is_some(),
            "the serif-named injection populates the serif slot"
        );
        // A serif-only injection still yields a valid body (serif doubles as body).
        let serif_only = vec![("Nanum Myeongjo".to_string(), bytes)];
        let e2 = EmbedFont::from_injected(&serif_only).expect("serif-only still gives a body");
        assert!(e2.serif.is_some());
    }

    #[test]
    fn empty_injection_falls_back_to_discover_unchanged() {
        // An empty injection slice takes the pure-discover path — `export_pdf` and
        // `export_pdf_with_fonts(.., &[])` must produce byte-identical output (native path unchanged).
        let doc = doc_with(vec![Block::Paragraph(para("동일성 확인"))]);
        let a = export_pdf(&doc, &ApproxFontMetrics, &PdfOptions::default()).unwrap();
        let b =
            export_pdf_with_fonts(&doc, &ApproxFontMetrics, &PdfOptions::default(), &[]).unwrap();
        assert_eq!(
            a.bytes, b.bytes,
            "empty injection == discover, byte-identical"
        );
        assert_eq!(a.font_path, b.font_path);
    }

    /// A minimal 1x1 24bpp BMP (bottom-up, BI_RGB) with a single red pixel.
    fn tiny_bmp() -> Vec<u8> {
        let mut v = Vec::new();
        v.extend_from_slice(b"BM");
        v.extend_from_slice(&(54u32 + 4).to_le_bytes()); // file size (1px padded to 4 bytes)
        v.extend_from_slice(&0u32.to_le_bytes()); // reserved
        v.extend_from_slice(&54u32.to_le_bytes()); // pixel offset
        v.extend_from_slice(&40u32.to_le_bytes()); // DIB header size
        v.extend_from_slice(&1i32.to_le_bytes()); // width
        v.extend_from_slice(&1i32.to_le_bytes()); // height
        v.extend_from_slice(&1u16.to_le_bytes()); // planes
        v.extend_from_slice(&24u16.to_le_bytes()); // bpp
        v.extend_from_slice(&0u32.to_le_bytes()); // BI_RGB
        v.extend_from_slice(&0u32.to_le_bytes()); // image size
        v.extend_from_slice(&2835i32.to_le_bytes());
        v.extend_from_slice(&2835i32.to_le_bytes());
        v.extend_from_slice(&0u32.to_le_bytes()); // clr used
        v.extend_from_slice(&0u32.to_le_bytes()); // clr important
        v.extend_from_slice(&[0, 0, 255, 0]); // one BGR pixel (red) + 1 pad byte
        v
    }

    #[test]
    fn bmp_bin_decodes_to_a_real_image_not_stub() {
        // Issue [5]: a BMP `BinData` must decode to a krilla Image via our own decoder (no `from_bmp`),
        // so the PDF embeds a real XObject instead of the pre-fix empty stub box.
        let mut doc = doc_with(vec![Block::Paragraph(para("bmp"))]);
        doc.bin_data.push(BinData {
            bin_ref: "image1".into(),
            bytes: tiny_bmp(),
            kind: "bmp".into(),
        });
        assert!(
            decode_image("image1", &doc).is_some(),
            "a BMP decodes to a real image (not a stub)"
        );
    }

    #[test]
    fn corrupt_bmp_falls_back_to_stub() {
        // A truncated/garbage BMP declines decoding → `None`, so the caller keeps the honest stub box.
        let mut doc = doc_with(vec![Block::Paragraph(para("bmp"))]);
        doc.bin_data.push(BinData {
            bin_ref: "image1".into(),
            bytes: b"BMcorrupt".to_vec(),
            kind: "bmp".into(),
        });
        assert!(
            decode_image("image1", &doc).is_none(),
            "a corrupt BMP declines → stub fallback"
        );
    }

    #[test]
    fn mislabeled_bmp_is_sniffed_and_embedded() {
        // A BMP mislabeled with an unknown `kind` still embeds via magic-byte sniffing.
        let mut doc = doc_with(vec![Block::Paragraph(para("bmp"))]);
        doc.bin_data.push(BinData {
            bin_ref: "image1".into(),
            bytes: tiny_bmp(),
            kind: "dat".into(),
        });
        assert!(
            decode_image("image1", &doc).is_some(),
            "a mislabeled BMP is sniffed and embedded"
        );
    }

    #[test]
    fn blue_run_exports_a_pdf_without_panicking() {
        // End-to-end: a blue paragraph must export (glyph path is exercised with a non-black fill).
        let mut doc = doc_with(vec![Block::Paragraph(para("파란 글씨"))]);
        doc.char_shapes[0] = CharShape {
            text_color: Color {
                r: 0,
                g: 0,
                b: 0xFF,
                a: 0xFF,
            },
            ..Default::default()
        };
        let out = export_pdf(&doc, &ApproxFontMetrics, &PdfOptions::default()).unwrap();
        assert!(out.bytes.starts_with(b"%PDF-"));
        assert!(out.pages >= 1);
    }
}
