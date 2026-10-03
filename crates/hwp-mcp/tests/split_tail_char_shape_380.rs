//! #380 — `SplitParagraph` 꼬리 문단의 글자 모양(굵게 등)이 HWPX 내보내기에서 유지돼야 한다(#356 과 같은 축).
//!
//! 공개 코퍼스 `corpus/hwpx/FormattingShowcase.hwpx` 로 편집 → `export_bytes` → 다시 열기 → 문단 글 ·
//! 굵기를 메모리 문서와 비교한다.

use hwp_mcp::{apply_intent, export_bytes, open_bytes, Intent, Session};
use hwp_model::prelude::*;

fn fixture() -> Vec<u8> {
    let p = format!(
        "{}/../../corpus/hwpx/FormattingShowcase.hwpx",
        env!("CARGO_MANIFEST_DIR")
    );
    std::fs::read(&p).unwrap_or_else(|e| panic!("read {p}: {e}"))
}

fn open(src: &[u8]) -> Session {
    let mut s = Session::default();
    open_bytes(&mut s, src, "f.hwpx").expect("open hwpx");
    s
}

/// Every top-level paragraph as text, with `*…*` around bold runs (tables as `<표>`).
fn paras(s: &Session) -> Vec<String> {
    let d = s.doc.as_ref().unwrap().doc();
    d.sections[0]
        .blocks
        .iter()
        .map(|b| match b {
            Block::Paragraph(p) => p
                .runs
                .iter()
                .map(|r| {
                    let t: String = r
                        .content
                        .iter()
                        .filter_map(|i| match i {
                            Inline::Text(t) => Some(t.as_str()),
                            _ => None,
                        })
                        .collect();
                    let bold = d.char_shapes.get(r.char_shape).is_some_and(|c| c.bold);
                    if bold && !t.is_empty() {
                        format!("*{t}*")
                    } else {
                        t
                    }
                })
                .collect(),
            _ => "<표>".into(),
        })
        .collect()
}

fn reopened(s: &Session) -> Vec<String> {
    paras(&open(&export_bytes(s).expect("export")))
}

#[test]
fn split_paragraph_tail_keeps_char_shapes_through_hwpx() {
    let src = fixture();
    let mut s = open(&src);
    // block 2 = "이 문서는 *굵은 텍스트*, …" — split before the bold run so the tail starts bold.
    apply_intent(
        &mut s,
        Intent::SplitParagraph {
            section: 0,
            block: 2,
            at: 2,
        },
    )
    .expect("split");
    let mem = paras(&s);
    assert!(
        mem[3].contains("*굵은 텍스트*"),
        "memory tail keeps bold: {}",
        mem[3]
    );
    assert_eq!(
        reopened(&s),
        mem,
        "the split tail keeps its run shapes on export"
    );
}
