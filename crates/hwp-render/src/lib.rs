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
/// and shading become `<rect>`, images `<image>` (or a stub `<rect>` when the bytes/bin_ref are
/// unavailable). The result is real DOM: hit-testable + a vector export, regenerated from the IR.
///
/// Usage: `paint` every op of a page, then [`SvgSink::finish_page`] to take that page's SVG string
/// and reset for the next page. [`SvgSink::svg_for`] is a one-shot for a single [`PageLayerTree`].
#[derive(Default)]
pub struct SvgSink {
    body: String,
    width: f64,
    height: f64,
}

impl SvgSink {
    pub fn new() -> Self {
        Self::default()
    }

    /// Render a whole [`PageLayerTree`] to a standalone `<svg>` string in one call.
    pub fn svg_for(tree: &PageLayerTree) -> String {
        let mut s = SvgSink::new();
        s.begin_page(tree.width, tree.height);
        for op in &tree.ops {
            s.paint(op);
        }
        s.finish_page()
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

impl PaintSink for SvgSink {
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
                self.body.push_str(&format!(
                    "<text x=\"{x:.2}\" y=\"{y:.2}\" font-size=\"{sz:.2}\" fill=\"{fill}\">{s}</text>",
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
                // No data-URI embedding yet (that needs the BinData bytes threaded in) — emit a stub
                // box tagged with the bin_ref so the slot is visible + hit-testable.
                self.body.push_str(&format!(
                    "<rect x=\"{x:.2}\" y=\"{y:.2}\" width=\"{w:.2}\" height=\"{h:.2}\" \
                     fill=\"#F0F0F0\" stroke=\"#999999\" stroke-width=\"0.5\" data-bin-ref=\"{r}\"/>",
                    x = px(*x), y = px(*y), w = px(*w), h = px(*h), r = esc(bin_ref),
                ));
            }
        }
    }
}

/// `Color` → `#RRGGBB` for SVG (opaque; alpha not yet surfaced in the paint IR).
fn color_hex(c: Color) -> String {
    c.to_hex()
}

/// Render every page of `doc` to a vector of standalone `<svg>` strings via our own pipeline.
pub fn render_doc_svg(doc: &SemanticDoc, fonts: &dyn FontMetricsProvider) -> Vec<String> {
    place_doc(doc, fonts)
        .pages
        .iter()
        .map(|pg| SvgSink::svg_for(&lower_page(pg)))
        .collect()
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
        let svg = SvgSink::svg_for(&tree);
        assert!(svg.contains("data-bin-ref=\"img1\""), "image box tagged with its bin_ref");
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
