//! #193 real-boundary regression: the public HWP5 benchmark contains the exact top-captioned table
//! that blocks #192. Keep this assertion content-free: only typed geometry/topology is inspected.
#![cfg(feature = "rhwp")]

use hwp_model::prelude::*;

#[test]
fn public_hwp5_top_caption_reaches_the_shared_table_ir() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../benchmarks/benchmark.hwp"
    );
    let bytes = std::fs::read(path).expect("read public HWP5 benchmark");
    let doc = hwp_rhwp::RhwpEngine::new()
        .parse(&bytes, SourceFormat::Hwp5)
        .expect("rhwp lift");

    let caption = doc
        .sections
        .iter()
        .flat_map(|section| &section.blocks)
        .filter_map(|block| match block {
            Block::Table(table) => table.caption.as_ref(),
            Block::Paragraph(_) => None,
        })
        .find(|caption| {
            caption.position == TableCaptionPosition::Top
                && caption.width == 8_504
                && caption.spacing == 850
                && caption.max_width == 48_047
        })
        .expect("exact public top-caption geometry must survive lift");

    assert!(!caption.include_margin);
    assert_eq!(caption.blocks.len(), 1);
    assert!(matches!(caption.blocks[0], Block::Paragraph(_)));
}
