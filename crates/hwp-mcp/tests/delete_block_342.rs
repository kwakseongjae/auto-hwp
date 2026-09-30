//! #342 — `DeleteBlock` 이 HWPX 내보내기에 반영되는가 (Intent 레인 end-to-end).
//!
//! 증상(수정 전): HWPX 원본에서 `DeleteBlock` 으로 문단 · 표를 지우면 모델에서는 사라지지만,
//! 직렬화기가 **원본 구역 XML 을 제자리 고치기**라 지운 블록의 바이트가 그대로 복사됐다 →
//! `toHwpx()` 로 다시 열면 지운 문단 · 표가 돌아왔다(조용한 무동작).
//! 수정 후: `Op::DeleteBlock` 이 원본 스팬을 묘비(`Section::removed_spans`)로 남기고, 직렬화기가 그
//! 스팬을 잘라낸다. 지우지 않은 블록의 바이트는 그대로다.

use hwp_hwpx::parse::parse_semantic;
use hwp_mcp::{apply_intent, export_bytes, open_bytes, Intent, Session};
use hwp_model::prelude::*;

fn fixture(name: &str) -> Vec<u8> {
    let p = format!("{}/../../corpus/hwpx/{name}", env!("CARGO_MANIFEST_DIR"));
    std::fs::read(&p).unwrap_or_else(|e| panic!("read {p}: {e}"))
}

fn section0_xml(bytes: &[u8]) -> String {
    let pkg = hwp_hwpx::package::Package::open(bytes).unwrap();
    String::from_utf8(pkg.read_part("Contents/section0.xml").unwrap()).unwrap()
}

fn para_text(b: &Block) -> String {
    match b {
        Block::Paragraph(p) => p
            .runs
            .iter()
            .flat_map(|r| &r.content)
            .filter_map(|i| match i {
                Inline::Text(t) => Some(t.as_str()),
                _ => None,
            })
            .collect(),
        Block::Table(_) => String::new(),
    }
}

fn tables(doc: &SemanticDoc) -> usize {
    doc.sections[0]
        .blocks
        .iter()
        .filter(|b| matches!(b, Block::Table(_)))
        .count()
}

fn pages(doc: &SemanticDoc) -> usize {
    hwp_session::place(doc, &[]).pages.len()
}

fn open(src: &[u8], name: &str) -> Session {
    let mut s = Session::default();
    open_bytes(&mut s, src, name).expect("open hwpx");
    s
}

fn delete(s: &mut Session, index: usize) {
    apply_intent(s, Intent::DeleteBlock { section: 0, index }).expect("DeleteBlock applies");
}

/// A simple, non-first paragraph with unique visible text (so "gone" is unambiguous).
fn unique_text_para(doc: &SemanticDoc) -> (usize, String) {
    let blocks = &doc.sections[0].blocks;
    let all = doc.plain_text();
    blocks
        .iter()
        .enumerate()
        .skip(1)
        .find_map(|(i, b)| {
            let Block::Paragraph(p) = b else { return None };
            let t = para_text(b);
            let t = t.trim();
            (p.source.as_ref().is_some_and(|s| s.simple)
                && t.chars().count() >= 4
                && all.matches(t).count() == 1)
                .then(|| (i, t.to_string()))
        })
        .expect("fixture has a unique simple paragraph")
}

#[test]
fn deleted_paragraph_is_gone_after_reopen_and_neighbours_stay_verbatim() {
    let src = fixture("FormattingShowcase.hwpx");
    let before = parse_semantic(&src).unwrap();
    let n = before.sections[0].blocks.len();
    let (bi, text) = unique_text_para(&before);
    // A neighbour that is NOT deleted — its original bytes must survive verbatim.
    let orig = section0_xml(&src);
    let keep = before.sections[0].blocks[..bi]
        .iter()
        .rev()
        .find_map(|b| match b {
            Block::Paragraph(p) => p.source.as_ref().map(|s| s.span),
            _ => None,
        })
        .expect("a preceding source-backed paragraph");
    let keep_bytes = orig[keep.0..keep.1].to_string();

    let mut s = open(&src, "FormattingShowcase.hwpx");
    delete(&mut s, bi);
    let out = export_bytes(&s).unwrap();
    let after = parse_semantic(&out).unwrap();

    // 수정 전 빨강: 블록 수 · 글이 원본과 같았다.
    assert_eq!(after.sections[0].blocks.len(), n - 1, "one block fewer");
    assert!(!after.plain_text().contains(&text), "deleted text is gone");
    assert!(
        section0_xml(&out).contains(&keep_bytes),
        "neighbour byte-verbatim"
    );
    assert!(hwp_core::validate_hwpx(&out).ok, "open-safe");
}

#[test]
fn deleted_table_is_cut_together_with_its_bare_host() {
    let src = fixture("FormattingShowcase.hwpx");
    let before = parse_semantic(&src).unwrap();
    let t0 = tables(&before);
    let ti = before.sections[0]
        .blocks
        .iter()
        .position(|b| matches!(b, Block::Table(_)))
        .expect("fixture has a table");
    let n = before.sections[0].blocks.len();

    let mut s = open(&src, "FormattingShowcase.hwpx");
    delete(&mut s, ti);
    let out = export_bytes(&s).unwrap();
    let after = parse_semantic(&out).unwrap();

    assert_eq!(tables(&after), t0 - 1, "table gone after reopen");
    // The host `<hp:p>` hosted only that table: the model keeps it as a zero-line anchor, the file
    // drops it (an empty `<hp:p>` would reopen as a blank line). Same layout either way.
    assert_eq!(
        after.sections[0].blocks.len(),
        n - 2,
        "table + bare host gone"
    );
    let model = s.doc.as_ref().unwrap().doc();
    assert_eq!(
        pages(model),
        pages(&after),
        "model and reopen paginate alike"
    );
    assert!(hwp_core::validate_hwpx(&out).ok);
}

#[test]
fn deleting_table_and_its_host_removes_both() {
    let src = fixture("FormattingShowcase.hwpx");
    let before = parse_semantic(&src).unwrap();
    let t0 = tables(&before);
    let n = before.sections[0].blocks.len();
    let ti = before.sections[0]
        .blocks
        .iter()
        .position(|b| matches!(b, Block::Table(_)))
        .unwrap();
    assert!(matches!(&before.sections[0].blocks[ti + 1], Block::Paragraph(p) if p.is_table_anchor));

    // The consumer's order: descending indices (host first, then the table).
    let mut s = open(&src, "FormattingShowcase.hwpx");
    delete(&mut s, ti + 1);
    delete(&mut s, ti);
    let out = export_bytes(&s).unwrap();
    let after = parse_semantic(&out).unwrap();
    assert_eq!(tables(&after), t0 - 1);
    assert_eq!(after.sections[0].blocks.len(), n - 2, "table + host gone");
    assert!(hwp_core::validate_hwpx(&out).ok);
}

#[test]
fn deleting_only_the_host_keeps_the_surviving_table() {
    // 사용자 콘텐츠 삭제 금지: the host `<hp:p>` CONTAINS the table's bytes — cutting it would delete a
    // table the model still has. The tombstone is ignored instead.
    let src = fixture("FormattingShowcase.hwpx");
    let before = parse_semantic(&src).unwrap();
    let t0 = tables(&before);
    let ti = before.sections[0]
        .blocks
        .iter()
        .position(|b| matches!(b, Block::Table(_)))
        .unwrap();
    let mut s = open(&src, "FormattingShowcase.hwpx");
    delete(&mut s, ti + 1);
    let out = export_bytes(&s).unwrap();
    let after = parse_semantic(&out).unwrap();
    assert_eq!(tables(&after), t0, "surviving table is not lost");
}

#[test]
fn delete_then_undo_exports_byte_identical_to_no_edit() {
    let src = fixture("FormattingShowcase.hwpx");
    let before = parse_semantic(&src).unwrap();
    let (bi, _) = unique_text_para(&before);
    let pristine = export_bytes(&open(&src, "FormattingShowcase.hwpx")).unwrap();

    let mut s = open(&src, "FormattingShowcase.hwpx");
    delete(&mut s, bi);
    apply_intent(&mut s, Intent::Undo).expect("undo");
    let out = export_bytes(&s).unwrap();
    assert_eq!(
        section0_xml(&out),
        section0_xml(&pristine),
        "undo restores the tombstone list too"
    );
}

#[test]
fn deleting_the_secpr_paragraph_keeps_the_section_setup() {
    let src = fixture("FormattingShowcase.hwpx");
    let orig = section0_xml(&src);
    assert!(orig.contains("<hp:secPr"));
    let mut s = open(&src, "FormattingShowcase.hwpx");
    let first_text = para_text(&s.doc.as_ref().unwrap().doc().sections[0].blocks[0]);
    delete(&mut s, 0);
    let out = export_bytes(&s).unwrap();
    let xml = section0_xml(&out);
    assert_eq!(
        xml.matches("<hp:secPr").count(),
        1,
        "secPr survives exactly once"
    );
    let after = parse_semantic(&out).unwrap();
    let n = parse_semantic(&src).unwrap().sections[0].blocks.len();
    assert_eq!(
        after.sections[0].blocks.len(),
        n - 1,
        "secPr rides the next paragraph"
    );
    if !first_text.trim().is_empty() {
        assert!(
            !after.plain_text().contains(first_text.trim()),
            "first paragraph's text is gone"
        );
    }
    assert!(hwp_core::validate_hwpx(&out).ok);
}

#[test]
fn delete_combined_with_edit_and_insert_keeps_order() {
    // A deletion next to an edited paragraph and a freshly inserted one — the splices must not collide.
    let src = fixture("FormattingShowcase.hwpx");
    let before = parse_semantic(&src).unwrap();
    let (bi, text) = unique_text_para(&before);
    let mut s = open(&src, "FormattingShowcase.hwpx");
    delete(&mut s, bi);
    apply_intent(
        &mut s,
        Intent::InsertParagraphAt {
            section: 0,
            index: Some(bi),
            runs: vec![hwp_ops::RunSpec {
                text: "342새문단".into(),
                ..Default::default()
            }],
            para: hwp_ops::ParaSpec::default(),
        },
    )
    .expect("insert");
    let out = export_bytes(&s).unwrap();
    let after = parse_semantic(&out).unwrap();
    assert!(!after.plain_text().contains(&text));
    let Block::Paragraph(_) = &after.sections[0].blocks[bi] else {
        panic!("inserted paragraph")
    };
    assert_eq!(para_text(&after.sections[0].blocks[bi]), "342새문단");
    assert_eq!(
        after.sections[0].blocks.len(),
        before.sections[0].blocks.len()
    );
}
