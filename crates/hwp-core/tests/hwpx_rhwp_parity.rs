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

/// 필드(하이퍼링크) 범위가 실물에서 살아 오는지 — benchmark1.hwpx 는 표 셀 안에 `HYPERLINK`
/// 한 쌍(`fieldEnd` 가 `fieldBegin` **앞**에 오는 한컴 실제 배치)을 담고 있다. 예전엔 파서가
/// `<hp:fieldBegin>`/`<hp:fieldEnd>` 를 `other =>` 폴백에서 버려 범위가 통째로 소실됐다.
#[test]
fn hwpx_parser_recovers_the_hyperlink_field_pair() {
    let doc = hwp_hwpx::HwpxParser::new()
        .parse(&bench(), hwp_model::types::SourceFormat::Hwpx)
        .expect("자체 파서");

    fn walk(bs: &[Block], b: &mut usize, e: &mut usize, cmd: &mut Vec<String>) {
        for blk in bs {
            match blk {
                Block::Paragraph(p) => {
                    for i in p.runs.iter().flat_map(|r| &r.content) {
                        match i {
                            Inline::FieldBegin(m) => {
                                *b += 1;
                                cmd.push(m.command.clone());
                            }
                            Inline::FieldEnd(_) => *e += 1,
                            _ => {}
                        }
                    }
                }
                Block::Table(t) => {
                    for c in &t.cells {
                        walk(&c.blocks, b, e, cmd);
                    }
                }
            }
        }
    }
    let (mut b, mut e, mut cmd) = (0usize, 0usize, Vec::new());
    for s in &doc.sections {
        walk(&s.blocks, &mut b, &mut e, &mut cmd);
    }
    assert_eq!((b, e), (1, 1), "benchmark1.hwpx 의 필드 1쌍이 살아야 한다");
    assert!(
        cmd[0].contains("hometax.go.kr"),
        "하이퍼링크 URL(Command)까지 살아야 한다: {:?}",
        cmd
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
/// 왜 별도 오라클인가: CLI `layout-check <파일>.hwpx`도 이제 production HWPX parser를 타지만,
/// 한컴-authored lineseg cache가 있어야 줄수 점수를 낼 수 있다. 이 테스트는 cache 유무와 무관하게
/// 우리 HWPX parser와 rhwp lift의 구조/조판 파리티를 고정한다: rhwp lift를 정답지로 두고
/// **엔진을 고정한 채 파서만 바꿔** 차이를 본다.
///
/// 잠그는 것:
/// 1. **총 줄수 완전 일치** — 표 앵커 문단(`is_table_anchor`)을 안 세우면 표마다 빈 줄이 1개씩
///    초과 예약된다(측정: 368 vs 301, 정확히 표 67개만큼 초과). 구조 회귀의 가장 예민한 탐지기.
/// 2. **쪽수 완전 일치** — 이슈 074 전에는 18 vs 20 이었고 "행 높이 바닥 정책 차이"로 설명했다.
///    이제는 그 차이가 없다: 조판기가 `row_heights` 가 비면 `stored_row_heights` 를 바닥으로
///    쓰므로(`apply_row_overrides`, 074) 두 파서가 같은 표 높이를 얻는다. 실측 22쪽/301줄 ==
///    22쪽/301줄. 바닥을 명시적으로 깔아도(아래 `floored`) 결과가 같아야 한다 — 바닥이 이미
///    적용됐다는 뜻이고, 이게 깨지면 020/054 의 렌더 IR 이 조판에서 새는 것이다.
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
        op, tp,
        "쪽수 불일치: 우리 파서 {op} vs rhwp lift {tp} (074 이후 두 경로는 같은 표 높이를 얻는다)"
    );
    assert_eq!(
        (fp, fl),
        (op, ol),
        "저장 행높이를 명시적으로 깔았더니 결과가 달라졌다 = 조판기가 이미 바닥을 쓰고 있지 않다"
    );
}
