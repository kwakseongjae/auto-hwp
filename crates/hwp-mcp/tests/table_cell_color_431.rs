//! #431 — `InsertTableAt` 새 표 칸 글은 이웃 문단의 글자 **색**을 상속하지 않는다(글꼴 · 크기만).
//!
//! 고치기 전(0.0.13, #419 A-3): 칸 글이 이웃 본문 문단의 글꼴 · 크기 · **색**을 따랐다. `FormattingShowcase.hwpx`
//! 블록 1 에 넣은 표는 이웃(파란 제목 줄)의 색 때문에 모든 칸이 파란 글씨였다.
//! 결정(오너, 2026-10-07): 색은 문서 기본 본문 색(검정). 강조(굵게 등)는 이미 상속하지 않는다.

use hwp_hwpx::package::Package;
use hwp_hwpx::parse::parse_semantic;
use hwp_mcp::{apply_intent, export_bytes, open_bytes, Intent, Session};
use hwp_model::prelude::*;

fn open(name: &str) -> Session {
    let p = format!("{}/../../corpus/hwpx/{name}", env!("CARGO_MANIFEST_DIR"));
    let mut s = Session::default();
    open_bytes(&mut s, &std::fs::read(&p).unwrap(), name).expect("open");
    s
}

fn cell_char<'a>(d: &'a SemanticDoc, marker: &str) -> &'a CharShape {
    d.sections[0]
        .blocks
        .iter()
        .filter_map(|b| match b {
            Block::Table(t) => Some(t),
            _ => None,
        })
        .flat_map(|t| &t.cells)
        .flat_map(|c| &c.blocks)
        .find_map(|b| match b {
            Block::Paragraph(p) => p.runs.iter().find(|r| {
                r.content
                    .iter()
                    .any(|i| matches!(i, Inline::Text(x) if x == marker))
            }),
            _ => None,
        })
        .map(|r| &d.char_shapes[r.char_shape])
        .unwrap_or_else(|| panic!("cell {marker:?}"))
}

#[test]
fn new_table_cells_take_the_body_face_and_size_but_the_default_color() {
    let mut s = open("FormattingShowcase.hwpx");
    // The neighbour the A-3 rule inherits from: block 0 is the empty section-property paragraph (no text),
    // so the search goes forward to block 1 — the 「형식 테스트 문서」 title, 10pt `#1F4E79`.
    let nb = {
        let d = s.doc.as_ref().unwrap().doc();
        let Block::Paragraph(p) = &d.sections[0].blocks[1] else {
            panic!("block 1 paragraph")
        };
        d.char_shapes[p.runs[0].char_shape].clone()
    };
    assert_ne!(
        nb.text_color.to_hex(),
        "#000000",
        "fixture: coloured neighbour"
    );
    let cell = |t: &str, bold: bool| hwp_ops::CellSpec {
        text: t.into(),
        bold,
        ..Default::default()
    };
    apply_intent(
        &mut s,
        Intent::InsertTableAt {
            section: 0,
            index: Some(1),
            rows: vec![vec![cell("색431", false), cell("굵게431", true)]],
            border: None,
            col_widths: None,
            header_row: None,
        },
    )
    .unwrap();
    let bytes = export_bytes(&s).unwrap();
    for (d, ctx) in [
        (s.doc.as_ref().unwrap().doc().clone(), "memory"),
        (parse_semantic(&bytes).unwrap(), "reopened"),
    ] {
        for m in ["색431", "굵게431"] {
            let c = cell_char(&d, m);
            assert_eq!(
                c.text_color.to_hex(),
                "#000000",
                "{ctx} {m}: default body color"
            );
            assert_eq!(c.height, nb.height, "{ctx} {m}: body size");
            assert_eq!(c.font_family, nb.font_family, "{ctx} {m}: body face");
        }
        assert!(!cell_char(&d, "색431").bold && cell_char(&d, "굵게431").bold);
    }
    // The exported charPr of the plain cell says black.
    let pkg = Package::open(&bytes).unwrap();
    let section =
        String::from_utf8_lossy(&pkg.read_part("Contents/section0.xml").unwrap()).into_owned();
    let header = String::from_utf8_lossy(&pkg.read_header().unwrap()).into_owned();
    let at = section.find("색431").unwrap();
    let run = &section[section[..at].rfind("<hp:run ").unwrap()..at];
    let k = "charPrIDRef=\"";
    let i = run.find(k).unwrap() + k.len();
    let id = &run[i..i + run[i..].find('"').unwrap()];
    let el = &header[header.find(&format!("<hh:charPr id=\"{id}\"")).unwrap()..];
    let el = &el[..el.find('>').unwrap()];
    assert!(el.contains("textColor=\"#000000\""), "{el}");
}
