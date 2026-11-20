//! #541 — 구역 설정 「빈 줄 감추기」를 세 읽개(HWPX · rhwp 리프트 · 자체 `.hwp` 파서)가 같게 읽고, `.hwp` → HWPX
//! 변환이 그 값을 그대로 쓴다. 조판은 아직 이 값을 쓰지 않는다(다음 단계).
#![cfg(feature = "rhwp")]

use std::io::Write;

use hwp_core::open_hwp5_own;
use hwp_model::document::SemanticDoc;
use hwp_model::prelude::{DocumentParser, SourceFormat};
use hwp_rhwp::RhwpEngine;

fn flags(doc: &SemanticDoc) -> Vec<bool> {
    doc.sections
        .iter()
        .map(|s| s.page.hide_first_empty_line)
        .collect()
}

fn read(rel: &str) -> Option<Vec<u8>> {
    std::fs::read(format!("{}/../../{rel}", env!("CARGO_MANIFEST_DIR"))).ok()
}

#[test]
fn hwpx_sections_carry_the_setting() {
    let on =
        read("corpus/hwpxlib_corpus/error/20250808/2015년_12월_재난안전종합상황_분석_및_전망.hwpx")
            .expect("public corpus HWPX");
    let doc = hwp_core::Engine::open(&on).unwrap();
    assert!(flags(&doc).iter().all(|&f| f), "{:?}", flags(&doc));
    let off =
        read("corpus/hwpxlib_corpus/error/20230426/HwpxTest1.hwpx").expect("public corpus HWPX");
    assert!(flags(&hwp_core::Engine::open(&off).unwrap())
        .iter()
        .all(|&f| !f));
}

/// The public `.hwp` corpus has no section with the setting on; this sample from the vendored rhwp
/// checkout does (not copied into the corpus — its document rights are not established). Skipped when
/// the checkout is absent.
#[test]
fn both_hwp_readers_and_the_conversion_carry_the_setting() {
    let rel = "external/rhwp/samples/loading-fail-01.hwp";
    let Some(bytes) = read(rel) else {
        let _ = writeln!(std::io::stderr(), "건너뜀: {rel} 없음");
        return;
    };
    let lifted = RhwpEngine::new().parse(&bytes, SourceFormat::Hwp5).unwrap();
    assert_eq!(flags(&lifted), vec![true], "rhwp lift");
    // 자체 파서가 이 표본을 열면 두 읽개를 대조한다. 못 열면 그렇다고 남긴다 — 자체 파서의 비트 19 는
    // hwp-hwp5 `layout_semantic::reads_the_hide_empty_line_section_attribute`(합성 .hwp)가 지킨다.
    match open_hwp5_own(&bytes) {
        Ok(owned) => assert_eq!(flags(&owned), flags(&lifted), "both .hwp readers"),
        Err(error) => {
            // 시험 출력 가로채기를 거치지 않고 남긴다 — 통과한 시험의 `eprintln!` 은 보이지 않는다.
            let _ = writeln!(
                std::io::stderr(),
                "건너뜀(두 읽개 대조): 자체 파서가 {rel} 을 열지 못함 — {error}"
            );
        }
    }
    let hwpx = hwp_hwpx::serialize::serialize(&lifted).unwrap();
    let reopened = hwp_hwpx::HwpxParser::new()
        .parse(&hwpx, SourceFormat::Hwpx)
        .unwrap();
    assert_eq!(
        flags(&reopened),
        vec![true],
        "converted HWPX keeps the setting"
    );
    // a public .hwp with the setting off converts to "0"
    let off = read("benchmarks/benchmark.hwp").unwrap();
    let lifted = RhwpEngine::new().parse(&off, SourceFormat::Hwp5).unwrap();
    assert!(flags(&lifted).iter().all(|&f| !f));
    let reopened = hwp_hwpx::HwpxParser::new()
        .parse(
            &hwp_hwpx::serialize::serialize(&lifted).unwrap(),
            SourceFormat::Hwpx,
        )
        .unwrap();
    assert!(flags(&reopened).iter().all(|&f| !f));
}
