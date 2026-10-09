//! #440 — `InsertTableAt` 표를 **담는 문단**의 문단 모양 · #439 — 내보낸 뒤 다시 열면 생기는 담는 문단 블록.
//!
//! 고치기 전(#440): 담는 문단은 문단 모양이 없어 HWPX 내보내기가 구역의 **마지막** `paraPrIDRef` 를 썼다. 그 값은
//! 무관한 편집에 따라 달라진다 — 넣은 자리 뒤의 기존 표 칸을 고치면 구역 XML 이 다시 쓰이며 담는 문단이 앞 문단의
//! 모양(예: 「다음 문단과 함께」)을 물려받아 한/글에서 표가 다음 쪽으로 밀렸다. `FormattingShowcase.hwpx` 에서는
//! 처음부터 목록 문단 모양(12, 위 12pt)으로 나갔다.
//!
//! 기대: 담는 문단 = 문서의 기본 문단 모양(`paraPr id="0"`), 편집 순서와 무관하게 같다.
//!
//! #439: 파싱한 모든 표는 「표 + 담는 문단」 두 블록이다. 넣은 표는 메모리에서 한 블록이고, 저장 → 다시 열면 다른 표처럼
//! 담는 문단(`is_table_anchor`, 빈 줄 아님)이 뒤에 붙는다. 한/글 XML 에 빈 문단이 더 생기지 않고, 쪽 수도 같다.

use hwp_hwpx::package::Package;
use hwp_mcp::{apply_intent, export_bytes, open_bytes, Intent, Outcome, Session};
use hwp_model::prelude::*;

fn corpus(name: &str) -> Vec<u8> {
    let p = format!("{}/../../corpus/hwpx/{name}", env!("CARGO_MANIFEST_DIR"));
    std::fs::read(&p).unwrap_or_else(|e| panic!("read {p}: {e}"))
}

fn open(bytes: &[u8]) -> Session {
    let mut s = Session::default();
    open_bytes(&mut s, bytes, "x.hwpx").expect("open");
    s
}

fn insert(s: &mut Session, index: usize) {
    let cell = |t: &str| hwp_ops::CellSpec {
        text: t.into(),
        ..Default::default()
    };
    apply_intent(
        s,
        Intent::InsertTableAt {
            section: 0,
            index: Some(index),
            rows: vec![vec![cell("가"), cell("나")], vec![cell(""), cell("")]],
            border: None,
            col_widths: None,
            header_row: None,
        },
    )
    .expect("insert");
}

fn sections(bytes: &[u8]) -> (String, String) {
    assert!(
        hwp_hwpx::export::validate_open_safety(bytes).ok,
        "open-safe"
    );
    let pkg = Package::open(bytes).unwrap();
    let header = String::from_utf8_lossy(&pkg.read_header().unwrap()).into_owned();
    let sec =
        String::from_utf8_lossy(&pkg.read_part("Contents/section0.xml").unwrap()).into_owned();
    (header, sec)
}

fn attr<'a>(s: &'a str, name: &str) -> &'a str {
    let k = format!(" {name}=\"");
    let i = s.find(&k).unwrap_or_else(|| panic!("{name} in {s:.160}")) + k.len();
    &s[i..i + s[i..].find('"').unwrap()]
}

/// `paraPrIDRef` of the `<hp:p>` holding the table whose first cell text is `marker`.
fn holder_ref(sec: &str, marker: &str) -> String {
    let at = sec.find(&format!("<hp:t>{marker}</hp:t>")).expect("marker");
    let tbl = sec[..at].rfind("<hp:tbl ").unwrap();
    let p = sec[..tbl].rfind("<hp:p ").unwrap();
    attr(&sec[p..p + sec[p..].find('>').unwrap()], "paraPrIDRef").to_string()
}

fn para_pr<'a>(header: &'a str, id: &str) -> &'a str {
    let start = header
        .find(&format!("<hh:paraPr id=\"{id}\""))
        .expect("paraPr");
    &header[start..start + header[start..].find("</hh:paraPr>").unwrap()]
}

fn table_blocks(s: &Session) -> Vec<usize> {
    s.doc.as_ref().unwrap().doc().sections[0]
        .blocks
        .iter()
        .enumerate()
        .filter(|(_, b)| matches!(b, Block::Table(_)))
        .map(|(i, _)| i)
        .collect()
}

fn pages(s: &mut Session) -> u32 {
    match apply_intent(s, Intent::PageCount).expect("pages") {
        Outcome::PageCount(n) => n,
        _ => unreachable!(),
    }
}

#[test]
fn holder_uses_default_shape_independent_of_later_edits() {
    let mut s = open(&corpus("FormattingShowcase.hwpx"));
    insert(&mut s, 1);
    let (header, sec) = sections(&export_bytes(&s).unwrap());
    let first = holder_ref(&sec, "가");
    assert_eq!(
        first, "0",
        "holder = the document's default paragraph shape"
    );
    assert!(
        para_pr(&header, "0").contains("keepWithNext=\"0\""),
        "the default shape does not keep with next"
    );

    // Edit a cell of the EXISTING table further down → the section is re-serialized.
    let later = *table_blocks(&s).last().unwrap();
    assert!(later > 1, "an existing table after the insert point");
    apply_intent(
        &mut s,
        Intent::SetTableCell {
            section: 0,
            index: later,
            row: 0,
            col: 0,
            text: "바뀜".into(),
        },
    )
    .unwrap();
    let (_, sec2) = sections(&export_bytes(&s).unwrap());
    assert_eq!(
        holder_ref(&sec2, "가"),
        first,
        "holder shape does not move with later edits"
    );

    // …and an earlier paragraph edit does not move it either.
    apply_intent(
        &mut s,
        Intent::SetParagraphText {
            section: 0,
            block: 2,
            text: "앞 문단".into(),
        },
    )
    .unwrap();
    let (_, sec3) = sections(&export_bytes(&s).unwrap());
    assert_eq!(holder_ref(&sec3, "가"), first);
}

#[test]
fn holder_reopens_as_the_table_anchor_with_the_same_page_count() {
    let mut s = open(&corpus("FormattingShowcase.hwpx"));
    insert(&mut s, 1);
    let mem_pages = pages(&mut s);
    let out = export_bytes(&s).unwrap();
    let (_, sec) = sections(&out);
    // One holder <hp:p> per table and no extra empty paragraph right after the inserted one.
    let tbl_end = sec[sec.find("<hp:t>가</hp:t>").unwrap()..]
        .find("</hp:tbl>")
        .unwrap();
    let after = &sec[sec.find("<hp:t>가</hp:t>").unwrap() + tbl_end..];
    let next_p = &after[after.find("<hp:p ").unwrap()..];
    assert!(
        !next_p[..next_p.find("</hp:p>").unwrap()]
            .contains("<hp:t></hp:t></hp:run><hp:linesegarray"),
        "no blank paragraph after the table"
    );

    let mut re = open(&out);
    let blocks = &re.doc.as_ref().unwrap().doc().sections[0].blocks;
    assert!(matches!(blocks[1], Block::Table(_)));
    let Block::Paragraph(anchor) = &blocks[2] else {
        panic!("holder block after the table")
    };
    assert!(
        anchor.is_table_anchor,
        "the holder reopens as the table's anchor, like every parsed table"
    );
    assert_eq!(
        pages(&mut re),
        mem_pages,
        "same page count in memory and after reopening"
    );
}
