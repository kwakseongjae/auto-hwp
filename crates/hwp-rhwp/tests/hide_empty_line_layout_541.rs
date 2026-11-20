//! #541 — 「빈 줄 감추기」가 켜진 구역에서 쪽 끝 빈 줄을 그 쪽에 남기면, 쪽이 한글이 저장한 줄 배치와 같은 줄에서
//! 시작하는 수가 는다. 판단은 총 쪽 수가 아니라 「쪽 시작이 같은 줄 수」로 한다 — 공개 재난안전 문서는 우리가 이미
//! 한글보다 적은 쪽에 담는 곳이 많아, 감추면 총 쪽 수는 저장(76쪽)에서 더 멀어진다(74 → 72).
//!
//! 같은 문서를 설정 그대로 · 설정을 끈 채로 재어 견준다(글꼴 · 기계에 따라 절대값은 달라질 수 있다).
#![cfg(feature = "rhwp")]

use std::io::Write;

use hwp_model::prelude::*;

/// (같은 줄에서 시작한 쪽 수, 우리 쪽 수) — 설정을 그대로(`hide`) / 끈 채로.
fn matched(rel: &str, hide: bool) -> Option<(usize, usize)> {
    let path = format!("{}/../../{rel}", env!("CARGO_MANIFEST_DIR"));
    let bytes = std::fs::read(&path).ok()?;
    let hwp = rel.ends_with(".hwp");
    let mut doc = if hwp {
        hwp_rhwp::parse_to_semantic_guarded(&bytes).expect("lift")
    } else {
        hwp_hwpx::HwpxParser::new()
            .parse(&bytes, SourceFormat::Hwpx)
            .expect("parse")
    };
    assert!(
        doc.sections.iter().any(|s| s.page.hide_first_empty_line),
        "{rel}: 설정이 켜진 구역이 있어야 한다"
    );
    if !hide {
        for s in &mut doc.sections {
            s.page.hide_first_empty_line = false;
        }
    }
    let a = if hwp {
        hwp_rhwp::page_start_alignment_for_lifted(&bytes, &doc)
    } else {
        hwp_rhwp::page_start_alignment_for_doc(&bytes, &doc)
    }
    .expect("alignment");
    Some((a.matched, a.our_pages))
}

#[test]
fn hiding_empty_lines_starts_more_pages_where_hangul_does() {
    let rel = "corpus/hwpxlib_corpus/error/20250808/2015년_12월_재난안전종합상황_분석_및_전망.hwpx";
    let (on, pages_on) = matched(rel, true).expect("public corpus HWPX");
    let (off, pages_off) = matched(rel, false).unwrap();
    assert!(
        on > off,
        "same-line page starts: hidden {on} vs not {off} (pages {pages_on} vs {pages_off})"
    );
}

/// The rhwp checkout's `.hwp` sample with the setting on (not in the corpus — its document rights are not
/// established). Skipped — loudly, past the test harness's output capture — when absent.
#[test]
fn hiding_empty_lines_on_a_hwp_sample() {
    let rel = "external/rhwp/samples/loading-fail-01.hwp";
    let Some((on, _)) = matched(rel, true) else {
        let _ = writeln!(std::io::stderr(), "건너뜀: {rel} 없음");
        return;
    };
    let (off, _) = matched(rel, false).unwrap();
    assert!(on > off, "same-line page starts: hidden {on} vs not {off}");
}
