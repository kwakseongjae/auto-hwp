//! #393 — 제안 확정 검증은 **편집이 만든** layout-lockstep 불일치만 막는다.
//!
//! 증상(수정 전): `verify_proposal` 이 편집 **전** 문서의 `pages != lockstep_pages` 만으로도
//! `layout-lockstep-mismatch` 를 `structural_failures` 에 넣었다. 두 조판 결과의 쪽 수가 원래 다른
//! 문서에서는 칸 글 한 글자 제안도 확정이 막혔다(`applyIntents` 묶음 적용은 통과 — 같은 편집인데).
//! 수정 후: 편집 전 · 뒤 불일치(부호 있는 차이)가 같으면 `advisories` 의
//! `layout-lockstep-mismatch-preexisting` 으로 낮추고, 편집이 불일치를 새로 만들거나 바꾸면 그대로 막는다.
//!
//! 고정 파일 `fixtures/lockstep-preexisting-393.hwpx`(22 KB)는 공개 corpus `corpus/hwp/k-water-rfp.hwp`
//! 에서 만들었다: `auto-hwp convert`(HWPX) → 쪽 수 불일치가 남는 블록 68개만 `DeleteBlock` 으로 남김 →
//! 참조되지 않는 BinData 제거. 원본 그대로 열어도 `place_doc` 5쪽 · `NaiveLayout` 4쪽이다.
//! 글꼴 측정이 피처에 따라 달라 불일치 여부도 달라질 수 있으므로, `cargo test -p hwp-mcp` 와
//! `cargo test --workspace`(피처 통합 — CI) **두 구성 모두에서** 불일치가 남는 것으로 골랐다.
//!
//! #537 이후: 그 불일치의 원인(NaiveLayout 결함 둘)이 고쳐져 이 문서는 두 조판에서 같다. 시험은 「이 문서가 이제
//! 같고 편집이 막히지 않는다」를 지키고, 있던 불일치 판정은 단위 시험이 지킨다(아래 주석).

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
fn the_former_mismatch_fixture_is_in_step_and_an_edit_commits() {
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
    // #537 — 이 고정 파일의 불일치(place_doc 5 · NaiveLayout 4)는 NaiveLayout 의 결함 둘(행만 남은 쪽 뒤의 구역
    // 시작 · 문단 여백을 무시한 줄 폭)에서 왔고, 그 고침으로 사라졌다. 공개 · 비공개 127문서에도 불일치가 남지 않아
    // 「편집 전부터 있던 불일치」를 실제 문서로 만들 수 없다. 그래서 여기서는 이 문서가 이제 두 조판에서 같고 편집이
    // 막히지 않는 것을 지키고, 「있던 불일치는 막지 않는다」 판정은 `lockstep_verdict_judges_only_the_delta_caused_by_the_edit`
    // (hwp-mcp 단위 시험)가 지킨다.
    assert_eq!(
        v.before_layout.pages, v.before_layout.lockstep_pages,
        "the former mismatch fixture is in step after #537"
    );
    assert_eq!(
        v.after_layout.pages, v.after_layout.lockstep_pages,
        "a one-character edit keeps it in step"
    );
    assert!(
        v.structural_failures.is_empty(),
        "nothing blocks: {:?}",
        v.structural_failures
    );
    assert!(v.commit_allowed);
    assert!(!v
        .advisories
        .iter()
        .any(|a| a == "layout-lockstep-mismatch-preexisting"));
    let n = commit_proposal_v1(&mut s, &proposal.proposal_id, proposal.base_revision)
        .expect("commit succeeds");
    assert_eq!(n, 1);
    assert_eq!(s.doc.as_ref().unwrap().revision(), before_rev + 1);
}
