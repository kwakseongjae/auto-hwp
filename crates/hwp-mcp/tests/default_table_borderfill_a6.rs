//! A-6 — 표가 하나도 없는 문서에 표를 넣으면 한/글에서 **선 없는 표**가 되던 회귀 가드.
//!
//! 원인: HWPX 직렬화기가 새 표의 `borderFillIDRef` 를 「문서 첫 표의 borderFill」 에서 빌리는데, 표가
//! 없으면 header 의 **가장 큰 borderFill id** 로 넘어갔다. Hancom 이 만든 문서에서 그 항목은 대개
//! 쪽 테두리 · 글자 테두리용 **선없음**이라, 새 표와 칸 음영(그 항목을 복제해 합성)이 선 없이 나갔다.
//! 우리 화면은 칸 테두리 데이터가 없는 표에 기본 실선 상자를 그리므로 화면과 파일이 달랐다.

use hwp_hwpx::package::Package;
use hwp_mcp::{apply_intent, export_bytes, open_bytes, Intent, Session};

fn corpus(name: &str) -> Vec<u8> {
    let p = format!("{}/../../corpus/hwpx/{name}", env!("CARGO_MANIFEST_DIR"));
    std::fs::read(&p).unwrap_or_else(|e| panic!("read {p}: {e}"))
}

fn cell(text: &str, shade: Option<&str>) -> hwp_ops::CellSpec {
    hwp_ops::CellSpec {
        text: text.into(),
        shade: shade.map(str::to_string),
        ..Default::default()
    }
}

/// Open `name`, insert a 1×2 table (second cell shaded) at the end, export.
fn insert_and_export(name: &str) -> (String, String) {
    let src = corpus(name);
    let mut s = Session::default();
    open_bytes(&mut s, &src, name).expect("open");
    apply_intent(
        &mut s,
        Intent::InsertTableAt {
            section: 0,
            index: None,
            rows: vec![vec![cell("A6표", None), cell("음영", Some("#FFCC00"))]],
            border: None,
            col_widths: None,
            header_row: None,
            treat_as_char: None,
        },
    )
    .expect("InsertTableAt applies");
    let bytes = export_bytes(&s).expect("export");
    assert!(
        hwp_hwpx::export::validate_open_safety(&bytes).ok,
        "{name}: open-safe"
    );
    let pkg = Package::open(&bytes).unwrap();
    let header = String::from_utf8_lossy(&pkg.read_header().unwrap()).into_owned();
    let section =
        String::from_utf8_lossy(&pkg.read_part("Contents/section0.xml").unwrap()).into_owned();
    (header, section)
}

fn attr<'a>(s: &'a str, name: &str) -> &'a str {
    let k = format!("{name}=\"");
    let i = s.find(&k).unwrap_or_else(|| panic!("{name} in {s:.120}")) + k.len();
    &s[i..i + s[i..].find('"').unwrap()]
}

fn border_fill<'a>(header: &'a str, id: &str) -> &'a str {
    let start = header
        .find(&format!("<hh:borderFill id=\"{id}\""))
        .unwrap_or_else(|| panic!("borderFill {id} exists in header"));
    let end = start + header[start..].find("</hh:borderFill>").unwrap();
    &header[start..end]
}

fn edge_types(bf: &str) -> Vec<String> {
    ["leftBorder", "rightBorder", "topBorder", "bottomBorder"]
        .iter()
        .map(|c| {
            let i = bf.find(&format!("<hh:{c} ")).expect("edge child");
            attr(&bf[i..], "type").to_string()
        })
        .collect()
}

/// The `<hp:tbl>` holding `marker`, and the `<hp:tc>` holding each given cell text.
fn tbl_and_cells<'a>(section: &'a str, marker: &str, cells: &[&str]) -> (&'a str, Vec<&'a str>) {
    let at = section.find(marker).expect("new table text in section");
    let tbl = &section[section[..at].rfind("<hp:tbl ").unwrap()..];
    let tcs = cells
        .iter()
        .map(|t| {
            let p = tbl.find(t).unwrap();
            &tbl[tbl[..p].rfind("<hp:tc ").unwrap()..p]
        })
        .collect();
    (tbl, tcs)
}

#[test]
fn table_in_a_table_less_document_gets_visible_solid_borders() {
    for name in ["Skeleton.hwpx", "form-01.hwpx", "00_smoke_min.hwpx"] {
        let (header, section) = insert_and_export(name);
        let (tbl, tcs) = tbl_and_cells(&section, "A6표", &["A6표", "음영"]);

        let tbl_bf = border_fill(&header, attr(tbl, "borderFillIDRef"));
        assert_eq!(
            edge_types(tbl_bf),
            ["SOLID"; 4],
            "{name}: table outline is solid"
        );

        let plain = border_fill(&header, attr(tcs[0], "borderFillIDRef"));
        assert_eq!(
            edge_types(plain),
            ["SOLID"; 4],
            "{name}: plain cell is solid"
        );
        assert!(
            !plain.contains("faceColor=\"#"),
            "{name}: plain cell has no fill"
        );

        let shaded = border_fill(&header, attr(tcs[1], "borderFillIDRef"));
        assert_eq!(
            edge_types(shaded),
            ["SOLID"; 4],
            "{name}: shaded cell keeps lines"
        );
        assert!(
            shaded.contains("faceColor=\"#FFCC00\""),
            "{name}: shaded cell carries its fill"
        );
        // header itemCnt matches the entries (Hancom refuses a mismatch).
        let pool = &header[header.find("<hh:borderFills").unwrap()..];
        let pool = &pool[..pool.find("</hh:borderFills>").unwrap()];
        assert_eq!(
            attr(pool, "itemCnt").parse::<usize>().unwrap(),
            pool.matches("<hh:borderFill ").count(),
            "{name}: borderFills itemCnt"
        );
    }
}

#[test]
fn document_with_a_table_still_borrows_its_borderfill() {
    // FormattingShowcase has a table (borderFill 3, solid) — unchanged behaviour: reuse it.
    let (header, section) = insert_and_export("FormattingShowcase.hwpx");
    let (tbl, tcs) = tbl_and_cells(&section, "A6표", &["A6표"]);
    assert_eq!(attr(tbl, "borderFillIDRef"), "3");
    assert_eq!(attr(tcs[0], "borderFillIDRef"), "3");
    let _ = header;
}

#[test]
fn no_table_emitted_means_no_new_borderfill() {
    // A paragraph-only edit on a table-less document must not touch the borderFill pool.
    let src = corpus("Skeleton.hwpx");
    let before =
        String::from_utf8_lossy(&Package::open(&src).unwrap().read_header().unwrap()).into_owned();
    let mut s = Session::default();
    open_bytes(&mut s, &src, "Skeleton.hwpx").expect("open");
    apply_intent(
        &mut s,
        Intent::InsertParagraphAt {
            section: 0,
            index: None,
            runs: vec![hwp_ops::RunSpec {
                text: "문단만".into(),
                ..Default::default()
            }],
            para: Default::default(),
        },
    )
    .unwrap();
    let bytes = export_bytes(&s).unwrap();
    let after = String::from_utf8_lossy(&Package::open(&bytes).unwrap().read_header().unwrap())
        .into_owned();
    let pool = |h: &str| {
        let p = &h[h.find("<hh:borderFills").unwrap()..];
        p[..p.find("</hh:borderFills>").unwrap()].to_string()
    };
    assert_eq!(pool(&before), pool(&after));
}
