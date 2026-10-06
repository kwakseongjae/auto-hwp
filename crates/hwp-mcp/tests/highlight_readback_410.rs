//! #410 — `blockRuns` 가 글자 배경(`highlight`)을 늘 `null` 로 돌려주던 회귀 가드.
//!
//! 원인: `hwp_session::push_para_runs` 가 `RunDto.highlight` 를 `None` 으로 하드코딩했다. 쓰기
//! (`RunSpec.highlight` → `CharShape.shade_color` → charPr `shadeColor`)와 다시 열기 파싱(charPr
//! `shadeColor` → `shade_color`)은 이미 됐으므로, 읽기만 대칭이 아니었다.

use hwp_hwpx::parse::parse_semantic;
use hwp_mcp::{apply_intent, export_bytes, open_bytes, Intent, Session};
use hwp_model::prelude::*;

fn corpus(name: &str) -> Vec<u8> {
    let p = format!("{}/../../corpus/hwpx/{name}", env!("CARGO_MANIFEST_DIR"));
    std::fs::read(&p).unwrap_or_else(|e| panic!("read {p}: {e}"))
}

const MARK: &str = "#FFF2A8";

fn highlights(doc: &SemanticDoc, block: usize) -> Vec<(String, Option<String>)> {
    hwp_session::block_runs(doc, 0, block, None, None)
        .into_iter()
        .map(|r| (r.text, r.highlight))
        .collect()
}

fn write_marked(name: &str, block: usize) -> Session {
    let src = corpus(name);
    let mut s = Session::default();
    open_bytes(&mut s, &src, name).expect("open");
    apply_intent(
        &mut s,
        Intent::SetParagraphRuns {
            section: 0,
            block,
            runs: vec![
                hwp_ops::RunSpec {
                    text: "plain ".into(),
                    ..Default::default()
                },
                hwp_ops::RunSpec {
                    text: "marked".into(),
                    highlight: Some(MARK.into()),
                    ..Default::default()
                },
            ],
        },
    )
    .expect("SetParagraphRuns applies");
    s
}

fn assert_marked(runs: &[(String, Option<String>)], ctx: &str) {
    let plain = runs.iter().find(|(t, _)| t == "plain ").expect("plain run");
    let marked = runs
        .iter()
        .find(|(t, _)| t == "marked")
        .expect("marked run");
    assert_eq!(plain.1, None, "{ctx}: a run without 글자 음영 reads null");
    assert_eq!(
        marked.1.as_deref(),
        Some(MARK),
        "{ctx}: the highlighted run reads back its shadeColor"
    );
}

#[test]
fn highlight_reads_back_in_memory_and_after_reopen() {
    for (name, block) in [("FormattingShowcase.hwpx", 1), ("Skeleton.hwpx", 0)] {
        let s = write_marked(name, block);
        let doc = s.doc.as_ref().unwrap().doc();
        assert_marked(&highlights(doc, block), &format!("{name} in memory"));

        let bytes = export_bytes(&s).expect("export");
        let header = String::from_utf8_lossy(
            &hwp_hwpx::package::Package::open(&bytes)
                .unwrap()
                .read_header()
                .unwrap(),
        )
        .into_owned();
        assert!(
            header.contains(&format!("shadeColor=\"{MARK}\"")),
            "{name}: header carries the charPr shadeColor"
        );
        let reopened = parse_semantic(&bytes).expect("reopen");
        assert_marked(&highlights(&reopened, block), &format!("{name} reopened"));
    }
}

#[test]
fn source_shade_reads_back_and_nothing_else_does() {
    // 이슈 수용 기준 「원본 문서에 이미 있는 글자 음영도 읽힌다」: FormattingShowcase 의 「강조 표시」
    // run 은 원본 charPr 에 shadeColor="#FFF2CC" 를 가진다. 다른 run 은 모두 `none` → null.
    let doc = parse_semantic(&corpus("FormattingShowcase.hwpx")).unwrap();
    let mut shaded = Vec::new();
    for bi in 0..doc.sections[0].blocks.len() {
        for (text, hl) in highlights(&doc, bi) {
            if let Some(hl) = hl {
                shaded.push((bi, text, hl));
            }
        }
    }
    assert_eq!(
        shaded,
        vec![(2, "강조 표시".to_string(), "#FFF2CC".to_string())],
        "exactly the source-shaded run reads its shade"
    );
}
