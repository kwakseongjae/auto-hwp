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

use hwp_model::document::SemanticDoc;
use hwp_model::layout::{PageLayerTree, PaintOp};
use hwp_model::prelude::FontMetricsProvider;
use hwp_model::types::Color;

use krilla::color::rgb;
use krilla::geom::{PathBuilder, Point, Rect};
use krilla::num::NormalizedF32;
use krilla::page::PageSettings;
use krilla::paint::{Fill, Stroke};
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
    (concat!(env!("CARGO_MANIFEST_DIR"), "/../../assets/fonts/NanumGothic-Regular.ttf"), 0),
    ("/System/Library/Fonts/Supplemental/AppleGothic.ttf", 0),
    ("/System/Library/Fonts/Supplemental/AppleMyungjo.ttf", 0),
    ("/System/Library/Fonts/AppleSDGothicNeo.ttc", 0),
    ("/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc", 0),
    ("/usr/share/fonts/opentype/noto/NotoSansCJKkr-Regular.otf", 0),
    ("/usr/share/fonts/truetype/nanum/NanumGothic.ttf", 0),
    // Vendored in hwp-typeset (drop a Noto Sans KR there to make CI deterministic).
    (
        concat!(env!("CARGO_MANIFEST_DIR"), "/../hwp-typeset/assets/NotoSansKR-Regular.ttf"),
        0,
    ),
];

/// A loaded text face for embedding, paired with the path it came from (diagnostics) and whether it
/// is a real Korean-capable face vs. a last-resort fallback.
struct EmbedFont {
    font: Font,
    path: String,
    /// True when a candidate from [`FONT_CANDIDATES`] loaded (Korean-capable). False = no font found
    /// (glyphs become stub rects so the box stays visible).
    real: bool,
}

impl EmbedFont {
    /// Load the first parseable candidate as a krilla [`Font`]. `None` only if NO candidate exists on
    /// this machine — callers then render glyphs as stub boxes (never panic).
    fn discover() -> Option<EmbedFont> {
        for &(path, index) in FONT_CANDIDATES {
            let Ok(bytes) = std::fs::read(path) else { continue };
            if let Some(font) = Font::new(bytes.into(), index) {
                return Some(EmbedFont { font, path: path.to_string(), real: true });
            }
        }
        None
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
/// subset of the discovered face. Returns the bytes + page count + the embedded font path.
pub fn export_pdf(
    doc: &SemanticDoc,
    fonts: &dyn FontMetricsProvider,
    opts: &PdfOptions,
) -> Result<PdfExport, String> {
    // One PageLayerTree per page from our own pipeline — the SAME IR the SVG sink replays.
    let trees = hwp_render::render_doc_trees(doc, fonts);
    let embed = EmbedFont::discover();

    let mut document = Document::new();
    if let Some(title) = &opts.title {
        let mut meta = krilla::metadata::Metadata::new();
        meta = meta.title(title.clone());
        document.set_metadata(meta);
    }

    for tree in &trees {
        lower_tree_to_page(&mut document, tree, doc, embed.as_ref());
    }

    let bytes = document.finish().map_err(|e| format!("krilla finish: {e:?}"))?;
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
            PaintOp::Image { x, y, w, h, bin_ref } => {
                paint_image(&mut surface, *x, *y, *w, *h, bin_ref, doc);
            }
            PaintOp::Glyph { x, y, ch, size, color } => {
                paint_glyph(&mut surface, *x, *y, *ch, *size, *color, embed);
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
/// (cell/line border). Mirrors the SVG sink's stroke width (0.5px ≈ 0.375pt) scaled to points.
fn paint_rect(surface: &mut krilla::surface::Surface, x: f64, y: f64, w: f64, h: f64, fill: Option<Color>) {
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
                width: 0.375,
                ..Default::default()
            }));
            surface.draw_path(&path);
        }
    }
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
        paint_rect(surface, x, y, w, h, Some(Color { r: 0xF0, g: 0xF0, b: 0xF0, a: 0xFF }));
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
        // Unknown kind: sniff the magic bytes so a mislabeled raster still embeds.
        // NOTE: BMP isn't natively decodable by krilla (no `from_bmp`); a BMP draws a stub box in PDF
        // even though the SVG sink embeds it as data:image/bmp (WebView renders BMP). Parity TODO:
        // decode BMP → rgba8 and use `Image::from_rgba8` to close this gap.
        _ => sniff_image(&bin.bytes),
    }
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
    } else {
        None
    }
}

/// Paint ONE glyph as real text at its exact baseline position. We own the x (each glyph is drawn at
/// its placed advance), so per-glyph drawing keeps the kerning faithful to our layout. When no font is
/// available, fall back to a small stub box so the glyph slot stays visible. Whitespace draws nothing.
fn paint_glyph(
    surface: &mut krilla::surface::Surface,
    x: f64,
    y: f64,
    ch: char,
    size: f64,
    color: Color,
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
            let mut buf = [0u8; 4];
            let s = ch.encode_utf8(&mut buf);
            // y is the baseline in our IR; krilla's draw_text `start` is the text baseline too.
            surface.draw_text(
                Point::from_xy(pt(x), pt(y)),
                f.font.clone(),
                pt(size),
                s,
                false,
                TextDirection::Auto,
            );
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
        let mut sec = Section::default();
        sec.blocks = blocks;
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
        assert!(out.bytes.ends_with(b"%%EOF") || out.bytes.windows(5).any(|w| w == b"%%EOF"),
            "PDF has an EOF marker");
        assert!(out.pages >= 1, "at least one page");
        assert!(out.bytes.len() > 400, "non-trivial PDF size, got {}", out.bytes.len());
    }

    #[test]
    fn empty_doc_still_makes_a_pdf() {
        let doc = doc_with(vec![Block::Paragraph(para(""))]);
        let out = export_pdf(&doc, &ApproxFontMetrics, &PdfOptions::default()).unwrap();
        assert!(out.bytes.starts_with(b"%PDF-"));
        assert!(out.pages >= 1);
    }

    #[test]
    fn title_metadata_is_accepted() {
        let doc = doc_with(vec![Block::Paragraph(para("제목"))]);
        let opts = PdfOptions { title: Some("My Doc".into()) };
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
        let blue = Color { r: 0, g: 0, b: 0xFF, a: 0xFF };
        let c = rgb_of(blue);
        // krilla rgb::Color is constructed from the same 8-bit channels — round-trip via a fresh ctor.
        assert_eq!(c, rgb::Color::new(0, 0, 0xFF), "blue run maps to krilla blue, not black");
        assert_ne!(c, rgb::Color::black(), "color is not forced to black on the PDF path");
    }

    #[test]
    fn blue_run_exports_a_pdf_without_panicking() {
        // End-to-end: a blue paragraph must export (glyph path is exercised with a non-black fill).
        let mut doc = doc_with(vec![Block::Paragraph(para("파란 글씨"))]);
        doc.char_shapes[0] = CharShape {
            text_color: Color { r: 0, g: 0, b: 0xFF, a: 0xFF },
            ..Default::default()
        };
        let out = export_pdf(&doc, &ApproxFontMetrics, &PdfOptions::default()).unwrap();
        assert!(out.bytes.starts_with(b"%PDF-"));
        assert!(out.pages >= 1);
    }
}
