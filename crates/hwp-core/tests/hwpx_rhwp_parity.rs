//! **교차포맷 파서 파리티 오라클** — 같은 `.hwpx` 를 ① 우리 HWPX 파서와 ② rhwp(HWPX 를 자동
//! 감지해 완전 파싱) 로 각각 읽어 IR 을 대조한다.
//!
//! 왜 필요한가: `.hwp` 는 rhwp lift 를 거쳐 조판 충실도 99.2%(18==18) 인데 `.hwpx` 는 자체 파서라
//! 같은 내용에서 86.9%/+1p 로 떨어졌다. 원인은 코드가 아니라 **읽지 않는 속성**이었다 — 값 기준
//! dedup(`intern_shape`) 이라 안 읽는 필드가 많을수록 서로 다른 charPr 이 하나로 뭉갠다
//! (benchmark1: 214 → 87). rhwp 를 정답지로 두면 그 갭이 사람 눈 없이 드러난다.
//!
//! 조판 게이트(layout-check 8==8 / 18==18)는 *결과*를 잠그지만 이 테스트는 *입력*을 잠근다.
#![cfg(feature = "rhwp")]

use hwp_model::prelude::*;

fn bench() -> Vec<u8> {
    std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../benchmarks/benchmark1.hwpx"
    ))
    .expect("benchmark1.hwpx")
}

struct Stats {
    paras: usize,
    tables: usize,
    shapes: usize,
    per_script_fonts: usize,
    with_ratio: usize,
}

fn stats(doc: &SemanticDoc) -> Stats {
    let count = |f: &dyn Fn(&Block) -> bool| -> usize {
        doc.sections
            .iter()
            .map(|s| s.blocks.iter().filter(|b| f(b)).count())
            .sum()
    };
    Stats {
        paras: count(&|b| matches!(b, Block::Paragraph(_))),
        tables: count(&|b| matches!(b, Block::Table(_))),
        shapes: doc.char_shapes.len(),
        per_script_fonts: doc
            .char_shapes
            .iter()
            .filter(|c| !c.fonts.is_empty())
            .count(),
        with_ratio: doc
            .char_shapes
            .iter()
            .filter(|c| c.ratio.0.iter().any(|&r| r != 0))
            .count(),
    }
}

/// 파리티: 구조(문단/표)는 두 파서가 정확히 일치해야 하고, 조판에 직접 쓰이는 글자 속성
/// (스크립트별 글꼴·장평)은 우리 파서도 **실질적으로** 채워야 한다.
#[test]
fn hwpx_parser_parity_with_rhwp() {
    let bytes = bench();

    let ours = stats(
        &hwp_hwpx::HwpxParser::new()
            .parse(&bytes, hwp_model::types::SourceFormat::Hwpx)
            .expect("자체 파서"),
    );
    let theirs = stats(&hwp_rhwp::parse_to_semantic_guarded(&bytes).expect("rhwp 경로"));

    // 구조는 완전 일치 — 어긋나면 블록 누락/누출(머리말·각주가 본문으로 새는 종류)이다.
    assert_eq!(
        (ours.paras, ours.tables),
        (theirs.paras, theirs.tables),
        "구조 불일치: 우리 문단 {}/표 {} vs rhwp 문단 {}/표 {}",
        ours.paras,
        ours.tables,
        theirs.paras,
        theirs.tables
    );

    // 장평(장평 미독해 = 전 런이 100% 폭 → 조기 줄바꿈 → 페이지 증가) 과 스크립트별 글꼴
    // (미해석 = 라틴/한자 런이 한글 서체로 렌더) 은 조판/렌더 직결이라 회귀를 막는다.
    // rhwp 는 charPr 을 XML id 1:1 로 보관하고 우리는 값 기준 dedup 이므로 개수는 다를 수 있다
    // — 그래서 "0 이 아님 + 전체의 과반" 으로 느슨하게 잠근다.
    assert!(
        ours.with_ratio * 2 > ours.shapes && theirs.with_ratio > 0,
        "장평 미독해 회귀: 우리 {}/{} vs rhwp {}/{}",
        ours.with_ratio,
        ours.shapes,
        theirs.with_ratio,
        theirs.shapes
    );
    assert!(
        ours.per_script_fonts * 2 > ours.shapes,
        "스크립트별 글꼴 미해석 회귀: 우리 {}/{}",
        ours.per_script_fonts,
        ours.shapes
    );

    println!(
        "파리티 OK — 문단 {} · 표 {} · charShape 우리 {}(장평 {}, 스크립트글꼴 {}) vs rhwp {}",
        ours.paras, ours.tables, ours.shapes, ours.with_ratio, ours.per_script_fonts, theirs.shapes
    );
}
