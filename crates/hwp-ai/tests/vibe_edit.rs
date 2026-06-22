//! Vibe-docs end-to-end: an anchored EditScript → op-bus → the JSX/CSS → HTML deliverable.
//!
//! The unit tests prove compile+apply at the model level. This proves the *new serialization
//! surfaces* an inserted table / shaded column / embedded image survive all the way to the HTML a
//! user actually views — the freshly-created `BinData` + `Inline::Image` being the riskiest path.

use hwp_ai::edit::{parse_script, EditScript};
use hwp_ai::propose_from_edit_script;
use hwp_model::document::{Block, Paragraph, Run, Section, SemanticDoc};
use hwp_model::prelude::*;

fn doc_with_toc() -> SemanticDoc {
    let mut doc = SemanticDoc {
        char_shapes: vec![CharShape::default()],
        para_shapes: vec![ParaShape::default()],
        ..Default::default()
    };
    let para = |t: &str| {
        Block::Paragraph(Paragraph {
            runs: vec![Run { content: vec![Inline::Text(t.into())], ..Default::default() }],
            ..Default::default()
        })
    };
    // b0 제목, b1 목차, b2 본문
    doc.sections.push(Section { blocks: vec![para("보고서"), para("목차"), para("본문 시작")], ..Default::default() });
    doc
}

fn apply(doc: &mut SemanticDoc, script: &EditScript) {
    let proposal = propose_from_edit_script(doc, script, "test").expect("validates on scratch");
    for op in &proposal.ops {
        hwp_ops::apply(doc, op).expect("op applies to live doc");
    }
}

#[test]
fn table_after_toc_then_shade_left_column_renders_to_html() {
    let mut doc = doc_with_toc();

    // "목차 아래에 표 만들어줘": insert a table after b1.
    apply(&mut doc, &parse_script(
        r#"{"edits":[{"op":"insert_table","section":0,"block":1,"position":"after",
            "header":["구분","값"],"rows":[["매출","100"],["비용","40"]]}]}"#,
    ).unwrap());

    // The table is now b2. "표의 좌측열을 헤더 색상으로": shade column 0.
    let table_idx = doc.sections[0].blocks.iter().position(|b| matches!(b, Block::Table(_))).unwrap();
    assert_eq!(table_idx, 2, "table landed right after 목차");
    let script = format!(
        r##"{{"edits":[{{"op":"shade_column","section":0,"block":{table_idx},"col":0,"shade":"#D9E1F2"}}]}}"##
    );
    apply(&mut doc, &parse_script(&script).unwrap());

    // Left-column cells are shaded in the model.
    if let Block::Table(t) = &doc.sections[0].blocks[table_idx] {
        let want = Color::from_hex("#D9E1F2");
        for c in t.cells.iter().filter(|c| c.col == 0) {
            assert_eq!(c.shade_color, want, "left column cell shaded");
        }
    } else {
        panic!("expected table");
    }

    // Render through the vibe-docs deliverable: JSX/CSS project → standalone HTML.
    let proj = hwp_jsx::emit(&doc);
    let html = hwp_export::emit_html(&proj, &hwp_export::HtmlOptions { title: Some("t".into()) });
    assert!(html.contains("<table"), "table renders");
    assert!(html.contains("구분") && html.contains("매출"), "table content renders");
    assert!(html.to_lowercase().contains("d9e1f2"), "shade color present in HTML: not found");
}

#[test]
fn inserted_image_embeds_as_data_uri_in_html() {
    let mut doc = doc_with_toc();
    // a tiny fake PNG payload (content is opaque to the codec — it just base64s it)
    let png = b"\x89PNG\r\n\x1a\n_tf_hwp_test_image_bytes_";
    let path = std::env::temp_dir().join("tfhwp_vibe_img.png");
    std::fs::write(&path, png).unwrap();

    let script = format!(
        r#"{{"edits":[{{"op":"insert_image","section":0,"block":2,"position":"after",
            "path":{:?},"width_mm":90}}]}}"#,
        path.to_string_lossy()
    );
    apply(&mut doc, &parse_script(&script).unwrap());

    assert_eq!(doc.bin_data.len(), 1, "image embedded as BinData");
    let proj = hwp_jsx::emit(&doc);
    let html = hwp_export::emit_html(&proj, &hwp_export::HtmlOptions { title: None });
    assert!(html.contains("data:image"), "image renders as a data: URI in HTML");
}
