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

/// 같은 IR 을 같은 엔진으로 조판했을 때의 (쪽수, 총 줄수).
fn typeset(doc: &SemanticDoc) -> (usize, usize) {
    use hwp_model::capability::LayoutEngine;
    use hwp_typeset::{ApproxFontMetrics, NaiveLayout};
    let r = NaiveLayout.layout(doc, &ApproxFontMetrics).expect("조판");
    (r.pages.len(), r.pages.iter().map(|p| p.lines.len()).sum())
}

/// 모든 표의 행 높이를 **저장된 높이로 바닥 고정**한다 — rhwp lift 가 무조건 하는 것
/// (`lift_table`: `row_heights = stored_row_heights(..)`)과 같은 상태로 맞추기 위한 테스트 변환.
fn floor_rows_to_stored(blocks: &mut [Block]) {
    for b in blocks.iter_mut() {
        match b {
            Block::Table(t) => {
                if t.row_heights.iter().all(|&h| h <= 0) && !t.stored_row_heights.is_empty() {
                    t.row_heights = t.stored_row_heights.clone();
                }
                for c in &mut t.cells {
                    floor_rows_to_stored(&mut c.blocks);
                }
            }
            Block::Paragraph(_) => {}
        }
    }
}

/// **조판 파리티** — 같은 `.hwpx` 를 우리 파서로 읽어 조판한 결과가 rhwp lift 로 읽어 조판한
/// 결과와 (알려진 정책 차이 하나를 빼고) 같아야 한다.
///
/// 왜 별도 오라클인가: `auto-hwp layout-check <파일>.hwpx` 는 우리 HWPX 파서를 **타지 않는다**
/// — `layout_fidelity` 가 양쪽 모두 `hwp_rhwp::lift::parse_to_semantic` 으로 읽기 때문이다
/// (게다가 변환된 hwpx 는 `<hp:linesegarray>` 를 잃어서 오라클 줄수가 "문단당 1줄"로 퇴화한다).
/// 그래서 HWPX 파서의 조판 충실도는 저 CLI 수치로는 절대 측정되지 않는다. 이 테스트가 그 자리를
/// 메운다: rhwp lift 를 정답지로 두고 **엔진을 고정한 채 파서만 바꿔** 차이를 본다.
///
/// 잠그는 것:
/// 1. **총 줄수 완전 일치** — 표 앵커 문단(`is_table_anchor`)을 안 세우면 표마다 빈 줄이 1개씩
///    초과 예약된다(측정: 368 vs 301, 정확히 표 67개만큼 초과). 구조 회귀의 가장 예민한 탐지기.
/// 2. **행 높이 정책을 빼면 쪽수도 일치** — 남은 18 vs 20 은 버그가 아니라 의도된 차이다:
///    rhwp lift 는 저장된 셀 높이를 무조건 행 높이 바닥으로 깔지만(→ 한컴의 20쪽 재현), 우리
///    HWPX 파서는 `noAdjust=0`(자동 맞춤)이면 내용 기준으로 두고 저장 높이는 `stored_row_heights`
///    (앱이 FAITHFUL/레이아웃정리로 토글하는 렌더 IR)로만 남긴다 — 이슈 020/054. 바닥을 깔면
///    쪽수도 같아진다는 것을 여기서 증명해, 남은 갭이 **구조가 아니라 정책**임을 못 박는다.
#[test]
fn hwpx_parser_typesets_like_the_rhwp_lift() {
    let bytes = bench();
    let ours = hwp_hwpx::HwpxParser::new()
        .parse(&bytes, hwp_model::types::SourceFormat::Hwpx)
        .expect("자체 파서");
    let theirs = hwp_rhwp::parse_to_semantic_guarded(&bytes).expect("rhwp 경로");

    let (op, ol) = typeset(&ours);
    let (tp, tl) = typeset(&theirs);

    let mut floored = ours.clone();
    for sec in &mut floored.sections {
        floor_rows_to_stored(&mut sec.blocks);
    }
    let (fp, fl) = typeset(&floored);
    println!(
        "조판 파리티 — 우리 {op}쪽/{ol}줄 (행높이 바닥고정 시 {fp}쪽/{fl}줄) · rhwp lift {tp}쪽/{tl}줄"
    );

    assert_eq!(ol, tl, "총 줄수 불일치: 우리 {ol} vs rhwp lift {tl}");
    assert_eq!(
        fp, tp,
        "행 높이 바닥을 맞춰도 쪽수가 다르다 = 정책이 아니라 구조 회귀: 우리 {fp} vs rhwp lift {tp}"
    );
}
