#![cfg(feature = "rhwp")]

use rhwp::model::control::Control;

#[test]
fn benchmark_anchor_lines_pin_the_missing_inter_table_spacing() {
    let bytes = std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../benchmarks/benchmark.hwp"
    ))
    .unwrap();
    let document = rhwp::parse_document(&bytes).unwrap();
    let paragraphs = &document.sections[0].paragraphs;

    let evidence = |ordinal: usize| {
        let paragraph = &paragraphs[ordinal];
        let line = paragraph
            .line_segs
            .first()
            .expect("table host has a line segment");
        let table = paragraph
            .controls
            .iter()
            .find_map(|control| match control {
                Control::Table(table) => Some(table),
                _ => None,
            })
            .expect("selected paragraph hosts a table");
        (
            line.vertical_pos,
            line.line_height,
            line.line_spacing,
            table.outer_margin_top,
            table.outer_margin_bottom,
        )
    };

    let page1_first = evidence(0);
    let page1_second = evidence(1);
    let page4_first = evidence(8);
    let page4_second = evidence(9);
    let page5_first = evidence(23);
    let page5_second = evidence(24);

    assert_eq!(page1_first, (0, 2_130, 452, 141, 141));
    assert_eq!(page1_second.0, 2_582);
    assert_eq!(page4_first, (0, 3_285, 960, 140, 140));
    assert_eq!(page4_second.0, 4_245);
    assert_eq!(page5_first, (0, 3_285, 960, 140, 140));
    assert_eq!(page5_second.0, 4_245);

    for (first, second) in [
        (page1_first, page1_second),
        (page4_first, page4_second),
        (page5_first, page5_second),
    ] {
        assert_eq!(
            second.0 - (first.0 + first.1),
            first.2,
            "the next table host starts after the preceding stored line spacing"
        );
    }
}
