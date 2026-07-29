//! W4.1 — 문단 앵커링 end-to-end 재현 (Intent 레인): hwpx 오리진 열기 → `SplitParagraph`(캐럿
//! Enter) / `InsertParagraphAt` → `export_bytes` → 재파싱. 새 문단은 **원 위치**에 남아야 하고,
//! 섹션 맨 끝으로 밀려 문서 순서를 파손해서는 안 된다.
//!
//! 057(표 레인)의 문단 판 — 같은 "원본 바이트 스팬에 앵커한다" 규율의 확장.

use hwp_hwpx::parse::parse_semantic;
use hwp_mcp::{apply_intent, export_bytes, open_bytes, Intent, Outcome, Session};
use hwp_model::prelude::*;

fn fixture() -> Vec<u8> {
    let p = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../corpus/hwpx/FormattingShowcase.hwpx"
    );
    std::fs::read(p).expect("read corpus/hwpx/FormattingShowcase.hwpx")
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

/// 오리진에서 읽어온 단순 본문 문단(캐럿 편집 대상)의 블록 인덱스.
fn simple_para_indices(doc: &SemanticDoc) -> Vec<usize> {
    doc.sections[0]
        .blocks
        .iter()
        .enumerate()
        .filter_map(|(i, b)| match b {
            Block::Paragraph(p)
                if p.source.as_ref().is_some_and(|s| s.simple)
                    && para_text(b).chars().count() >= 6 =>
            {
                Some(i)
            }
            _ => None,
        })
        .collect()
}

#[test]
fn hwpx_origin_split_paragraph_exports_tail_in_document_order() {
    let src = fixture();

    let before = parse_semantic(&src).unwrap();
    let simple = simple_para_indices(&before);
    assert!(
        simple.len() >= 2,
        "fixture must have ≥2 editable body paragraphs, got {simple:?}"
    );
    let bi = simple[0];
    let full = para_text(&before.sections[0].blocks[bi]);
    let cut = full.chars().count() / 2;
    let head: String = full.chars().take(cut).collect();
    let tail: String = full.chars().skip(cut).collect();
    let follower = para_text(&before.sections[0].blocks[simple[1]]);
    let n_blocks = before.sections[0].blocks.len();

    let mut session = Session::default();
    open_bytes(&mut session, &src, "FormattingShowcase.hwpx").expect("open hwpx origin");

    let out = apply_intent(
        &mut session,
        Intent::SplitParagraph {
            section: 0,
            block: bi,
            at: cut,
        },
    )
    .expect("SplitParagraph applies");
    assert!(!matches!(out, Outcome::Discarded(_)), "edit applied");

    let bytes = export_bytes(&session).expect("export_bytes");
    let after = parse_semantic(&bytes).unwrap();

    // ① 블록 수 정확히 +1 — 끝 append 복제 없음.
    assert_eq!(
        after.sections[0].blocks.len(),
        n_blocks + 1,
        "exactly one new paragraph"
    );

    // ② 머리/꼬리가 원 위치에 연속으로. (수정 전: 꼬리가 섹션 맨 끝 → 레드)
    assert_eq!(
        para_text(&after.sections[0].blocks[bi]),
        head,
        "head paragraph keeps its original block index"
    );
    assert_eq!(
        para_text(&after.sections[0].blocks[bi + 1]),
        tail,
        "tail paragraph sits immediately after its head"
    );

    // ③ 문서 순서: 꼬리 < 후행 원본 문단.
    let text = after.plain_text();
    let pt = text.find(&tail).expect("tail text present");
    let pf = text.find(&follower).expect("follower text present");
    assert!(
        pt < pf,
        "the split tail must precede the paragraph that followed the head (tail={pt} follower={pf})"
    );

    assert!(
        hwp_hwpx::export::validate_open_safety(&bytes).ok,
        "exported package is open-safe"
    );
}

#[test]
fn hwpx_origin_insert_paragraph_at_exports_at_that_index() {
    let src = fixture();
    let before = parse_semantic(&src).unwrap();
    let bi = *simple_para_indices(&before)
        .first()
        .expect("fixture has an editable body paragraph");
    let displaced = para_text(&before.sections[0].blocks[bi]);

    let mut session = Session::default();
    open_bytes(&mut session, &src, "FormattingShowcase.hwpx").expect("open hwpx origin");

    const NEW: &str = "W41삽입문단";
    let out = apply_intent(
        &mut session,
        Intent::InsertParagraphAt {
            section: 0,
            index: Some(bi),
            runs: vec![hwp_ops::RunSpec {
                text: NEW.into(),
                ..Default::default()
            }],
            para: hwp_ops::ParaSpec::default(),
        },
    )
    .expect("InsertParagraphAt applies");
    assert!(!matches!(out, Outcome::Discarded(_)), "edit applied");

    let bytes = export_bytes(&session).expect("export_bytes");
    let after = parse_semantic(&bytes).unwrap();

    assert_eq!(
        para_text(&after.sections[0].blocks[bi]),
        NEW,
        "the inserted paragraph occupies the index it was inserted at"
    );
    let text = after.plain_text();
    assert!(
        text.find(NEW).unwrap() < text.find(&displaced).unwrap(),
        "the inserted paragraph precedes the paragraph it displaced"
    );
}
