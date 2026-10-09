//! #439 후속 — 표 블록 모델의 저장 → 다시 열기 대칭.
//!
//! - 파싱한 표는 「표 + 담는 문단(`is_table_anchor`)」 두 블록이다. `InsertTableAt` 은 메모리에서 **1블록**을 넣고, 저장 → 다시 열면
//!   다른 파싱 표처럼 「표 + 담는 문단」 이 된다.
//! - 반대 방향: 파싱한 표를 `DeleteBlock` 하면 메모리에는 담는 문단이 남지만, 저장 → 다시 열면 담는 문단도 사라진다
//!   (표와 함께 담는 `<hp:p>` 가 빠지므로).
//! - 호스트의 「표 통째 바꾸기」 묶음 `[DeleteBlock(표), InsertTableAt(같은 자리)]` 을 파싱한 표에 저장 → 다시 열기마다 되풀이해도
//!   블록 순번 · 쪽 수가 흔들리지 않는다(빈 문단이 쌓이지 않는다).

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

fn reopen(s: &Session) -> Session {
    open(&export_bytes(s).expect("export"))
}

/// Block kinds: `T` table · `a` table anchor (holder) · `P` text paragraph · `_` empty paragraph.
fn kinds(s: &Session) -> String {
    s.doc.as_ref().unwrap().doc().sections[0]
        .blocks
        .iter()
        .map(|b| match b {
            Block::Table(_) => 'T',
            Block::Paragraph(p) if p.is_table_anchor => 'a',
            Block::Paragraph(p) => {
                let t: String = p
                    .runs
                    .iter()
                    .flat_map(|r| &r.content)
                    .filter_map(|i| match i {
                        Inline::Text(t) => Some(t.as_str()),
                        _ => None,
                    })
                    .collect();
                if t.trim().is_empty() {
                    '_'
                } else {
                    'P'
                }
            }
        })
        .collect()
}

fn pages(s: &mut Session) -> u32 {
    match apply_intent(s, Intent::PageCount).expect("pages") {
        Outcome::PageCount(n) => n,
        _ => unreachable!(),
    }
}

fn insert(s: &mut Session, index: usize, tag: &str) {
    let cell = |t: &str| hwp_ops::CellSpec {
        text: t.into(),
        ..Default::default()
    };
    apply_intent(
        s,
        Intent::InsertTableAt {
            section: 0,
            index: Some(index),
            rows: vec![vec![cell(tag), cell("값")], vec![cell("가"), cell("나")]],
            border: None,
            col_widths: None,
            header_row: None,
            treat_as_char: None,
        },
    )
    .expect("insert");
}

#[test]
fn inserted_table_reopens_with_its_anchor_and_same_pages() {
    let mut s = open(&corpus("FormattingShowcase.hwpx"));
    let orig = kinds(&s);
    insert(&mut s, 1, "넣음");
    let mem = kinds(&s);
    assert_eq!(&mem[..2], &format!("{}T", &orig[..1]), "1 block in memory");
    let mem_pages = pages(&mut s);
    let mut re = reopen(&s);
    let back = kinds(&re);
    assert_eq!(
        &back[1..3],
        "Ta",
        "reopened: table + its anchor, like every parsed table"
    );
    assert_eq!(
        back.len(),
        mem.len() + 1,
        "exactly one extra block (the anchor) — no blank paragraph"
    );
    assert_eq!(pages(&mut re), mem_pages, "same page count");
}

#[test]
fn deleting_a_parsed_table_drops_its_anchor_on_reopen() {
    let mut s = open(&corpus("FormattingShowcase.hwpx"));
    let k = kinds(&s);
    let t = k.find("Ta").expect("a parsed table with its anchor");
    apply_intent(
        &mut s,
        Intent::DeleteBlock {
            section: 0,
            index: t,
        },
    )
    .unwrap();
    let mem = kinds(&s);
    assert_eq!(&mem[t..t + 1], "a", "memory keeps the anchor block");
    let re = reopen(&s);
    let back = kinds(&re);
    assert_eq!(
        back.len(),
        mem.len() - 1,
        "the anchor goes with its table on reopen"
    );
    assert_eq!(back, format!("{}{}", &mem[..t], &mem[t + 1..]));
}

#[test]
fn replace_bundle_on_a_parsed_user_table_is_stable_across_save_reopen() {
    // A host user table that was saved once (so it is parsed: table + anchor).
    let mut s = open(&corpus("FormattingShowcase.hwpx"));
    insert(&mut s, 1, "회0");
    let mut doc = reopen(&s);
    let base = kinds(&doc);
    let base_pages = pages(&mut doc);
    assert_eq!(&base[1..3], "Ta");
    for round in 1..=4 {
        // The host's 「표 통째 바꾸기」 bundle: delete the table block, insert the new one at the same index.
        apply_intent(
            &mut doc,
            Intent::DeleteBlock {
                section: 0,
                index: 1,
            },
        )
        .unwrap();
        insert(&mut doc, 1, &format!("회{round}"));
        assert_eq!(
            kinds(&doc),
            base,
            "round {round}: memory = new table + the old anchor"
        );
        doc = reopen(&doc);
        assert_eq!(
            kinds(&doc),
            base,
            "round {round}: reopened block order unchanged"
        );
        assert_eq!(
            pages(&mut doc),
            base_pages,
            "round {round}: page count unchanged"
        );
        let Block::Table(t) = &doc.doc.as_ref().unwrap().doc().sections[0].blocks[1] else {
            panic!("round {round}: table at block 1");
        };
        let first: String = t.cells[0]
            .blocks
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
                _ => None,
            })
            .collect();
        assert_eq!(
            first,
            format!("회{round}"),
            "round {round}: the new table replaced the old one"
        );
    }
}
