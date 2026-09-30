//! `serialize_hwpx_with` — the `.hwp` table row-height policy on HWPX export.
//!
//! 0.0.6 (#247/#275) writes every table lifted from a binary `.hwp` with `noAdjust="1"` (the saved row
//! heights are Hancom's exact layout → page-count faithful round trip). A caller that FILLS a `.hwp`
//! form needs rows that grow in Hancom instead: `HwpRowHeights::Auto` writes `noAdjust="0"` for those
//! tables only, and leaves HWPX-origin tables and the in-memory document alone.

use hwp_core::{serialize_hwpx, serialize_hwpx_with, HwpRowHeights, HwpxExportOptions};
use hwp_model::prelude::*;

fn table(source: SourceFormat, text: &str) -> Block {
    Block::Table(Table {
        rows: 1,
        cols: 1,
        cells: vec![Cell {
            blocks: vec![Block::Paragraph(Paragraph {
                runs: vec![Run {
                    content: vec![Inline::Text(text.into())],
                    ..Default::default()
                }],
                ..Default::default()
            })],
            ..Default::default()
        }],
        col_widths: vec![20_000],
        row_heights: vec![1_500],
        fixed_row_heights: true,
        provenance: Provenance {
            source: Some(source),
            raw: None,
        },
        ..Default::default()
    })
}

fn lifted_doc() -> SemanticDoc {
    let mut doc = SemanticDoc::default();
    doc.char_shapes.push(CharShape::default());
    doc.para_shapes.push(ParaShape::default());
    doc.sections.push(Section {
        blocks: vec![
            table(SourceFormat::Hwp5, "hwp 표"),
            table(SourceFormat::Hwpx, "hwpx 표"),
        ],
        provenance: Provenance {
            source: Some(SourceFormat::Hwp5),
            raw: None,
        },
        ..Default::default()
    });
    doc
}

fn no_adjust_values(bytes: &[u8]) -> Vec<String> {
    let pkg = hwp_hwpx::package::Package::open(bytes).unwrap();
    let xml = String::from_utf8(pkg.read_part("Contents/section0.xml").unwrap()).unwrap();
    xml.match_indices("noAdjust=\"")
        .map(|(i, m)| xml[i + m.len()..i + m.len() + 1].to_string())
        .collect()
}

#[test]
fn exact_is_the_default_and_matches_serialize_hwpx() {
    let doc = lifted_doc();
    let plain = serialize_hwpx(&doc).unwrap();
    let with = serialize_hwpx_with(&doc, &HwpxExportOptions::default()).unwrap();
    assert_eq!(plain, with, "default options = today's bytes");
    assert_eq!(no_adjust_values(&plain), vec!["1", "1"]);
}

#[test]
fn auto_writes_no_adjust_0_only_for_hwp_tables() {
    let doc = lifted_doc();
    let opts = HwpxExportOptions {
        hwp_row_heights: HwpRowHeights::Auto,
    };
    let out = serialize_hwpx_with(&doc, &opts).unwrap();
    assert_eq!(
        no_adjust_values(&out),
        vec!["0", "1"],
        ".hwp table grows, HWPX-origin table keeps its flag"
    );
    // The live document is untouched.
    let Block::Table(t) = &doc.sections[0].blocks[0] else {
        unreachable!()
    };
    assert!(t.fixed_row_heights);
    assert!(hwp_core::validate_hwpx(&out).ok);
}
