//! #409 — `InsertTableAt` 으로 넣은 표(그리고 `MoveBlock` 으로 옮긴 그 표)가 `export_bytes` 뒤
//! 다시 열면 **구역 끝**에 가 있던 회귀 가드.
//!
//! 원인: HWPX 직렬화기의 W4.1 앵커 레인(`anchor_new_paragraphs`)이 **새 문단만** 원본 바이트에
//! 앵커하고, 원본 스팬이 없는 새 표는 구역 끝 append 레인으로 보냈다. 메모리 문서의 블록 순서와
//! 내보낸 파일의 문단 순서가 어긋났다.
//!
//! 블록 수는 단언하지 않는다 — 새 표는 감싸는 `<hp:p>` 와 함께 나가므로 다시 열면 표 + 호스트
//! 문단(2블록)이 된다. 대신 **새 표의 블록 위치와 이웃과의 상대 순서**를 본다.

use hwp_hwpx::parse::parse_semantic;
use hwp_mcp::{apply_intent, export_bytes, open_bytes, Intent, Outcome, Session};
use hwp_model::prelude::*;

fn corpus(name: &str) -> Vec<u8> {
    let p = format!("{}/../../corpus/hwpx/{name}", env!("CARGO_MANIFEST_DIR"));
    std::fs::read(&p).unwrap_or_else(|e| panic!("read {p}: {e}"))
}

const MARK: &str = "새표409";

fn first_cell_text(t: &Table) -> String {
    t.cells
        .iter()
        .find(|c| c.row == 0 && c.col == 0)
        .map(|c| {
            c.blocks
                .iter()
                .filter_map(|b| match b {
                    Block::Paragraph(p) => Some(
                        p.runs
                            .iter()
                            .flat_map(|r| &r.content)
                            .filter_map(|i| match i {
                                Inline::Text(t) => Some(t.as_str()),
                                _ => None,
                            })
                            .collect::<String>(),
                    ),
                    Block::Table(_) => None,
                })
                .collect()
        })
        .unwrap_or_default()
}

fn para_text(b: &Block) -> Option<String> {
    match b {
        Block::Paragraph(p) => Some(
            p.runs
                .iter()
                .flat_map(|r| &r.content)
                .filter_map(|i| match i {
                    Inline::Text(t) => Some(t.as_str()),
                    _ => None,
                })
                .collect(),
        ),
        Block::Table(_) => None,
    }
}

/// Block index of the inserted table (its first cell carries [`MARK`]).
fn new_table_at(doc: &SemanticDoc) -> usize {
    doc.sections[0]
        .blocks
        .iter()
        .position(|b| matches!(b, Block::Table(t) if first_cell_text(t) == MARK))
        .expect("the inserted table survives the round trip")
}

/// Block index of the first paragraph whose text starts with `prefix`.
fn para_at(doc: &SemanticDoc, prefix: &str) -> usize {
    doc.sections[0]
        .blocks
        .iter()
        .position(|b| para_text(b).is_some_and(|t| t.starts_with(prefix)))
        .unwrap_or_else(|| panic!("paragraph starting with {prefix:?}"))
}

/// `(rows, cols, first cell)` of every ORIGINAL table (the inserted one excluded), in block order.
fn original_tables(doc: &SemanticDoc) -> Vec<(usize, usize, String)> {
    doc.sections[0]
        .blocks
        .iter()
        .filter_map(|b| match b {
            Block::Table(t) if first_cell_text(t) != MARK => {
                Some((t.rows, t.cols, first_cell_text(t)))
            }
            _ => None,
        })
        .collect()
}

fn open(name: &str) -> (Session, SemanticDoc) {
    let src = corpus(name);
    let before = parse_semantic(&src).unwrap();
    let mut s = Session::default();
    open_bytes(&mut s, &src, name).expect("open hwpx");
    (s, before)
}

fn insert_table(s: &mut Session, index: usize) {
    let out = apply_intent(
        s,
        Intent::InsertTableAt {
            section: 0,
            index: Some(index),
            rows: vec![vec![
                hwp_ops::CellSpec {
                    text: MARK.into(),
                    ..Default::default()
                },
                hwp_ops::CellSpec {
                    text: "둘째 칸".into(),
                    ..Default::default()
                },
            ]],
            border: None,
            col_widths: None,
            header_row: None,
        },
    )
    .expect("InsertTableAt applies");
    assert!(!matches!(out, Outcome::Discarded(_)), "edit applied");
}

fn reopen(s: &Session) -> SemanticDoc {
    let bytes = export_bytes(s).expect("export_bytes");
    assert!(
        hwp_hwpx::export::validate_open_safety(&bytes).ok,
        "exported package is open-safe"
    );
    parse_semantic(&bytes).expect("reopen")
}

fn block_text_of(doc: &SemanticDoc, bi: usize) -> String {
    para_text(&doc.sections[0].blocks[bi]).unwrap_or_default()
}

#[test]
fn inserted_table_exports_at_its_block_index() {
    // FormattingShowcase: [P, P(형식 테스트…), …, T3x3, P(host), P(표 1. …)]. 이슈 재현 그대로.
    let (mut s, before) = open("FormattingShowcase.hwpx");
    let displaced = block_text_of(&before, 1);
    insert_table(&mut s, 1);
    let after = reopen(&s);

    assert_eq!(
        new_table_at(&after),
        1,
        "the inserted table occupies block 1 (was: section end)"
    );
    assert!(
        new_table_at(&after) < para_at(&after, &displaced),
        "the inserted table precedes the paragraph it displaced"
    );
    assert_eq!(
        original_tables(&after),
        original_tables(&before),
        "existing tables unchanged"
    );
}

#[test]
fn inserted_table_right_after_a_parsed_table_lands_after_it() {
    // Block 6 is the parsed 3×3 table and block 7 its zero-line host paragraph. Index 7 in the model
    // = after the table; the anchor must be the HOST's end, not the paragraph before the table.
    let (mut s, before) = open("FormattingShowcase.hwpx");
    assert!(matches!(before.sections[0].blocks[6], Block::Table(_)));
    let caption = block_text_of(&before, 8);
    assert!(!caption.trim().is_empty(), "block 8 is a text paragraph");
    insert_table(&mut s, 7);
    let after = reopen(&s);

    let old_tbl = after.sections[0]
        .blocks
        .iter()
        .position(|b| matches!(b, Block::Table(t) if first_cell_text(t) != MARK))
        .unwrap();
    let new_tbl = new_table_at(&after);
    assert_eq!(old_tbl, 6, "the parsed table keeps its index");
    assert!(new_tbl > old_tbl, "new table follows the parsed table");
    assert!(
        new_tbl < para_at(&after, &caption),
        "new table precedes the caption paragraph that followed the parsed table"
    );
}

#[test]
fn inserted_table_right_before_a_parsed_table_stays_before_it() {
    let (mut s, _) = open("FormattingShowcase.hwpx");
    insert_table(&mut s, 6);
    let after = reopen(&s);
    let old_tbl = after.sections[0]
        .blocks
        .iter()
        .position(|b| matches!(b, Block::Table(t) if first_cell_text(t) != MARK))
        .unwrap();
    assert_eq!(new_table_at(&after), 6);
    assert!(old_tbl > 6, "the parsed table follows the inserted one");
}

#[test]
fn moved_new_table_exports_at_its_moved_position() {
    // 이슈 재현의 두 번째 줄: 끝에 넣고 `MoveBlock` 으로 앞으로.
    let (mut s, before) = open("FormattingShowcase.hwpx");
    let n = before.sections[0].blocks.len();
    insert_table(&mut s, n);
    apply_intent(
        &mut s,
        Intent::MoveBlock {
            section: 0,
            from: n,
            to: 2,
        },
    )
    .expect("MoveBlock applies");
    let displaced = block_text_of(&before, 2);
    let after = reopen(&s);
    assert_eq!(
        new_table_at(&after),
        2,
        "moved table exports where it was moved"
    );
    assert!(new_table_at(&after) < para_at(&after, &displaced));
}

#[test]
fn multi_table_document_keeps_existing_table_order() {
    // footnote-01 has several parsed tables; insert mid-document, between them.
    let (mut s, before) = open("footnote-01.hwpx");
    let tables_before = original_tables(&before);
    assert!(tables_before.len() >= 3, "fixture has several tables");
    let anchor = para_at(&before, "사회적 변화");
    insert_table(&mut s, anchor);
    let after = reopen(&s);

    assert_eq!(
        original_tables(&after),
        tables_before,
        "existing tables keep their order"
    );
    assert_eq!(new_table_at(&after), anchor);
    assert!(new_table_at(&after) < para_at(&after, "사회적 변화"));
}
