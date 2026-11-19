//! #537 — both \`.hwp\` readers record a 글자처럼 취급 table's stored object height (Hangul's drawn height),
//! the cap of grown fixed rows. They must agree, table for table (nested ones included), or the two
//! paths lay the same file out differently.
#![cfg(feature = "rhwp")]

use hwp_core::open_hwp5_own;
use hwp_model::document::{Block, SemanticDoc};
use hwp_model::prelude::{DocumentParser, SourceFormat};
use hwp_rhwp::RhwpEngine;

fn heights(doc: &SemanticDoc) -> Vec<Option<i32>> {
    fn walk(blocks: &[Block], out: &mut Vec<Option<i32>>) {
        for b in blocks {
            if let Block::Table(t) = b {
                out.push(t.stored_object_height);
                for c in &t.cells {
                    walk(&c.blocks, out);
                }
            }
        }
    }
    let mut out = Vec::new();
    for s in &doc.sections {
        walk(&s.blocks, &mut out);
    }
    out
}

#[test]
fn both_hwp_readers_record_the_same_table_object_heights() {
    let bytes = std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../benchmarks/benchmark.hwp"
    ))
    .unwrap();
    let lifted = heights(&RhwpEngine::new().parse(&bytes, SourceFormat::Hwp5).unwrap());
    let owned = heights(&open_hwp5_own(&bytes).unwrap());
    assert!(
        lifted.iter().filter(|h| h.is_some_and(|h| h > 0)).count() > 10,
        "the lift records object heights: {lifted:?}"
    );
    assert_eq!(owned, lifted);
}
