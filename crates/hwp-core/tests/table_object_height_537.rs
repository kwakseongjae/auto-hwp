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

/// Every table's (object height, floating) pair, nested ones included.
fn floats(doc: &SemanticDoc) -> Vec<(Option<i32>, bool)> {
    fn walk(blocks: &[Block], out: &mut Vec<(Option<i32>, bool)>) {
        for b in blocks {
            if let Block::Table(t) = b {
                out.push((t.stored_object_height, t.float_placement.is_some()));
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
    let mut recorded = 0;
    for rel in [
        "benchmarks/benchmark.hwp",
        "benchmarks/benchmark1.hwp",
        "benchmarks/benchmark2.hwp",
        "corpus/hwp/tac-img-02.hwp",
        "corpus/hwp/k-water-rfp.hwp",
        "corpus/hwp/복학원서.hwp",
        "corpus/hwp/hwp-multi-001.hwp",
        "corpus/hwp/draw-group.hwp",
        "corpus/hwp/shape-001.hwp",
        "corpus/hwp/test-image.hwp",
        "corpus/hwp/field-01.hwp",
        "corpus/hwp/issue-505-equations.hwp",
        "corpus/hwp/issue_265.hwp",
        "corpus/hwp/math-001.hwp",
        "corpus/hwp/한셀OLE.hwp",
    ] {
        let path = format!("{}/../../{rel}", env!("CARGO_MANIFEST_DIR"));
        let bytes = std::fs::read(&path).unwrap_or_else(|e| panic!("read {path}: {e}"));
        let lifted_doc = RhwpEngine::new().parse(&bytes, SourceFormat::Hwp5).unwrap();
        let lifted = heights(&lifted_doc);
        recorded += lifted.iter().filter(|h| h.is_some_and(|h| h > 0)).count();
        // a floating table (not 글자처럼 취급) records none
        for (h, float) in floats(&lifted_doc) {
            if float {
                assert_eq!(h, None, "{rel}: a floating table records no object height");
            }
        }
        if let Ok(owned) = open_hwp5_own(&bytes) {
            assert_eq!(heights(&owned), lifted, "{rel}: both readers");
        }
    }
    assert!(recorded > 10, "the lift records object heights");
}
