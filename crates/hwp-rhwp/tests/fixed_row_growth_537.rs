//! #537 — a fixed-height row grows when its cells need more than the stored height: an unedited cell
//! needs Hangul's stored line extent plus its vertical padding, an edited cell its laid-out content.
//!
//! The stored lines are the reference (what Hangul itself saved for the cell); the rule was not
//! checked row by row against a Hangul PDF.
#![cfg(feature = "rhwp")]

use hwp_model::prelude::*;

fn fonts() -> impl FontMetricsProvider {
    #[cfg(feature = "shaper")]
    {
        hwp_typeset::RealFontMetrics::new()
    }
    #[cfg(not(feature = "shaper"))]
    {
        hwp_typeset::ApproxFontMetrics
    }
}

fn lift(name: &str) -> SemanticDoc {
    let path = format!("{}/../../benchmarks/{name}", env!("CARGO_MANIFEST_DIR"));
    let bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("read {path}: {e}"));
    hwp_rhwp::parse_to_semantic_guarded(&bytes).expect("lift")
}

fn text(p: &Paragraph) -> String {
    p.runs
        .iter()
        .flat_map(|r| &r.content)
        .filter_map(|i| match i {
            Inline::Text(t) => Some(t.as_str()),
            _ => None,
        })
        .collect()
}

fn page_text(placed: &hwp_typeset::PlacedDoc) -> String {
    placed
        .pages
        .iter()
        .flat_map(|p| &p.glyphs)
        .map(|g| g.ch)
        .collect()
}

fn hidden_lines(placed: &hwp_typeset::PlacedDoc) -> usize {
    placed
        .pages
        .iter()
        .flat_map(|p| &p.clipped_cells)
        .map(|c| c.hidden_lines)
        .sum()
}

/// The lift records each cell's stored line extent, and benchmark.hwp — whose stored lines overflow a
/// few stored cell heights — no longer clips any cell text. The page count stays 8 (the gate).
#[test]
fn stored_lines_that_overflow_their_row_are_drawn() {
    let doc = lift("benchmark.hwp");
    let with_extent = doc
        .sections
        .iter()
        .flat_map(|s| &s.blocks)
        .filter_map(|b| match b {
            Block::Table(t) => Some(t),
            Block::Paragraph(_) => None,
        })
        .flat_map(|t| &t.cells)
        .filter(|c| c.stored_line_extent.is_some_and(|e| e > 0))
        .count();
    assert!(with_extent > 0, "the lift records stored line extents");
    let f = fonts();
    let placed = hwp_typeset::place_doc(&doc, &f);
    assert_eq!(placed.pages.len(), 8, "gate page count");
    assert_eq!(hidden_lines(&placed), 0, "no clipped cell text");
}

/// The paste the demo e2e (cell-caret-053) does: the cover box's one-line cell becomes two paragraphs.
/// Its stored lines are stale, so the row grows to the laid-out content and the second paragraph is
/// drawn. Unmarked (as if the stored lines still held), the row keeps the stored-line height and the
/// second paragraph is clipped — the edit flag is what lets it grow.
#[test]
fn an_edited_cell_grows_its_fixed_row_to_its_content() {
    let f = fonts();
    for edited in [true, false] {
        let mut doc = lift("benchmark.hwp");
        let cell = doc
            .sections
            .iter_mut()
            .flat_map(|s| s.blocks.iter_mut())
            .filter_map(|b| match b {
                Block::Table(t) => Some(t),
                Block::Paragraph(_) => None,
            })
            .flat_map(|t| t.cells.iter_mut())
            .find(|c| {
                c.blocks
                    .iter()
                    .any(|b| matches!(b, Block::Paragraph(p) if text(p).starts_with("※ 사")))
            })
            .expect("the cover box cell");
        let at = cell
            .blocks
            .iter()
            .position(|b| matches!(b, Block::Paragraph(p) if text(p).starts_with("※ 사")))
            .unwrap();
        let Block::Paragraph(p) = &cell.blocks[at] else {
            unreachable!()
        };
        let original = text(p);
        let head: String = original.chars().take(3).collect();
        let tail: String = original.chars().skip(3).collect();
        let mut first = p.clone();
        first.runs.truncate(1);
        first.runs[0].content = vec![Inline::Text(format!("{head}VPASTE"))];
        let mut second = first.clone();
        second.runs[0].content = vec![Inline::Text(format!("VLINE{tail}"))];
        cell.blocks[at] = Block::Paragraph(first);
        cell.blocks.insert(at + 1, Block::Paragraph(second));
        if edited {
            cell.dirty.mark();
        }
        let placed = hwp_typeset::place_doc(&doc, &f);
        let drawn = page_text(&placed);
        assert!(drawn.contains("VPASTE"), "edited {edited}: first paragraph");
        assert_eq!(
            drawn.contains("VLINE"),
            edited,
            "edited {edited}: the second paragraph is drawn only when the edit lets the row grow"
        );
    }
}
