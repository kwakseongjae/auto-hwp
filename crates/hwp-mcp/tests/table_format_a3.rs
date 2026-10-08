//! A-3 — `InsertTableAt` 서식 상속 · 지정.
//!
//! 고치기 전:
//! - 칸 글은 엔진 기본 글자 모양(10pt · 문서 기본 글꼴)이었다 — 15pt 휴먼명조 본문 사이에 넣은 표가
//!   혼자 작은 글씨였다.
//! - 테두리는 「문서 첫 표의 borderFill」만 빌려서, 첫 표가 선 없는 배치용 표면 새 표도 선이 없었다.
//!   지정할 방법이 없었다.
//! - 열 너비는 `[1; n]` 비율이라 화면은 맞았지만 HWPX 로는 **n HWPUNIT 폭의 표**가 나갔다.
//! - 머리 행 반복은 내보내기만 `repeatHeader="1"` 이고 화면은 반복하지 않았으며, 끌 수 없었다.

use hwp_hwpx::package::Package;
use hwp_hwpx::parse::parse_semantic;
use hwp_mcp::{apply_intent, export_bytes, open_bytes, Intent, Session};
use hwp_model::prelude::*;

fn corpus(name: &str) -> Vec<u8> {
    let p = format!("{}/../../corpus/hwpx/{name}", env!("CARGO_MANIFEST_DIR"));
    std::fs::read(&p).unwrap_or_else(|e| panic!("read {p}: {e}"))
}

fn cell(text: &str, bold: bool) -> hwp_ops::CellSpec {
    hwp_ops::CellSpec {
        text: text.into(),
        bold,
        ..Default::default()
    }
}

fn open(name: &str) -> Session {
    let mut s = Session::default();
    open_bytes(&mut s, &corpus(name), name).expect("open");
    s
}

fn insert(
    s: &mut Session,
    index: usize,
    rows: Vec<Vec<hwp_ops::CellSpec>>,
    border: Option<hwp_ops::TableBorderSpec>,
    col_widths: Option<Vec<f64>>,
    header_row: Option<bool>,
) -> std::result::Result<(), String> {
    apply_intent(
        s,
        Intent::InsertTableAt {
            section: 0,
            index: Some(index),
            rows,
            border,
            col_widths,
            header_row,
            treat_as_char: None,
        },
    )
    .map(|_| ())
}

fn doc(s: &Session) -> &SemanticDoc {
    s.doc.as_ref().unwrap().doc()
}

/// The char shape of the first run in cell (r, c).
fn cell_shape<'a>(d: &'a SemanticDoc, t: &Table, r: usize, c: usize) -> &'a CharShape {
    let cell = t.cells.iter().find(|x| x.row == r && x.col == c).unwrap();
    let Block::Paragraph(p) = &cell.blocks[0] else {
        panic!("cell paragraph")
    };
    &d.char_shapes[p.runs[0].char_shape]
}

fn first_table_with<'a>(d: &'a SemanticDoc, text: &str) -> &'a Table {
    d.sections[0]
        .blocks
        .iter()
        .find_map(|b| match b {
            Block::Table(t)
                if t.cells.iter().any(|c| {
                    c.blocks.iter().any(|b| match b {
                        Block::Paragraph(p) => p
                            .runs
                            .iter()
                            .flat_map(|r| &r.content)
                            .any(|i| matches!(i, Inline::Text(x) if x == text)),
                        _ => false,
                    })
                }) =>
            {
                Some(t)
            }
            _ => None,
        })
        .unwrap_or_else(|| panic!("table containing {text:?}"))
}

fn export(s: &Session) -> (Vec<u8>, String, String) {
    let bytes = export_bytes(s).expect("export");
    assert!(
        hwp_hwpx::export::validate_open_safety(&bytes).ok,
        "open-safe"
    );
    let pkg = Package::open(&bytes).unwrap();
    let header = String::from_utf8_lossy(&pkg.read_header().unwrap()).into_owned();
    let section =
        String::from_utf8_lossy(&pkg.read_part("Contents/section0.xml").unwrap()).into_owned();
    (bytes, header, section)
}

fn attr<'a>(s: &'a str, name: &str) -> &'a str {
    let k = format!(" {name}=\"");
    let i = s.find(&k).unwrap_or_else(|| panic!("{name} in {s:.160}")) + k.len();
    &s[i..i + s[i..].find('"').unwrap()]
}

/// The `<hp:tbl …>` open tag of the table holding `marker`, and the `<hp:tc …>` holding each text.
fn tbl_tags<'a>(section: &'a str, marker: &str, cells: &[&str]) -> (&'a str, Vec<&'a str>) {
    let at = section.find(marker).expect("marker in section");
    let tbl = &section[section[..at].rfind("<hp:tbl ").unwrap()..];
    let tcs = cells
        .iter()
        .map(|t| {
            let p = tbl.find(t).unwrap();
            &tbl[tbl[..p].rfind("<hp:tc ").unwrap()..p]
        })
        .collect();
    (&tbl[..tbl.find('>').unwrap()], tcs)
}

fn border_fill<'a>(header: &'a str, id: &str) -> &'a str {
    let start = header
        .find(&format!("<hh:borderFill id=\"{id}\""))
        .unwrap_or_else(|| panic!("borderFill {id}"));
    &header[start..start + header[start..].find("</hh:borderFill>").unwrap()]
}

fn edges(bf: &str) -> Vec<(String, String)> {
    ["leftBorder", "rightBorder", "topBorder", "bottomBorder"]
        .iter()
        .map(|c| {
            let e = &bf[bf.find(&format!("<hh:{c} ")).unwrap()..];
            (attr(e, "type").to_string(), attr(e, "width").to_string())
        })
        .collect()
}

#[test]
fn cells_inherit_the_body_face_and_size_but_not_its_emphasis() {
    // footnote-01: block 4 = bold 15pt 휴먼명조 heading line, blocks 5.. = 15pt 휴먼명조 body.
    let mut s = open("footnote-01.hwpx");
    let nb = {
        let Block::Paragraph(p) = &doc(&s).sections[0].blocks[4] else {
            panic!()
        };
        doc(&s).char_shapes[p.runs[0].char_shape].clone()
    };
    assert!(nb.bold && nb.height == 1500, "fixture: bold 15pt neighbour");
    insert(
        &mut s,
        5,
        vec![vec![cell("A3본문", false), cell("A3굵게", true)]],
        None,
        None,
        None,
    )
    .unwrap();

    for (d, ctx) in [
        (doc(&s).clone(), "memory"),
        (parse_semantic(&export(&s).0).unwrap(), "reopened"),
    ] {
        let t = first_table_with(&d, "A3본문");
        let plain = cell_shape(&d, t, 0, 0);
        let bold = cell_shape(&d, t, 0, 1);
        assert_eq!(
            plain.height, 1500,
            "{ctx}: plain cell is the body size (was 10pt)"
        );
        assert_eq!(
            plain.font_family.as_deref(),
            Some("휴먼명조"),
            "{ctx}: body face"
        );
        assert!(!plain.bold, "{ctx}: the neighbour's bold is NOT inherited");
        assert_eq!(bold.height, 1500, "{ctx}: bold cell keeps the body size");
        assert!(bold.bold, "{ctx}: CellSpec.bold still applies");
    }
}

#[test]
fn explicit_border_overrides_a_borderless_first_table() {
    // Build the A-3 repro from the public corpus: make the document's FIRST table a borderless layout
    // table, reopen, then insert a new table. Without `border` it borrows the borderless fill (the
    // documented legacy rule); with `border` it gets the requested line.
    let mut s = open("FormattingShowcase.hwpx");
    let none = hwp_ops::TableBorderSpec {
        kind: Some("none".into()),
        ..Default::default()
    };
    insert(
        &mut s,
        0,
        vec![vec![cell("배치표", false)]],
        Some(none),
        None,
        None,
    )
    .unwrap();
    let (bytes, header, section) = export(&s);
    let (tbl, tcs) = tbl_tags(&section, "배치표", &["배치표"]);
    assert_eq!(
        edges(border_fill(&header, attr(tcs[0], "borderFillIDRef")))[0].0,
        "NONE"
    );
    assert_eq!(
        edges(border_fill(&header, attr(tbl, "borderFillIDRef")))[0].0,
        "NONE"
    );

    let mut s = Session::default();
    open_bytes(&mut s, &bytes, "re.hwpx").unwrap();
    let solid = hwp_ops::TableBorderSpec {
        kind: Some("solid".into()),
        width_mm: Some(0.4),
        color: Some("#1F4E79".into()),
    };
    insert(
        &mut s,
        3,
        vec![vec![cell("지정표", false), cell("칸", false)]],
        Some(solid),
        None,
        None,
    )
    .unwrap();
    let (_, header, section) = export(&s);
    let (tbl, tcs) = tbl_tags(&section, "지정표", &["지정표", "칸"]);
    for tag in [tbl, tcs[0], tcs[1]] {
        let bf = border_fill(&header, attr(tag, "borderFillIDRef"));
        assert_eq!(
            edges(bf),
            vec![("SOLID".to_string(), "0.4 mm".to_string()); 4],
            "outline and cells carry the requested line"
        );
        assert!(bf.contains("color=\"#1F4E79\""));
    }
}

#[test]
fn col_widths_scale_to_the_text_width_and_export_real_widths() {
    let mut s = open("FormattingShowcase.hwpx");
    // Text width = 59528 − 2·8504 = 42520.
    insert(
        &mut s,
        1,
        vec![vec![cell("기본A", false), cell("기본B", false)]],
        None,
        None,
        None,
    )
    .unwrap();
    insert(
        &mut s,
        1,
        vec![vec![cell("비율A", false), cell("비율B", false)]],
        None,
        Some(vec![1.0, 3.0]),
        None,
    )
    .unwrap();
    assert_eq!(
        first_table_with(doc(&s), "기본A").col_widths,
        vec![21260, 21260]
    );
    assert_eq!(
        first_table_with(doc(&s), "비율A").col_widths,
        vec![10630, 31890]
    );

    let (_, _, section) = export(&s);
    for (marker, a, b, want) in [
        ("기본A", "기본A", "기본B", ["21260", "21260"]),
        ("비율A", "비율A", "비율B", ["10630", "31890"]),
    ] {
        let (tbl, _) = tbl_tags(&section, marker, &[]);
        let full = &section[section.find(tbl).unwrap()..];
        let sz = &full[full.find("<hp:sz ").unwrap()..];
        assert_eq!(
            attr(sz, "width"),
            "42520",
            "{marker}: table spans the text width (was n HWPUNIT)"
        );
        for (text, w) in [(a, want[0]), (b, want[1])] {
            let tc = &full[full.find(text).unwrap()..];
            let csz = &tc[tc.find("<hp:cellSz ").unwrap()..];
            assert_eq!(attr(csz, "width"), w, "{marker}/{text}");
        }
    }
}

#[test]
fn header_row_repeats_by_default_and_can_be_turned_off() {
    let mut s = open("FormattingShowcase.hwpx");
    let rows = |m: &str| vec![vec![cell(m, true)], vec![cell("본문", false)]];
    insert(&mut s, 1, rows("머리켬"), None, None, None).unwrap();
    insert(&mut s, 1, rows("머리끔"), None, None, Some(false)).unwrap();
    assert!(
        first_table_with(doc(&s), "머리켬").repeat_first_row,
        "render repeats by default"
    );
    assert!(!first_table_with(doc(&s), "머리끔").repeat_first_row);

    let (bytes, _, section) = export(&s);
    let (on, on_tc) = tbl_tags(&section, "머리켬", &["머리켬"]);
    let (off, off_tc) = tbl_tags(&section, "머리끔", &["머리끔"]);
    assert_eq!(attr(on, "repeatHeader"), "1");
    assert_eq!(attr(on_tc[0], "header"), "1");
    assert_eq!(attr(off, "repeatHeader"), "0");
    assert_eq!(attr(off_tc[0], "header"), "0");
    let re = parse_semantic(&bytes).unwrap();
    assert!(first_table_with(&re, "머리켬").repeat_first_row);
    assert!(!first_table_with(&re, "머리끔").repeat_first_row);
}

#[test]
fn bad_options_are_honest_errors_and_change_nothing() {
    let mut s = open("FormattingShowcase.hwpx");
    let n = doc(&s).sections[0].blocks.len();
    let row = || vec![vec![cell("a", false), cell("b", false)]];
    assert!(
        insert(&mut s, 1, row(), None, Some(vec![1.0]), None).is_err(),
        "wrong length"
    );
    assert!(
        insert(&mut s, 1, row(), None, Some(vec![1.0, 0.0]), None).is_err(),
        "non-positive"
    );
    let bad = hwp_ops::TableBorderSpec {
        kind: Some("wavy".into()),
        ..Default::default()
    };
    assert!(
        insert(&mut s, 1, row(), Some(bad), None, None).is_err(),
        "unknown type"
    );
    let bad = hwp_ops::TableBorderSpec {
        color: Some("blue".into()),
        ..Default::default()
    };
    assert!(
        insert(&mut s, 1, row(), Some(bad), None, None).is_err(),
        "bad color"
    );
    assert_eq!(doc(&s).sections[0].blocks.len(), n, "no partial insert");
}

#[test]
fn json_wire_shape_is_additive_and_strict() {
    let ok: Intent = serde_json::from_value(serde_json::json!({
        "intent": "InsertTableAt", "section": 0, "index": 1,
        "rows": [[{"text": "a"}, {"text": "b"}]],
        "border": {"type": "solid", "width_mm": 0.12, "color": "#000000"},
        "col_widths": [1, 2],
        "header_row": true
    }))
    .expect("new optional fields parse");
    assert!(matches!(
        ok,
        Intent::InsertTableAt {
            header_row: Some(true),
            ..
        }
    ));
    // Old payloads (no new fields) still parse.
    serde_json::from_value::<Intent>(serde_json::json!({
        "intent": "InsertTableAt", "section": 0, "rows": [[{}]]
    }))
    .expect("legacy payload");
    // A misspelled border key is rejected, not ignored.
    assert!(serde_json::from_value::<Intent>(serde_json::json!({
        "intent": "InsertTableAt", "section": 0, "rows": [[{}]],
        "border": {"style": "solid"}
    }))
    .is_err());
}
