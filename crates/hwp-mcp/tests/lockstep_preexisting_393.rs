//! #393 — 제안 확정 검증은 **편집이 만든** layout-lockstep 불일치만 막는다.
//!
//! 증상(수정 전): `verify_proposal` 이 편집 **전** 문서의 `pages != lockstep_pages` 만으로도
//! `layout-lockstep-mismatch` 를 `structural_failures` 에 넣었다. 두 조판 결과의 쪽 수가 원래 다른
//! 문서에서는 칸 글 한 글자 제안도 확정이 막혔다(`applyIntents` 묶음 적용은 통과 — 같은 편집인데).
//! 수정 후: 편집 전 · 뒤 불일치(부호 있는 차이)가 같으면 `advisories` 의
//! `layout-lockstep-mismatch-preexisting` 으로 낮추고, 편집이 불일치를 새로 만들거나 바꾸면 그대로 막는다.
//!
//! 고정 파일 `fixtures/lockstep-preexisting-393.hwpx`(22 KB)는 공개 corpus `corpus/hwp/k-water-rfp.hwp`
//! 에서 만들었다: `auto-hwp convert`(HWPX) → 쪽 수 불일치가 남는 블록 66개만 `DeleteBlock` 으로 남김 →
//! 참조되지 않는 BinData 제거. 원본 그대로 열어도 `place_doc` 5쪽 · `NaiveLayout` 4쪽이다.

use hwp_mcp::{commit_proposal_v1, open_bytes, propose_intents_v1, Session};
use hwp_model::prelude::*;
use serde_json::json;

fn open_fixture() -> Session {
    let p = format!(
        "{}/tests/fixtures/lockstep-preexisting-393.hwpx",
        env!("CARGO_MANIFEST_DIR")
    );
    let bytes = std::fs::read(&p).unwrap_or_else(|e| panic!("read {p}: {e}"));
    let mut s = Session::default();
    open_bytes(&mut s, &bytes, "lockstep-preexisting-393.hwpx").expect("fixture opens");
    s
}

/// 첫 본문 문단의 (구역, 블록) 주소.
fn first_paragraph(s: &Session) -> (usize, usize) {
    let doc = s.doc.as_ref().unwrap().doc();
    for (si, sec) in doc.sections.iter().enumerate() {
        for (bi, block) in sec.blocks.iter().enumerate() {
            if matches!(block, Block::Paragraph(_)) {
                return (si, bi);
            }
        }
    }
    panic!("fixture has a body paragraph");
}

#[test]
fn preexisting_lockstep_mismatch_does_not_block_an_unrelated_edit() {
    let mut s = open_fixture();
    let (section, block) = first_paragraph(&s);
    let before_rev = s.doc.as_ref().unwrap().revision();
    let proposal = propose_intents_v1(
        &mut s,
        &[json!({
            "intent": "SetParagraphRuns",
            "section": section,
            "block": block,
            "runs": [{"text": "x"}]
        })],
    )
    .expect("proposal");
    let v = &proposal.verification;
    // 전제: 편집 전부터 두 조판 결과의 쪽 수가 다르다. 조판 수정으로 이 전제가 사라지면 이 테스트는
    // 아무것도 지키지 않게 되므로 여기서 크게 실패한다 — 그때는 고정 파일을 새로 만든다.
    assert_ne!(
        v.before_layout.pages, v.before_layout.lockstep_pages,
        "fixture precondition: pre-existing place_doc/NaiveLayout page-count mismatch"
    );
    assert_eq!(
        v.after_layout.pages as isize - v.after_layout.lockstep_pages as isize,
        v.before_layout.pages as isize - v.before_layout.lockstep_pages as isize,
        "a one-character edit does not change the mismatch"
    );
    assert!(
        v.structural_failures.is_empty(),
        "pre-existing mismatch must not block: {:?}",
        v.structural_failures
    );
    assert!(v.commit_allowed);
    assert!(v
        .advisories
        .iter()
        .any(|a| a == "layout-lockstep-mismatch-preexisting"));

    let n = commit_proposal_v1(&mut s, &proposal.proposal_id, proposal.base_revision)
        .expect("commit succeeds");
    assert_eq!(n, 1);
    assert_eq!(s.doc.as_ref().unwrap().revision(), before_rev + 1);
}
