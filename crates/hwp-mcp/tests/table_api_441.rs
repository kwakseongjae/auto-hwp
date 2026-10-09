//! #441 — 표 API 빈칸: ① `InsertTableAt` 글자처럼 취급 옵션 ② `tableGrid` 칸 음영 · 너비 · 병합 · 열 너비 읽기
//! ③ `CellSpec.text` 의 줄바꿈 = 칸 문단 ④ `docProfile().tables` 20개 잘림 표시 + 모든 표 위치 목록.

use hwp_hwpx::package::Package;
use hwp_mcp::{apply_intent, export_bytes, open_bytes, Intent, Outcome, Session};
use hwp_model::prelude::*;

fn read(path: &str) -> Vec<u8> {
    let p = format!("{}/../../{path}", env!("CARGO_MANIFEST_DIR"));
    std::fs::read(&p).unwrap_or_else(|e| panic!("read {p}: {e}"))
}

fn open(bytes: &[u8]) -> Session {
    let mut s = Session::default();
    open_bytes(&mut s, bytes, "x.hwpx").expect("open");
    s
}

fn cell(text: &str) -> hwp_ops::CellSpec {
    hwp_ops::CellSpec {
        text: text.into(),
        ..Default::default()
    }
}

fn insert(
    s: &mut Session,
    index: usize,
    rows: Vec<Vec<hwp_ops::CellSpec>>,
    treat_as_char: Option<bool>,
) {
    apply_intent(
        s,
        Intent::InsertTableAt {
            section: 0,
            index: Some(index),
            rows,
            border: None,
            col_widths: None,
            header_row: None,
            treat_as_char,
        },
    )
    .expect("insert");
}

fn section_xml(s: &Session) -> String {
    let bytes = export_bytes(s).expect("export");
    assert!(
        hwp_hwpx::export::validate_open_safety(&bytes).ok,
        "open-safe"
    );
    let pkg = Package::open(&bytes).unwrap();
    String::from_utf8_lossy(&pkg.read_part("Contents/section0.xml").unwrap()).into_owned()
}

/// The `<hp:tbl …>…</hp:tbl>` holding `<hp:t>{marker}</hp:t>`.
fn table_xml<'a>(sec: &'a str, marker: &str) -> &'a str {
    let at = sec.find(&format!("<hp:t>{marker}</hp:t>")).expect("marker");
    let s = sec[..at].rfind("<hp:tbl ").unwrap();
    &sec[s..at + sec[at..].find("</hp:tbl>").unwrap()]
}

#[test]
fn treat_as_char_option_reaches_the_export() {
    let mut s = open(&read("corpus/hwpx/FormattingShowcase.hwpx"));
    insert(&mut s, 1, vec![vec![cell("기본")]], None);
    insert(&mut s, 1, vec![vec![cell("나눔")]], Some(false));
    insert(&mut s, 1, vec![vec![cell("글자")]], Some(true));
    let sec = section_xml(&s);
    assert!(
        table_xml(&sec, "기본").contains("treatAsChar=\"1\""),
        "default unchanged"
    );
    assert!(table_xml(&sec, "글자").contains("treatAsChar=\"1\""));
    assert!(
        table_xml(&sec, "나눔").contains("treatAsChar=\"0\""),
        "false → paragraph-anchored"
    );
    assert!(table_xml(&sec, "나눔").contains("pageBreak=\"CELL\""));
    // The JSON field parses (and stays optional).
    let i: Intent = serde_json::from_value(serde_json::json!({
        "intent": "InsertTableAt", "section": 0, "index": 1, "rows": [[{}]], "treat_as_char": false
    }))
    .unwrap();
    assert!(matches!(
        i,
        Intent::InsertTableAt {
            treat_as_char: Some(false),
            ..
        }
    ));
}

fn grid(s: &mut Session, block: usize) -> serde_json::Value {
    match apply_intent(s, Intent::TableGrid { section: 0, block }).expect("grid") {
        Outcome::TableGrid(g) => serde_json::to_value(g).unwrap(),
        _ => unreachable!(),
    }
}

#[test]
fn table_grid_reads_spans_widths_and_fill() {
    let mut s = open(&read(
        "corpus/hwpxlib_corpus/reader_writer/SimpleTable.hwpx",
    ));
    let block = s.doc.as_ref().unwrap().doc().sections[0]
        .blocks
        .iter()
        .position(|b| matches!(b, Block::Table(_)))
        .unwrap();
    let g = grid(&mut s, block);
    let widths: Vec<i64> = g["col_widths"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_i64().unwrap())
        .collect();
    assert_eq!(widths.len(), 3);
    let merged = g["cells"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["text"] == "1")
        .unwrap();
    assert_eq!(
        (merged["row_span"].as_u64(), merged["col_span"].as_u64()),
        (Some(2), Some(2))
    );
    assert_eq!(merged["width"].as_i64(), Some(12688), "stored cellSz width");
    assert!(merged["fill"].is_null(), "no background");

    // An op-set shade reads back as #RRGGBB.
    apply_intent(
        &mut s,
        Intent::SetTableCellShade {
            section: 0,
            index: block,
            sel: "cell".into(),
            row: 0,
            col: 2,
            shade: Some("#FFF2CC".into()),
        },
    )
    .expect("shade");
    let g = grid(&mut s, block);
    let shaded = g["cells"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["text"] == "2")
        .unwrap();
    assert_eq!(shaded["fill"], "#FFF2CC");

    // …and survives the HWPX round trip (the parser lifts it from the borderFill brush).
    let mut re = open(&export_bytes(&s).unwrap());
    let g = grid(&mut re, block);
    let shaded = g["cells"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["text"] == "2")
        .unwrap();
    assert_eq!(shaded["fill"], "#FFF2CC");
}

#[test]
fn cell_text_newline_starts_a_new_cell_paragraph() {
    let mut s = open(&read("corpus/hwpx/FormattingShowcase.hwpx"));
    insert(
        &mut s,
        1,
        vec![vec![cell("첫 줄\n둘째 줄\r\n셋째 줄"), cell("한 줄")]],
        None,
    );
    let Block::Table(t) = &s.doc.as_ref().unwrap().doc().sections[0].blocks[1] else {
        panic!()
    };
    let c = t.cells.iter().find(|c| c.col == 0).unwrap();
    assert_eq!(c.blocks.len(), 3, "three cell paragraphs");
    let sec = section_xml(&s);
    let tbl = table_xml(&sec, "첫 줄");
    assert!(tbl.contains("<hp:t>둘째 줄</hp:t>") && tbl.contains("<hp:t>셋째 줄</hp:t>"));
    assert!(
        !tbl.contains('\n') && !tbl.contains('\r'),
        "no raw line break inside <hp:t>"
    );
}

#[test]
fn doc_profile_flags_truncation_and_table_blocks_lists_all() {
    let mut s = open(&read("corpus/hwpx/FormattingShowcase.hwpx"));
    for k in 0..21 {
        insert(&mut s, 1, vec![vec![cell(&format!("표{k}"))]], None);
    }
    let doc = s.doc.as_ref().unwrap().doc();
    let all = hwp_session::table_blocks(doc);
    let top = doc
        .sections
        .iter()
        .flat_map(|x| &x.blocks)
        .filter(|b| matches!(b, Block::Table(_)))
        .count();
    assert!(top > 20);
    assert_eq!(all.len(), top, "every top-level table");
    assert!(all
        .iter()
        .all(|t| matches!(doc.sections[t.section].blocks[t.block], Block::Table(_))));
    let p = hwp_session::doc_profile(doc);
    assert_eq!(p.tables.len(), 20, "profile stays capped for the AI budget");
    assert!(p.tables_truncated);

    let small = open(&read("corpus/hwpx/FormattingShowcase.hwpx"));
    assert!(!hwp_session::doc_profile(small.doc.as_ref().unwrap().doc()).tables_truncated);
}
