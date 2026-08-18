//! Issue #48 — nested cell caret contract.
//!
//! Passing tests lock today's depth-1 lane. `#[ignore = "issue-48"]` tests are the exit
//! gate: un-ignore them when `cell_text_hit` reaches a nested leaf.

use hwp_model::prelude::*;
use hwp_typeset::{place_doc, ApproxFontMetrics};

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

fn one_cell_table(inner: Vec<Block>) -> Table {
    Table {
        rows: 1,
        cols: 1,
        col_widths: vec![20_000],
        cells: vec![Cell {
            row: 0,
            col: 0,
            blocks: inner,
            width: Some(20_000),
            ..Default::default()
        }],
        ..Default::default()
    }
}

fn doc_with(blocks: Vec<Block>) -> SemanticDoc {
    let mut doc = SemanticDoc::default();
    doc.char_shapes.push(CharShape::default());
    doc.para_shapes.push(ParaShape::default());
    doc.sections.push(Section {
        blocks,
        page: PageSetup {
            width: 59528,
            height: 84188,
            margin_left: 2000,
            margin_right: 2000,
            margin_top: 2000,
            margin_bottom: 2000,
            ..Default::default()
        },
        ..Default::default()
    });
    doc
}

fn nested_doc() -> SemanticDoc {
    let leaf = one_cell_table(vec![Block::Paragraph(para("생산품"))]);
    let outer = one_cell_table(vec![Block::Table(leaf)]);
    doc_with(vec![Block::Table(outer)])
}

#[test]
fn top_level_cell_text_hit_still_resolves() {
    let doc = doc_with(vec![Block::Table(one_cell_table(vec![Block::Paragraph(
        para("바깥칸"),
    )]))]);
    let placed = place_doc(&doc, &ApproxFontMetrics);
    let t = placed.pages[0]
        .tables
        .iter()
        .find(|t| t.ancestors.is_empty())
        .expect("top-level table");
    let hit = hwp_typeset::cell_text_hit(
        &doc,
        &placed,
        &ApproxFontMetrics,
        0,
        t.x + t.w / 2.0,
        t.y + t.h / 2.0,
    );
    assert!(hit.is_some(), "depth-1 cell must keep a caret hit");
}

#[test]
fn nested_table_is_placed_with_ancestors() {
    let doc = nested_doc();
    let placed = place_doc(&doc, &ApproxFontMetrics);
    assert!(
        placed.pages[0]
            .tables
            .iter()
            .any(|t| !t.ancestors.is_empty()),
        "064 must still record nested provenance"
    );
}

#[test]
fn nested_cell_text_hit_resolves_to_leaf() {
    let doc = nested_doc();
    let placed = place_doc(&doc, &ApproxFontMetrics);
    let t = placed.pages[0]
        .tables
        .iter()
        .find(|t| !t.ancestors.is_empty())
        .expect("nested table");
    let hit = hwp_typeset::cell_text_hit(
        &doc,
        &placed,
        &ApproxFontMetrics,
        0,
        t.x + t.w / 2.0,
        t.y + t.h / 2.0,
    )
    .expect("nested leaf must be a caret target");
    assert_eq!(hit.section, 0);
    assert_eq!(hit.path.len(), 2, "depth-2 leaf carries a CellPath");
    let rect = hwp_typeset::cell_caret_rect_path(
        &doc,
        &placed,
        &ApproxFontMetrics,
        hit.section,
        &hit.path,
        hit.para,
        hit.offset,
    )
    .expect("path caret rect must resolve");
    assert!(
        (rect.x - hit.caret.x).abs() < 0.01 && (rect.top - hit.caret.top).abs() < 0.01,
        "path caret == hit caret"
    );
}

#[test]
fn placed_nested_paths_resolve_in_ir() {
    let doc = nested_doc();
    let placed = place_doc(&doc, &ApproxFontMetrics);
    for t in placed.pages[0]
        .tables
        .iter()
        .filter(|t| !t.ancestors.is_empty())
    {
        let Block::Table(outer) = &doc.sections[t.section].blocks[t.block] else {
            panic!("top-level block must be the outer table");
        };
        let step = t.ancestors.first().expect("nested table has an ancestor");
        let cell = outer
            .cells
            .iter()
            .find(|c| c.row == step.row && c.col == step.col)
            .expect("ancestor cell exists");
        assert!(
            cell.blocks.iter().any(|b| matches!(b, Block::Table(_))),
            "placed nested path must find a leaf table in IR (no synthetic 0,0)"
        );
    }
}
