//! Issue 024 regression — the 자가진단표 (self-diagnosis frame) must not silently drop or overflow its
//! text, and its final line "중소벤처기업진흥공단 이사장 귀하" must sit INSIDE the outer 상자 (frame box).
//!
//! Context: the frame is a 1×1 wrapper table whose single cell holds a 17×3 nested grid; the last row
//! (r16) is one big cell with 11 stacked paragraphs ending in "…이사장 귀하". The cell placer used to
//! DRAW each paragraph at its full line-spacing advance while the reserve trimmed each paragraph's
//! trailing leading, so a multi-paragraph cell drifted ~1278 HWPUNIT and pushed 귀하 BELOW the box.
//! (The earlier "귀하 0건" report was a grep artifact: own-render emits ONE <text> element per glyph, so
//! the substring "귀하" never appears in the raw SVG — this test reconstructs text from glyph positions.)
//!
//! This guards BOTH facets forever: (1) 무소실 — the exact sequence survives in the own-render output;
//! (2) containment — its baseline is within the frame's placed box.
#![cfg(all(feature = "rhwp", feature = "shaper"))]

use hwp_model::prelude::*;
use hwp_typeset::{place_doc, PlacedPage, RealFontMetrics};

fn benchmark1() -> SemanticDoc {
    let bytes = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/../../benchmarks/benchmark1.hwp"))
        .expect("benchmarks/benchmark1.hwp");
    hwp_rhwp::parse_to_semantic_guarded(&bytes).expect("lift benchmark1")
}

/// Reconstruct a page's visible text by grouping glyphs into lines (rounded baseline) and sorting each
/// line left→right — the ONLY correct way to search own-render output for a multi-glyph string.
fn page_text(pg: &PlacedPage) -> String {
    let mut lines: std::collections::BTreeMap<i64, Vec<(f64, char)>> = Default::default();
    for g in &pg.glyphs {
        lines.entry((g.baseline / 60.0).round() as i64).or_default().push((g.x, g.ch));
    }
    let mut out = String::new();
    for (_, mut v) in lines {
        v.sort_by(|a, b| a.0.total_cmp(&b.0));
        out.extend(v.into_iter().map(|(_, c)| c));
        out.push('\n');
    }
    out
}

/// Max baseline of the glyph run spelling `needle` (spaces ignored) on this page, if present.
fn baseline_of_sequence(pg: &PlacedPage, needle: &str) -> Option<f64> {
    let want: Vec<char> = needle.chars().filter(|c| !c.is_whitespace()).collect();
    // Group by line, sort by x, then scan each line for the (space-stripped) subsequence.
    let mut lines: std::collections::BTreeMap<i64, Vec<(f64, char)>> = Default::default();
    for g in &pg.glyphs {
        lines.entry((g.baseline / 60.0).round() as i64).or_default().push((g.x, g.ch));
    }
    for (bl, mut v) in lines {
        v.sort_by(|a, b| a.0.total_cmp(&b.0));
        let chars: Vec<char> = v.iter().map(|(_, c)| *c).filter(|c| !c.is_whitespace()).collect();
        if chars.windows(want.len()).any(|w| w == want.as_slice()) {
            return Some(bl as f64 * 60.0);
        }
    }
    None
}

#[test]
fn self_diag_guiha_is_not_dropped_and_stays_inside_the_frame_box() {
    let doc = benchmark1();
    let fonts = RealFontMetrics::new();
    let placed = place_doc(&doc, &fonts);

    // (1) 무소실: the exact final line survives SOMEWHERE in the own-render output.
    let page_with_guiha = placed
        .pages
        .iter()
        .position(|pg| page_text(pg).contains("중소벤처기업진흥공단이사장귀하"))
        .expect("the 자가진단표's '…중소벤처기업진흥공단 이사장 귀하' line must survive in own-render (issue 024 무소실)");

    let pg = &placed.pages[page_with_guiha];

    // (2) Containment: 귀하 must sit inside the outer 상자 — the block-11 frame wrapper's placed box.
    let guiha_baseline = baseline_of_sequence(pg, "이사장 귀하")
        .expect("귀하 glyph run present on its page");
    let frame_box = pg
        .tables
        .iter()
        .find(|t| t.block == 11)
        .expect("the self-diagnosis frame (section 0 / block 11) is placed on the 귀하 page");
    let box_bottom = frame_box.y + frame_box.h;
    assert!(
        guiha_baseline <= box_bottom,
        "귀하 baseline {guiha_baseline:.0} must be inside the frame box [top {:.0}, bottom {box_bottom:.0}] — it escaped the 외곽 상자 (issue 024)",
        frame_box.y
    );
    assert!(
        guiha_baseline >= frame_box.y,
        "귀하 baseline {guiha_baseline:.0} below the frame top {:.0} (sanity)",
        frame_box.y
    );

    // (3) 상자 존재: the frame draws a visible box — the outer border + the r16 cell's four edges emit
    // stroked lines on this page (own-render draws cell/frame borders as PlacedLine).
    assert!(
        !pg.lines.is_empty(),
        "the 자가진단표 must render its 상자 (border lines) on its page (issue 024 acceptance)"
    );
}

/// The REAL own-render SVG carries every 귀/하 glyph of the final line (single-glyph <text> elements) —
/// a literal "the SVG is not empty of 귀하" guard, complementing the geometric containment check above.
#[test]
fn self_diag_guiha_glyphs_present_in_own_render_svg() {
    let doc = benchmark1();
    let fonts = RealFontMetrics::new();
    let svgs = hwp_render::render_doc_svg(&doc, &fonts);
    let all: String = svgs.concat();
    // Each glyph is its own <text>…</text>; assert BOTH code points of "귀하" are emitted at least once.
    assert!(all.contains(">귀<"), "own-render SVG must emit the 귀 glyph of '이사장 귀하' (issue 024)");
    assert!(all.contains(">하<"), "own-render SVG must emit the 하 glyph of '이사장 귀하' (issue 024)");
    assert!(all.contains(">이<") && all.contains(">사<") && all.contains(">장<"), "…and 이사장");
}
