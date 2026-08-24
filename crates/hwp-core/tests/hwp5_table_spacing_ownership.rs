#![cfg(feature = "rhwp")]

use hwp_core::{open_hwp5_own, Engine};
use hwp_model::document::{Block, SemanticDoc};
use hwp_model::prelude::{DocumentParser, SourceFormat};
use hwp_rhwp::RhwpEngine;
use hwp_typeset::{place_doc, ApproxFontMetrics, PlacedDoc};

fn margins(doc: &SemanticDoc) -> Vec<(usize, usize, i32, i32, usize)> {
    doc.sections
        .iter()
        .enumerate()
        .flat_map(|(section, value)| {
            value
                .blocks
                .iter()
                .enumerate()
                .filter_map(move |(block, value)| match value {
                    Block::Table(table) => Some((
                        section,
                        block,
                        table.outer_margin_top,
                        table.outer_margin_bottom,
                        table.rows,
                    )),
                    Block::Paragraph(_) => None,
                })
        })
        .collect()
}

fn top_level_tables(doc: &PlacedDoc, page: usize) -> Vec<(usize, f64, f64)> {
    doc.pages[page]
        .tables
        .iter()
        .filter(|table| table.ancestors.is_empty())
        .map(|table| (table.block, table.y, table.h))
        .collect()
}

fn assert_same_table_geometry(left: &PlacedDoc, right: &PlacedDoc) {
    assert_eq!(left.pages.len(), right.pages.len());
    for page in 0..left.pages.len() {
        let left = top_level_tables(left, page);
        let right = top_level_tables(right, page);
        assert_eq!(left.len(), right.len());
        for (left, right) in left.iter().zip(right) {
            assert_eq!(left.0, right.0);
            assert_eq!(left.1.to_bits(), right.1.to_bits());
            assert_eq!(left.2.to_bits(), right.2.to_bits());
        }
    }
}

#[test]
fn benchmark_anchor_spacing_is_owned_without_changing_margin_or_table_geometry() {
    let bytes = std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../benchmarks/benchmark.hwp"
    ))
    .unwrap();
    let owned = open_hwp5_own(&bytes).unwrap();
    let rhwp = RhwpEngine::new().parse(&bytes, SourceFormat::Hwp5).unwrap();
    let production = Engine::open(&bytes).unwrap();

    assert_eq!(margins(&owned), margins(&rhwp));
    assert_eq!(margins(&owned), margins(&production));
    let owned_placed = place_doc(&owned, &ApproxFontMetrics);
    let rhwp_placed = place_doc(&rhwp, &ApproxFontMetrics);
    let production_placed = place_doc(&production, &ApproxFontMetrics);
    let positive_spacing: Vec<_> = production.sections[0]
        .blocks
        .iter()
        .enumerate()
        .filter_map(|(block, value)| match value {
            Block::Table(table) if table.source_anchor_spacing_after > 0 => {
                Some((block, table.source_anchor_spacing_after))
            }
            _ => None,
        })
        .collect();
    assert_eq!(
        positive_spacing,
        vec![
            (1, 452),
            (15, 960),
            (32, 960),
            (52, 900),
            (58, 900),
            (62, 960)
        ]
    );
    assert_same_table_geometry(&owned_placed, &production_placed);

    let rhwp_page1 = top_level_tables(&rhwp_placed, 0);
    let rhwp_page4 = top_level_tables(&rhwp_placed, 3);
    let rhwp_page5 = top_level_tables(&rhwp_placed, 4);
    let page1 = top_level_tables(&production_placed, 0);
    let page4 = top_level_tables(&production_placed, 3);
    let page5 = top_level_tables(&production_placed, 4);
    assert_eq!((page1[0].0, page1[1].0), (1, 3));
    assert_eq!((page4[0].0, page4[1].0), (15, 17));
    assert_eq!((page5[0].0, page5[1].0), (32, 34));

    let placed_delta = |tables: &[(usize, f64, f64)]| tables[1].1 - tables[0].1;
    assert_eq!(placed_delta(&rhwp_page1), 1_989.0);
    assert_eq!(placed_delta(&rhwp_page4), 3_286.0);
    assert_eq!(placed_delta(&rhwp_page5), 3_286.0);
    assert_eq!(placed_delta(&page1), 2_441.0);
    assert_eq!(placed_delta(&page4), 4_246.0);
    assert_eq!(placed_delta(&page5), 4_246.0);

    // Raw HWP5 PARA_LINE_SEG evidence is pinned independently in hwp-rhwp's
    // table_anchor_spacing test. It predicts 2,441 / 4,246 / 4,246 HWPUNIT
    // between table tops. The exact deficits are the preceding anchor line's
    // stored line_spacing, not a table margin or parser disagreement.
    assert_eq!(placed_delta(&page1) - placed_delta(&rhwp_page1), 452.0);
    assert_eq!(placed_delta(&page4) - placed_delta(&rhwp_page4), 960.0);
    assert_eq!(placed_delta(&page5) - placed_delta(&rhwp_page5), 960.0);

    println!(
        "hwp5-table-spacing.v2 owned_adjacent_hosts=6 page1_added=452 page4_added=960 page5_added=960 owner=first_party_ir"
    );
}
