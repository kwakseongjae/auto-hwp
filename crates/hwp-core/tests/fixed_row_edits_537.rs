//! #537 — an edit changes only the rows whose stored lines it made stale. A row-height edit leaves every
//! cell's stored lines valid (lines wrap at the column width, not the row height), and editing one cell
//! leaves every other row where it was — including the share of the object-height cap.
//!
//! The edit used for one cell only marks it (content unchanged): the check is which rows may move.
#![cfg(feature = "rhwp")]

use hwp_model::document::{Block, SemanticDoc};
use hwp_model::prelude::FontMetricsProvider;
use hwp_ops::Op;

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

const DOCS: [&str; 6] = [
    "benchmarks/benchmark1.hwp",
    "benchmarks/benchmark2.hwp",
    "corpus/hwp/k-water-rfp.hwp",
    "corpus/hwp/tac-img-02.hwp",
    "corpus/hwp/hwp-multi-001.hwp",
    "corpus/hwp/복학원서.hwp",
];

fn open(rel: &str) -> SemanticDoc {
    let path = format!("{}/../../{rel}", env!("CARGO_MANIFEST_DIR"));
    let bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("read {path}: {e}"));
    hwp_core::Engine::open(&bytes).expect("open")
}

/// Every top-level table's laid-out rows (section, block, rows).
fn rows(d: &SemanticDoc, f: &dyn FontMetricsProvider) -> Vec<(usize, usize, Vec<i64>)> {
    let mut out = Vec::new();
    for (si, s) in d.sections.iter().enumerate() {
        let (_, _, w, _) = hwp_typeset::body_box(&s.page);
        for (bi, b) in s.blocks.iter().enumerate() {
            if let Block::Table(t) = b {
                let r = hwp_typeset::row_term_breakdown(t, w, d, f)
                    .iter()
                    .map(|r| r.reserved.round() as i64)
                    .collect();
                out.push((si, bi, r));
            }
        }
    }
    out
}

/// Writing the same row heights back (what dragging a row and dropping it in place does) changes no
/// table and no page count.
#[test]
fn rewriting_the_same_row_heights_changes_nothing() {
    let f = fonts();
    for rel in DOCS {
        let doc = open(rel);
        let mut edited = doc.clone();
        let mut ops = 0;
        for (si, bi, _) in rows(&doc, &f) {
            let Block::Table(t) = &doc.sections[si].blocks[bi] else {
                unreachable!()
            };
            // A 1×1 frame wrapper's edit lands in its inner table — an edit inside the outer cell, whose
            // stored lines (they hold the inner table) are then stale by the cell rule. Not a row-height
            // edit of this table, so not part of this check.
            if t.frame_inner().is_some() || t.row_heights.len() != t.rows {
                continue;
            }
            let target = t;
            let op = Op::SetTableRowHeights {
                section: si,
                index: bi,
                heights: target.row_heights.clone(),
            };
            hwp_ops::apply(&mut edited, &op).expect("SetTableRowHeights");
            ops += 1;
        }
        assert!(ops > 0, "{rel}: tables to edit");
        assert_eq!(rows(&edited, &f), rows(&doc, &f), "{rel}: rows");
        assert_eq!(
            hwp_typeset::place_doc(&edited, &f).pages.len(),
            hwp_typeset::place_doc(&doc, &f).pages.len(),
            "{rel}: pages"
        );
    }
}

/// Marking one cell edited (content unchanged) may change only the rows that cell covers.
#[test]
fn editing_one_cell_leaves_the_other_rows() {
    let f = fonts();
    for rel in DOCS {
        let doc = open(rel);
        let base = rows(&doc, &f);
        let mut checked = 0;
        for (k, (si, bi, before)) in base.iter().enumerate() {
            let Block::Table(t) = &doc.sections[*si].blocks[*bi] else {
                unreachable!()
            };
            if t.rows < 2 || !t.fixed_row_heights {
                continue;
            }
            let Some(ci) = t
                .cells
                .iter()
                .position(|c| c.active && c.row_span.max(1) == 1)
            else {
                continue;
            };
            let row = t.cells[ci].row;
            let mut edited = doc.clone();
            let Block::Table(t) = &mut edited.sections[*si].blocks[*bi] else {
                unreachable!()
            };
            t.cells[ci].dirty.mark();
            let after = &rows(&edited, &f)[k].2;
            for (r, (a, b)) in after.iter().zip(before).enumerate() {
                if r != row {
                    assert_eq!(a, b, "{rel}: table at {si}/{bi}, row {r} moved after editing a cell in row {row}");
                }
            }
            checked += 1;
        }
        assert!(checked > 0, "{rel}: tables checked");
    }
}

/// A format edit marks the cell's paragraph, not the cell — the cell's stored lines are still stale.
#[test]
fn a_format_edit_in_a_cell_makes_its_stored_lines_stale() {
    let mut doc = open("benchmarks/benchmark1.hwp");
    let (si, bi, ci) = doc
        .sections
        .iter()
        .enumerate()
        .flat_map(|(si, s)| s.blocks.iter().enumerate().map(move |(bi, b)| (si, bi, b)))
        .find_map(|(si, bi, b)| match b {
            Block::Table(t) if t.fixed_row_heights => t
                .cells
                .iter()
                .position(|c| {
                    c.stored_line_extent.is_some()
                        && matches!(c.blocks.first(), Some(Block::Paragraph(_)))
                })
                .map(|ci| (si, bi, ci)),
            _ => None,
        })
        .expect("a fixed table with a stored-line cell");
    let Block::Table(t) = &mut doc.sections[si].blocks[bi] else {
        unreachable!()
    };
    assert!(!t.cell_lines_stale(ci));
    let Some(Block::Paragraph(p)) = t.cells[ci].blocks.first_mut() else {
        unreachable!()
    };
    p.dirty.mark();
    assert!(t.cell_lines_stale(ci), "an edited paragraph in the cell");
    assert!(
        !t.cells[ci].dirty.is_dirty(),
        "the cell itself is not marked"
    );
}
