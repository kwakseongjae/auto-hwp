//! Our own renderer — the browser-independent fidelity surface.
//!
//! Pipeline: a laid-out [`SemanticDoc`] (paginated + positioned by [`hwp_typeset::place_doc`]) →
//! [`PaintOp`]s in a [`PageLayerTree`] (paint IR, schemaVersion 1) → a [`PaintSink`] backend. The IR
//! is the contract; this crate ships one real producer ([`render_page`]) and one real sink
//! ([`SvgSink`] → one `<svg>` per page). Both replay the SAME IR, so screen == export.
//!
//! Why our own (no rhwp here): the IR is regenerated from the model, so an EDITED document renders
//! faithfully (the rhwp SVG path is faithful only for the unedited original — issue #196). The SVG
//! is real DOM (`<text>`/`<tspan>`/`<rect>`/`<image>`), giving hit-testing + vector export for free.
//!
//! [`NullRenderer`] (the trait scaffold) stays as a structural fallback that only knows the bare
//! [`LayoutResult`] (no glyph text); prefer [`render_page`], which walks the doc for real glyphs.

use base64::Engine as _;
use hwp_model::document::BinData;
use hwp_model::prelude::*;
use hwp_model::types::Color;
use hwp_typeset::{place_doc, PlacedPage};

// ---- Real renderer: SemanticDoc + placed layout → PageLayerTree (paint IR) ----

/// Render ONE page of `doc` to a [`PageLayerTree`] (paint IR), driving our own paginator/placer
/// ([`hwp_typeset::place_doc`]) over the injected `fonts`. The returned tree's `ops` are, in paint
/// order: cell/line border `Rect`s + shading fills, image boxes, then glyph runs on top.
///
/// `page` is 0-based; out-of-range yields `Err`. Under the `shaper` feature the glyph x-positions
/// come from real (rustybuzz) advances; otherwise the per-script approximation.
pub fn render_page(
    doc: &SemanticDoc,
    fonts: &dyn FontMetricsProvider,
    page: usize,
) -> Result<PageLayerTree> {
    let placed = place_doc(doc, fonts);
    let pg = placed
        .pages
        .get(page)
        .ok_or_else(|| Error::Other(format!("page {page} out of range ({} pages)", placed.pages.len())))?;
    Ok(lower_page(pg))
}

/// Number of pages our own paginator produces for `doc` (so a caller can loop `render_page`).
pub fn page_count(doc: &SemanticDoc, fonts: &dyn FontMetricsProvider) -> usize {
    place_doc(doc, fonts).pages.len()
}

/// Lower one positioned page into the paint IR. Order matters for correct overdraw: shading fills
/// and borders first (background), then images, then glyphs on top.
fn lower_page(pg: &PlacedPage) -> PageLayerTree {
    let mut ops: Vec<PaintOp> = Vec::with_capacity(pg.rects.len() + pg.images.len() + pg.glyphs.len());

    // 1) Fills (shading) first so borders/text sit above them.
    for r in pg.rects.iter().filter(|r| r.fill.is_some()) {
        ops.push(PaintOp::Rect { x: r.x, y: r.y, w: r.w, h: r.h, fill: r.fill });
    }
    // 2) Stroked boxes (cell/line borders).
    for r in pg.rects.iter().filter(|r| r.fill.is_none()) {
        ops.push(PaintOp::Rect { x: r.x, y: r.y, w: r.w, h: r.h, fill: None });
    }
    // 3) Images / object boxes.
    for im in &pg.images {
        ops.push(PaintOp::Image { x: im.x, y: im.y, w: im.w, h: im.h, bin_ref: im.bin_ref.clone() });
    }
    // 4) Glyphs (y = baseline).
    for g in &pg.glyphs {
        ops.push(PaintOp::Glyph { x: g.x, y: g.baseline, ch: g.ch, size: g.size, color: g.color });
    }

    PageLayerTree { schema_version: PAINT_SCHEMA_VERSION, width: pg.width, height: pg.height, ops }
}

/// Replay every page of `doc` through a [`PaintSink`], page by page. Convenience over the IR for a
/// backend that wants the whole document (e.g. accumulating an SVG per page). Returns one tree per
/// page so a caller can also keep the IR.
pub fn render_doc<S: PaintSink>(
    doc: &SemanticDoc,
    fonts: &dyn FontMetricsProvider,
    sink: &mut S,
) -> Vec<PageLayerTree> {
    let placed = place_doc(doc, fonts);
    placed
        .pages
        .iter()
        .map(|pg| {
            let tree = lower_page(pg);
            for op in &tree.ops {
                sink.paint(op);
            }
            tree
        })
        .collect()
}

// ---- Trait scaffold (structural fallback over the bare LayoutResult) ----

/// The trait-level renderer. It only sees the bare [`LayoutResult`] (line boxes, NO glyph text), so
/// it emits a structural skeleton: one stroked `Rect` per line box. For real glyph paint use the
/// free function [`render_page`] (it walks the [`SemanticDoc`] for the actual characters).
#[derive(Default)]
pub struct NullRenderer;

impl Renderer for NullRenderer {
    fn page_layer_tree(&self, layout: &LayoutResult, page: usize) -> Result<PageLayerTree> {
        let p = layout.pages.get(page).ok_or(Error::Other("page out of range".into()))?;
        let ops = p
            .lines
            .iter()
            .map(|ls| PaintOp::Rect {
                x: ls.horz_pos,
                y: ls.vert_pos,
                w: ls.horz_size.max(1.0),
                h: ls.vert_size,
                fill: None,
            })
            .collect();
        Ok(PageLayerTree { schema_version: PAINT_SCHEMA_VERSION, width: p.width, height: p.height, ops })
    }
}

/// A trivial sink that counts paint ops — useful for tests/diagnostics.
#[derive(Default)]
pub struct CountingSink {
    pub count: usize,
}

impl PaintSink for CountingSink {
    fn paint(&mut self, _op: &PaintOp) {
        self.count += 1;
    }
}

// ---- SVG sink: PageLayerTree → one <svg> per page ----

/// HWPUNIT per CSS px at 96 DPI (1 inch = 7200 HWPUNIT = 96 px → 75 HWPUNIT/px). The SVG `viewBox`
/// is in px so the page renders at a sane on-screen size; coordinates divide by this.
const HWPUNIT_PER_PX: f64 = 7200.0 / 96.0;

/// A [`PaintSink`] that accumulates one `<svg>` document per page from the paint IR. Text becomes
/// `<text>` with per-glyph `x` (no kerning guesswork — we position each glyph ourselves), borders
/// and shading become `<rect>`, images `<image href="data:…">` when the real bytes are available
/// (resolved through [`SvgSink::with_bins`]) — else a stub `<rect>` (equation/missing/unbacked slot).
/// The result is real DOM: hit-testable + a vector export, regenerated from the IR.
///
/// Usage: `paint` every op of a page, then [`SvgSink::finish_page`] to take that page's SVG string
/// and reset for the next page. [`SvgSink::svg_for`] is a one-shot for a single [`PageLayerTree`].
/// To embed real photos, build with [`SvgSink::with_bins`] (passing `&doc.bin_data`).
#[derive(Default)]
pub struct SvgSink<'a> {
    body: String,
    width: f64,
    height: f64,
    /// Document `BinData` for resolving an `Image`'s `bin_ref` → bytes → a `data:` URI. `None`/empty
    /// keeps the light stub box (the original behaviour, used by the trait/diagnostic callers).
    bins: Option<&'a [BinData]>,
}

impl<'a> SvgSink<'a> {
    pub fn new() -> Self {
        Self::default()
    }

    /// Build a sink that resolves `Image` ops against `bins` (`&doc.bin_data`) so real photos embed as
    /// `<image href="data:…">`. Slots with no matching/decodable bytes still fall back to a stub box.
    pub fn with_bins(bins: &'a [BinData]) -> Self {
        SvgSink { bins: Some(bins), ..Default::default() }
    }

    /// Render a whole [`PageLayerTree`] to a standalone `<svg>` string in one call (no image bytes —
    /// image ops become stub boxes). Use [`SvgSink::svg_for_with_bins`] to embed real photos.
    pub fn svg_for(tree: &PageLayerTree) -> String {
        SvgSink::new().render(tree)
    }

    /// Like [`SvgSink::svg_for`] but resolves image `bin_ref`s against `bins` (`&doc.bin_data`) so the
    /// real photo bytes embed as a `data:` URI.
    pub fn svg_for_with_bins(tree: &PageLayerTree, bins: &'a [BinData]) -> String {
        SvgSink::with_bins(bins).render(tree)
    }

    /// Paint one whole [`PageLayerTree`] and return its `<svg>` string (shared by the `svg_for*` paths).
    fn render(mut self, tree: &PageLayerTree) -> String {
        self.begin_page(tree.width, tree.height);
        for op in &tree.ops {
            self.paint(op);
        }
        self.finish_page()
    }

    /// Start a fresh page of the given size (HWPUNIT). Resets any accumulated body.
    pub fn begin_page(&mut self, width: f64, height: f64) {
        self.body.clear();
        self.width = width;
        self.height = height;
    }

    /// Close the current page and return its `<svg>` document, resetting for the next page.
    pub fn finish_page(&mut self) -> String {
        let w_px = self.width / HWPUNIT_PER_PX;
        let h_px = self.height / HWPUNIT_PER_PX;
        let svg = format!(
            "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{w:.2}\" height=\"{h:.2}\" \
             viewBox=\"0 0 {w:.2} {h:.2}\">\
             <rect x=\"0\" y=\"0\" width=\"{w:.2}\" height=\"{h:.2}\" fill=\"#FFFFFF\"/>\
             {body}</svg>",
            w = w_px,
            h = h_px,
            body = self.body,
        );
        self.body.clear();
        svg
    }
}

/// HWPUNIT → px for SVG coordinates.
fn px(v: f64) -> f64 {
    v / HWPUNIT_PER_PX
}

/// XML-escape text/attribute content (`&`, `<`, `>`, `"`).
fn esc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            _ => out.push(c),
        }
    }
    out
}

impl PaintSink for SvgSink<'_> {
    fn paint(&mut self, op: &PaintOp) {
        match op {
            PaintOp::Glyph { x, y, ch, size, color } => {
                // One <text> per glyph: we own the x, so no font-kerning surprise. Skip whitespace.
                if ch.is_whitespace() {
                    return;
                }
                let fill = color_hex(*color);
                let mut buf = [0u8; 4];
                let s = esc(ch.encode_utf8(&mut buf));
                // font-family pins the bundled free face (NanumGothic, @font-face'd in the app's
                // styles.css) so the webview draws the SAME glyph shapes our metrics assume — not the
                // platform default (AppleGothic/serif). sans-serif is the graceful fallback.
                self.body.push_str(&format!(
                    "<text x=\"{x:.2}\" y=\"{y:.2}\" font-size=\"{sz:.2}\" \
                     font-family=\"NanumGothic, sans-serif\" fill=\"{fill}\">{s}</text>",
                    x = px(*x),
                    y = px(*y),
                    sz = px(*size),
                ));
            }
            PaintOp::Rect { x, y, w, h, fill } => match fill {
                Some(c) => self.body.push_str(&format!(
                    "<rect x=\"{x:.2}\" y=\"{y:.2}\" width=\"{w:.2}\" height=\"{h:.2}\" fill=\"{f}\"/>",
                    x = px(*x), y = px(*y), w = px(*w), h = px(*h), f = color_hex(*c),
                )),
                None => self.body.push_str(&format!(
                    "<rect x=\"{x:.2}\" y=\"{y:.2}\" width=\"{w:.2}\" height=\"{h:.2}\" \
                     fill=\"none\" stroke=\"#000000\" stroke-width=\"0.5\"/>",
                    x = px(*x), y = px(*y), w = px(*w), h = px(*h),
                )),
            },
            PaintOp::Image { x, y, w, h, bin_ref } => {
                // Resolve the bin_ref → real bytes (when a sink was built `with_bins`) → a data: URI so
                // the actual photo renders. preserveAspectRatio="none" matches the placed box exactly,
                // like an HWP image frame. Fall back to the light stub when the bytes are absent or the
                // kind isn't a known raster (equation/OLE/missing) — the slot stays visible + tagged.
                let href = self
                    .bins
                    .and_then(|bins| image_data_uri(bins, bin_ref));
                match href {
                    // `href` first (right after `<image`) so the standard `<image href="data:` grep
                    // matches; preserveAspectRatio="none" fits the box like an HWP image frame.
                    Some(uri) => self.body.push_str(&format!(
                        "<image href=\"{uri}\" x=\"{x:.2}\" y=\"{y:.2}\" width=\"{w:.2}\" height=\"{h:.2}\" \
                         preserveAspectRatio=\"none\" data-bin-ref=\"{r}\"/>",
                        x = px(*x), y = px(*y), w = px(*w), h = px(*h), r = esc(bin_ref),
                    )),
                    None => self.body.push_str(&format!(
                        "<rect x=\"{x:.2}\" y=\"{y:.2}\" width=\"{w:.2}\" height=\"{h:.2}\" \
                         fill=\"#F0F0F0\" stroke=\"#999999\" stroke-width=\"0.5\" data-bin-ref=\"{r}\"/>",
                        x = px(*x), y = px(*y), w = px(*w), h = px(*h), r = esc(bin_ref),
                    )),
                }
            }
        }
    }
}

/// `Color` → `#RRGGBB` for SVG (opaque; alpha not yet surfaced in the paint IR).
fn color_hex(c: Color) -> String {
    c.to_hex()
}

/// Resolve an image `bin_ref` against `bins` (`&doc.bin_data`) to a `data:<mime>;base64,<…>` URI for
/// an SVG `<image href>`. `None` when the ref is empty/missing or the bytes aren't a known raster
/// (equation/OLE/unknown) — the sink then draws a stub box. Mirrors the krilla PDF path's kind +
/// magic-byte detection so the SVG and PDF agree on which slots embed.
fn image_data_uri(bins: &[BinData], bin_ref: &str) -> Option<String> {
    if bin_ref.is_empty() {
        return None;
    }
    let bin = bins.iter().find(|b| b.bin_ref == bin_ref)?;
    if bin.bytes.is_empty() {
        return None;
    }
    let mime = image_mime(&bin.kind, &bin.bytes)?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bin.bytes);
    Some(format!("data:{mime};base64,{b64}"))
}

/// Pick the `image/*` MIME for embedding: trust a known declared `kind` first, else sniff the magic
/// bytes (a mislabeled raster still embeds). `None` for non-raster (OLE/equation/unknown) kinds.
fn image_mime(kind: &str, bytes: &[u8]) -> Option<&'static str> {
    match kind.to_ascii_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "bmp" => Some("image/bmp"),
        "webp" => Some("image/webp"),
        // Unknown/unhelpful kind: sniff the leading bytes.
        _ => sniff_mime(bytes),
    }
}

/// Best-effort magic-byte sniff → `image/*` MIME for a raster whose declared kind was unhelpful.
fn sniff_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        Some("image/png")
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF8") {
        Some("image/gif")
    } else if bytes.starts_with(b"BM") {
        Some("image/bmp")
    } else if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

/// Render every page of `doc` to a vector of standalone `<svg>` strings via our own pipeline. Real
/// image bytes embed as `<image href="data:…">` (resolved through `doc.bin_data`); equation/missing
/// objects keep the light stub box.
pub fn render_doc_svg(doc: &SemanticDoc, fonts: &dyn FontMetricsProvider) -> Vec<String> {
    place_doc(doc, fonts)
        .pages
        .iter()
        .map(|pg| SvgSink::svg_for_with_bins(&lower_page(pg), &doc.bin_data))
        .collect()
}

/// Lower `doc` to one [`PageLayerTree`] (paint IR) per page via our own paginator/placer — WITHOUT a
/// sink. This is the backend-agnostic entry: an SVG, PDF (krilla), or canvas consumer replays the
/// SAME trees, so every export matches own-render. (The SVG sink uses this under the hood via
/// [`render_doc_svg`]; PDF export in `hwp-export` consumes these directly.)
pub fn render_doc_trees(doc: &SemanticDoc, fonts: &dyn FontMetricsProvider) -> Vec<PageLayerTree> {
    place_doc(doc, fonts).pages.iter().map(lower_page).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use hwp_typeset::ApproxFontMetrics;

    fn para(text: &str) -> Paragraph {
        Paragraph {
            runs: vec![Run { char_shape: 0, content: vec![Inline::Text(text.into())], ..Default::default() }],
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
    fn render_page_emits_glyph_ops() {
        let doc = doc_with(vec![Block::Paragraph(para("가나"))]);
        let tree = render_page(&doc, &ApproxFontMetrics, 0).unwrap();
        let glyphs = tree.ops.iter().filter(|o| matches!(o, PaintOp::Glyph { .. })).count();
        assert_eq!(glyphs, 2, "two glyph ops");
        assert_eq!(tree.schema_version, PAINT_SCHEMA_VERSION);
        assert!(tree.width > 0.0 && tree.height > 0.0);
    }

    #[test]
    fn out_of_range_page_errors() {
        let doc = doc_with(vec![Block::Paragraph(para("x"))]);
        assert!(render_page(&doc, &ApproxFontMetrics, 99).is_err());
    }

    #[test]
    fn svg_contains_text_and_a_rect() {
        let doc = doc_with(vec![Block::Paragraph(para("문서"))]);
        let svg = render_doc_svg(&doc, &ApproxFontMetrics);
        assert_eq!(svg.len(), 1, "one page");
        let s = &svg[0];
        assert!(s.starts_with("<svg") && s.ends_with("</svg>"), "well-formed svg envelope");
        assert!(s.contains("<text"), "glyphs become <text>");
        assert!(s.contains('문') && s.contains('서'), "the actual text is present");
        assert!(s.contains("<rect"), "line boxes / page background become <rect>");
        assert!(s.contains("viewBox="), "has a viewBox for vector scaling");
    }

    #[test]
    fn svg_escapes_xml_special_chars() {
        let doc = doc_with(vec![Block::Paragraph(para("a<b&c"))]);
        let svg = render_doc_svg(&doc, &ApproxFontMetrics);
        let s = &svg[0];
        assert!(s.contains("&lt;") && s.contains("&amp;"), "XML-special glyphs are escaped");
        assert!(!s.contains("<b&c"), "no raw < or & leaks into the document");
    }

    #[test]
    fn text_color_flows_to_svg_fill() {
        let mut doc = doc_with(vec![Block::Paragraph(para("색"))]);
        // Make the run red.
        doc.char_shapes[0] = CharShape { text_color: Color::from_hex("#C00000").unwrap(), ..Default::default() };
        let svg = render_doc_svg(&doc, &ApproxFontMetrics);
        assert!(svg[0].contains("fill=\"#C00000\""), "glyph fill carries the run's text color");
    }

    #[test]
    fn cell_text_color_flows_to_svg_fill() {
        // The guide text in gov tables is BLUE — confirm a cell run's text color reaches the SVG fill
        // through the recursive cell-glyph build (not just body paragraphs).
        let mut t = Table { rows: 1, cols: 1, ..Default::default() };
        t.cells.push(Cell { row: 0, col: 0, blocks: vec![Block::Paragraph(para("안내"))], ..Default::default() });
        let mut doc = doc_with(vec![Block::Table(t)]);
        doc.char_shapes[0] = CharShape { text_color: Color::from_hex("#0000FF").unwrap(), ..Default::default() };
        let svg = render_doc_svg(&doc, &ApproxFontMetrics);
        assert!(svg[0].contains("fill=\"#0000FF\""), "cell glyph fill carries the run's blue text color");
    }

    #[test]
    fn image_paragraph_emits_image_box() {
        let mut p = Paragraph::default();
        p.runs.push(Run {
            char_shape: 0,
            content: vec![Inline::Image(ImageRef { bin_ref: "img1".into(), width: 10000, height: 8000 })],
            ..Default::default()
        });
        let doc = doc_with(vec![Block::Paragraph(p)]);
        let tree = render_page(&doc, &ApproxFontMetrics, 0).unwrap();
        assert!(tree.ops.iter().any(|o| matches!(o, PaintOp::Image { bin_ref, .. } if bin_ref == "img1")));
        // No bytes available → a tagged stub box (the slot is still visible + hit-testable).
        let svg = SvgSink::svg_for(&tree);
        assert!(svg.contains("data-bin-ref=\"img1\""), "image box tagged with its bin_ref");
        assert!(svg.contains("fill=\"#F0F0F0\""), "falls back to the stub when no bytes are threaded");
        assert!(!svg.contains("<image "), "no <image> element without real bytes");
    }

    /// A 1x1 PNG (valid magic + minimal IHDR/IDAT/IEND) — enough to drive the data-URI embed path.
    const TINY_PNG: &[u8] = &[
        0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, b'I', b'H', b'D', b'R',
        0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F, 0x15, 0xC4,
        0x89, 0x00, 0x00, 0x00, 0x0A, b'I', b'D', b'A', b'T', 0x78, 0x9C, 0x63, 0x00, 0x01, 0x00, 0x00,
        0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, b'I', b'E', b'N', b'D', 0xAE,
        0x42, 0x60, 0x82,
    ];

    #[test]
    fn image_embeds_real_bytes_as_data_uri() {
        // When the doc carries the bin bytes, the SVG sink resolves bin_ref → a <image href="data:…">.
        let mut p = Paragraph::default();
        p.runs.push(Run {
            char_shape: 0,
            content: vec![Inline::Image(ImageRef { bin_ref: "photo".into(), width: 10000, height: 8000 })],
            ..Default::default()
        });
        let mut doc = doc_with(vec![Block::Paragraph(p)]);
        doc.bin_data.push(BinData { bin_ref: "photo".into(), bytes: TINY_PNG.to_vec(), kind: "png".into() });
        let svg = render_doc_svg(&doc, &ApproxFontMetrics);
        let s = &svg[0];
        assert!(s.contains("<image "), "real bytes render as an <image> element");
        assert!(s.contains("href=\"data:image/png;base64,"), "embedded as a base64 PNG data URI");
        assert!(s.contains("data-bin-ref=\"photo\""), "still tagged with the bin_ref");
        assert!(!s.contains("fill=\"#F0F0F0\""), "no stub box when real bytes embed");
    }

    #[test]
    fn image_falls_back_to_stub_for_non_raster_bytes() {
        // An OLE/equation object (non-raster bytes) keeps the light stub box even when present.
        let mut p = Paragraph::default();
        p.runs.push(Run {
            char_shape: 0,
            content: vec![Inline::Image(ImageRef { bin_ref: "eq".into(), width: 10000, height: 8000 })],
            ..Default::default()
        });
        let mut doc = doc_with(vec![Block::Paragraph(p)]);
        doc.bin_data.push(BinData { bin_ref: "eq".into(), bytes: vec![0x01, 0x02, 0x03, 0x04], kind: "ole".into() });
        let svg = render_doc_svg(&doc, &ApproxFontMetrics);
        let s = &svg[0];
        assert!(!s.contains("<image "), "non-raster bytes don't embed");
        assert!(s.contains("fill=\"#F0F0F0\""), "they keep the stub box");
        assert!(s.contains("data-bin-ref=\"eq\""), "stub still tagged");
    }

    #[test]
    fn counting_sink_counts_every_op() {
        let doc = doc_with(vec![Block::Paragraph(para("가나다"))]);
        let mut c = CountingSink::default();
        let trees = render_doc(&doc, &ApproxFontMetrics, &mut c);
        let total: usize = trees.iter().map(|t| t.ops.len()).sum();
        assert_eq!(c.count, total, "the sink saw every op");
        assert!(c.count >= 3, "at least the three glyphs");
    }

    #[test]
    fn null_renderer_still_emits_line_boxes() {
        // The trait scaffold falls back to one stroked rect per line box.
        let doc = doc_with(vec![Block::Paragraph(para("가나다"))]);
        let layout = NaiveLayoutShim::layout(&doc);
        let tree = NullRenderer.page_layer_tree(&layout, 0).unwrap();
        assert!(tree.ops.iter().all(|o| matches!(o, PaintOp::Rect { fill: None, .. })));
        assert!(!tree.ops.is_empty(), "one rect per line");
    }

    /// Tiny shim so the NullRenderer test doesn't depend on hwp-typeset's LayoutEngine import path.
    struct NaiveLayoutShim;
    impl NaiveLayoutShim {
        fn layout(doc: &SemanticDoc) -> LayoutResult {
            hwp_typeset::NaiveLayout.layout(doc, &ApproxFontMetrics).unwrap()
        }
    }
}
