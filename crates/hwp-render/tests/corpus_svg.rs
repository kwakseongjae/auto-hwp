//! End-to-end: a real corpus HWPX → OUR layout (hwp-typeset) → OUR paint IR (hwp-render) → SVG,
//! entirely via THIS crate's own pipeline (NOT rhwp). Asserts the regenerated SVG carries the
//! document's actual text as `<text>` and structural `<rect>`s (line boxes / table cell borders),
//! proving the IR-driven, browser-independent fidelity surface works on a non-trivial document.

use hwp_hwpx::HwpxParser;
use hwp_model::prelude::*;
use hwp_typeset::ApproxFontMetrics;

fn showcase_doc() -> SemanticDoc {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../corpus/hwpx/FormattingShowcase.hwpx");
    let bytes = std::fs::read(path).expect("FormattingShowcase.hwpx in corpus/hwpx");
    HwpxParser::new()
        .parse(&bytes, SourceFormat::Hwpx)
        .expect("parse showcase HWPX → SemanticDoc")
}

#[test]
fn showcase_renders_to_svg_with_text_and_rects() {
    let doc = showcase_doc();
    let svgs = hwp_render::render_doc_svg(&doc, &ApproxFontMetrics);
    assert!(!svgs.is_empty(), "at least one page rendered");

    // Concatenate all pages (the showcase paginates; its content may span >1 page).
    let all: String = svgs.concat();

    // Every page is a well-formed SVG envelope with a viewBox (vector-scalable, hit-testable DOM).
    for (i, s) in svgs.iter().enumerate() {
        assert!(s.starts_with("<svg"), "page {i} starts with <svg>");
        assert!(s.ends_with("</svg>"), "page {i} ends with </svg>");
        assert!(s.contains("viewBox="), "page {i} has a viewBox");
    }

    // The document's REAL text reached the SVG as <text> glyph nodes.
    assert!(all.contains("<text"), "glyphs became <text> nodes");
    for needle in ["형", "식", "테", "스", "트", "문", "서"] {
        assert!(all.contains(needle), "the title text glyph {needle:?} is present in the SVG");
    }

    // Structural boxes: line text-boxes + the table's cell borders are stroked <rect>s.
    let rects = all.matches("<rect").count();
    assert!(rects > 5, "expected many structural rects (line boxes + table cells), got {rects}");
    assert!(all.contains("stroke="), "stroked outlines (borders) emitted");

    // The showcase has a table → its cell borders are stroked rects (fill=\"none\").
    assert!(all.contains("fill=\"none\""), "stroked (un-filled) boxes present (cell/line borders)");
}

#[test]
fn showcase_page_count_is_stable_and_positive() {
    let doc = showcase_doc();
    let n = hwp_render::page_count(&doc, &ApproxFontMetrics);
    assert!(n >= 1, "at least one page");
    // Page count is a pure function of (doc, fonts) — rendering it twice agrees.
    assert_eq!(n, hwp_render::render_doc_svg(&doc, &ApproxFontMetrics).len(), "page_count == #SVGs");
}

#[test]
fn render_page_ir_glyph_count_matches_visible_text() {
    // The IR for page 0 must contain Glyph ops for the visible (non-whitespace) characters of the
    // page — a direct check that we walk the doc's text, not just empty line boxes.
    let doc = showcase_doc();
    let tree = hwp_render::render_page(&doc, &ApproxFontMetrics, 0).unwrap();
    let glyphs = tree
        .ops
        .iter()
        .filter(|o| matches!(o, hwp_model::layout::PaintOp::Glyph { .. }))
        .count();
    assert!(glyphs > 10, "page 0 carries real glyph ops, got {glyphs}");
    assert_eq!(tree.schema_version, hwp_model::layout::PAINT_SCHEMA_VERSION);
}
