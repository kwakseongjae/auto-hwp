//! #430 — `InsertTableAt` 새 표의 칸 문단 모양.
//!
//! 고치기 전: 새 표의 칸 문단은 엔진 기본 문단 모양(index 0)이었고, HWPX 내보내기는 그것을 구역의 마지막
//! `paraPrIDRef` — 이웃 본문(목록) 문단의 모양 — 로 썼다. 예: `FormattingShowcase.hwpx` 의 새 표 칸이
//! paraPr 12(위 12pt · 아래 3pt)를 가리켜, 한/글이 칸 안에서도 위 간격을 적용해 칸이 늘고 글이 아래 선에 붙었다.
//!
//! 기대: 칸 문단은 칸용 문단 모양 — 위 · 아래 간격 0, 줄 간격은 본문과 같음. 문서에 이미 표 칸 문단 모양
//! (간격 · 들여쓰기 없음, 왼쪽/양쪽 정렬)이 있으면 그것을 재사용한다.

use hwp_hwpx::package::Package;
use hwp_hwpx::parse::parse_semantic;
use hwp_mcp::{apply_intent, export_bytes, open_bytes, Intent, Session};
use hwp_model::prelude::*;

fn corpus(name: &str) -> Vec<u8> {
    let p = format!("{}/../../corpus/hwpx/{name}", env!("CARGO_MANIFEST_DIR"));
    std::fs::read(&p).unwrap_or_else(|e| panic!("read {p}: {e}"))
}

fn open(name: &str) -> Session {
    let mut s = Session::default();
    open_bytes(&mut s, &corpus(name), name).expect("open");
    s
}

fn insert(s: &mut Session, index: usize, a: &str, b: &str) {
    let cell = |t: &str| hwp_ops::CellSpec {
        text: t.into(),
        ..Default::default()
    };
    apply_intent(
        s,
        Intent::InsertTableAt {
            section: 0,
            index: Some(index),
            rows: vec![vec![cell(a), cell(b)], vec![cell("둘째"), cell("행")]],
            border: None,
            col_widths: None,
            header_row: None,
        },
    )
    .expect("insert");
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

/// Every `paraPrIDRef` of the cell paragraphs of the exported table holding `marker`.
fn cell_para_refs(section: &str, marker: &str) -> Vec<String> {
    let at = section.find(marker).expect("marker in section");
    let start = section[..at].rfind("<hp:tbl ").unwrap();
    let tbl = &section[start..start + section[start..].find("</hp:tbl>").unwrap()];
    tbl.match_indices("<hp:p ")
        .map(|(i, _)| {
            let tag = &tbl[i..i + tbl[i..].find('>').unwrap()];
            attr(tag, "paraPrIDRef").to_string()
        })
        .collect()
}

/// The `<hh:paraPr id=…>` element (its 2016 `hp:case` branch = the real values).
fn para_pr<'a>(header: &'a str, id: &str) -> &'a str {
    let start = header
        .find(&format!("<hh:paraPr id=\"{id}\""))
        .unwrap_or_else(|| panic!("paraPr {id}"));
    let el = &header[start..start + header[start..].find("</hh:paraPr>").unwrap()];
    el.split("<hp:default>").next().unwrap()
}

fn hc(el: &str, name: &str) -> i32 {
    let k = format!("<hc:{name} value=\"");
    let i = el.find(&k).unwrap_or_else(|| panic!("{name}")) + k.len();
    el[i..i + el[i..].find('"').unwrap()].parse().unwrap()
}

fn line_spacing(el: &str) -> (String, String) {
    let e = &el[el.find("<hh:lineSpacing").unwrap()..];
    (attr(e, "type").to_string(), attr(e, "value").to_string())
}

/// The model para shape of every cell paragraph in the table holding `marker`.
fn model_cell_shapes(d: &SemanticDoc, marker: &str) -> Vec<ParaShape> {
    let has = |p: &Paragraph| {
        p.runs
            .iter()
            .flat_map(|r| &r.content)
            .any(|i| matches!(i, Inline::Text(x) if x == marker))
    };
    let t = d.sections[0]
        .blocks
        .iter()
        .find_map(|b| match b {
            Block::Table(t)
                if t.cells.iter().any(|c| {
                    c.blocks
                        .iter()
                        .any(|b| matches!(b, Block::Paragraph(p) if has(p)))
                }) =>
            {
                Some(t)
            }
            _ => None,
        })
        .expect("table");
    t.cells
        .iter()
        .flat_map(|c| &c.blocks)
        .filter_map(|b| match b {
            Block::Paragraph(p) => Some(d.para_shapes[p.para_shape].clone()),
            _ => None,
        })
        .collect()
}

#[test]
fn new_table_cells_do_not_take_the_neighbouring_body_spacing() {
    // FormattingShowcase: block 1 sits between body paragraphs on paraPr 12 (위 12pt · 아래 3pt, 160%).
    // Its only table's cells are CENTRED — not a plain cell shape to reuse — so the engine synthesizes.
    let mut s = open("FormattingShowcase.hwpx");
    insert(&mut s, 1, "칸문단430", "옆칸");
    let (bytes, header, section) = export(&s);

    let refs = cell_para_refs(&section, "칸문단430");
    assert_eq!(refs.len(), 4, "one paragraph per cell");
    assert!(
        refs.iter().all(|r| r == &refs[0]),
        "every cell shares one shape: {refs:?}"
    );
    assert_ne!(
        refs[0], "12",
        "not the neighbouring body paraPr (위 12pt · 아래 3pt)"
    );
    let el = para_pr(&header, &refs[0]);
    assert_eq!(hc(el, "prev"), 0, "위 간격 0: {el:.400}");
    assert_eq!(hc(el, "next"), 0, "아래 간격 0");
    assert_eq!(
        (hc(el, "intent"), hc(el, "left"), hc(el, "right")),
        (0, 0, 0)
    );
    assert_eq!(
        line_spacing(el),
        line_spacing(para_pr(&header, "12")),
        "줄 간격은 본문과 같다"
    );

    // Memory (what the engine typesets) and the reopened file agree.
    for (d, ctx) in [
        (s.doc.as_ref().unwrap().doc().clone(), "memory"),
        (parse_semantic(&bytes).unwrap(), "reopened"),
    ] {
        for ps in model_cell_shapes(&d, "칸문단430") {
            assert_eq!(
                (ps.space_before, ps.space_after),
                (0, 0),
                "{ctx}: cell paragraph spacing"
            );
            assert_eq!(ps.line_spacing_value, 160, "{ctx}: body line spacing");
        }
    }
}

#[test]
fn new_table_cells_reuse_the_documents_own_cell_paragraph_shape() {
    // footnote-01: its tables' cell paragraphs use paraPr 8 (CENTER) ×5 and paraPr 7 (JUSTIFY, no
    // spacing / indent) ×3 → the plain cell shape is 7, which the new table must reference as-is.
    let mut s = open("footnote-01.hwpx");
    insert(&mut s, 5, "재사용430", "옆칸");
    // In memory the new cells point at the SAME pool index as the existing justified cell paragraphs
    // (before: the engine-default index 0, whatever the export then resolved it to).
    let d = s.doc.as_ref().unwrap().doc();
    let existing = d.sections[0]
        .blocks
        .iter()
        .filter_map(|b| match b {
            Block::Table(t) => Some(t),
            _ => None,
        })
        .flat_map(|t| &t.cells)
        .flat_map(|c| &c.blocks)
        .find_map(|b| match b {
            Block::Paragraph(p)
                if d.para_shapes[p.para_shape].align == HorizontalAlign::Justify
                    && !p.runs.iter().flat_map(|r| &r.content).any(
                        |i| matches!(i, Inline::Text(x) if x == "재사용430" || x == "옆칸" || x == "둘째" || x == "행"),
                    ) =>
            {
                Some(p.para_shape)
            }
            _ => None,
        })
        .expect("an existing justified cell paragraph");
    assert!(d.hwpx_pool_para_shapes.contains(&existing), "a pool shape");
    for ps in model_cell_shapes(d, "재사용430") {
        assert_eq!(
            ps, d.para_shapes[existing],
            "memory: the document's own cell shape"
        );
    }
    let new_idx = {
        let t = d.sections[0].blocks[5].clone();
        let Block::Table(t) = t else {
            panic!("new table at 5")
        };
        let Block::Paragraph(p) = &t.cells[0].blocks[0] else {
            panic!()
        };
        p.para_shape
    };
    assert_eq!(new_idx, existing, "memory: same pool index, not a copy");
    let (_, header, section) = export(&s);
    let refs = cell_para_refs(&section, "재사용430");
    assert_eq!(refs, vec!["7"; 4], "the document's own cell paraPr");
    let el = para_pr(&header, "7");
    assert_eq!((hc(el, "prev"), hc(el, "next")), (0, 0));
}
