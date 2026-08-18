//! **교차포맷 파서 파리티 오라클** — 같은 `.hwpx` 를 ① 우리 HWPX 파서와 ② rhwp(HWPX 를 자동
//! 감지해 완전 파싱) 로 각각 읽어 IR 을 대조한다.
//!
//! 왜 필요한가: `.hwp` 는 rhwp lift 를 거쳐 조판 충실도 99.2%(18==18) 인데 `.hwpx` 는 자체 파서라
//! 같은 내용에서 86.9%/+1p 로 떨어졌다. 원인은 코드가 아니라 **읽지 않는 속성**이었다 — 값 기준
//! dedup(`intern_shape`) 이라 안 읽는 필드가 많을수록 서로 다른 charPr 이 하나로 뭉갠다
//! (benchmark1: 214 → 87). rhwp 를 정답지로 두면 그 갭이 사람 눈 없이 드러난다.
//!
//! 조판 게이트(layout-check 8==8 / 18==18)는 *결과*를 잠그지만 이 테스트는 *입력*을 잠근다.
//! 조판 파리티는 T0 이후 **부분집합 동등**이다 — rhwp 가 표현하는 본문만 줄수/쪽수를 맞추고,
//! 살린 요소(폼·머리말 표·가로 스왑)는 개수만 고정한다.
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

/// 우리가 rhwp lift 보다 더 살린 요소 — 정합 비교에서 빼되, 개수는 고정한다 (T0 / #42).
/// 제외가 침묵 구멍이 되지 않게, 픽스처마다 이 숫자가 바뀌면 테스트가 깨진다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct RevivedExtras {
    /// 본문·머리말에 보이는 폼 컨트롤 표식(`☐`/`☑`) 런 수.
    form_control_marks: usize,
    /// `Section.decorations` 안의 표 수 (머리말/꼬리말 제목 표).
    header_footer_tables: usize,
    /// `display_paper` 가 가로로 뒤바꿀 구역 수 (`landscape && width < height`).
    landscape_swaps: usize,
}

fn walk_blocks(blocks: &[Block], f: &mut dyn FnMut(&Block)) {
    for b in blocks {
        f(b);
        if let Block::Table(t) = b {
            for c in &t.cells {
                walk_blocks(&c.blocks, f);
            }
        }
    }
}

fn is_form_mark_text(t: &str) -> bool {
    let t = t.trim_start();
    t.starts_with('☐') || t.starts_with('☑')
}

fn revived_extras(doc: &SemanticDoc) -> RevivedExtras {
    let mut form_control_marks = 0;
    let mut header_footer_tables = 0;
    let mut landscape_swaps = 0;
    let mut count_forms = |blocks: &[Block]| {
        walk_blocks(blocks, &mut |b| {
            if let Block::Paragraph(p) = b {
                for r in &p.runs {
                    for i in &r.content {
                        if let Inline::Text(t) = i {
                            if is_form_mark_text(t) {
                                form_control_marks += 1;
                            }
                        }
                    }
                }
            }
        });
    };
    for sec in &doc.sections {
        if sec.page.landscape && sec.page.width < sec.page.height {
            landscape_swaps += 1;
        }
        count_forms(&sec.blocks);
        for deco in &sec.decorations {
            count_forms(&deco.blocks);
            walk_blocks(&deco.blocks, &mut |b| {
                if matches!(b, Block::Table(_)) {
                    header_footer_tables += 1;
                }
            });
        }
    }
    RevivedExtras {
        form_control_marks,
        header_footer_tables,
        landscape_swaps,
    }
}

fn strip_form_marks(blocks: &mut [Block]) {
    for b in blocks.iter_mut() {
        match b {
            Block::Table(t) => {
                for c in &mut t.cells {
                    strip_form_marks(&mut c.blocks);
                }
            }
            Block::Paragraph(p) => {
                for r in &mut p.runs {
                    r.content.retain(|i| match i {
                        Inline::Text(t) => !is_form_mark_text(t),
                        _ => true,
                    });
                }
            }
        }
    }
    // 빈 스페이서·표 앵커 문단은 조판 높이에 들어가므로 지우지 않는다.
    // 폼 전용 문단이 비더라도 줄 하나 — benchmark1 은 폼 0개라 무해하고,
    // 픽스처가 폼을 품으면 extras.form_control_marks 가 먼저 깨진다.
}

/// rhwp lift 가 표현하는 부분집합 — 본문 문단·표. 폼 표식·머리말 표·HWP5 가로 스왑은 뺀다.
fn rhwp_expressible_subset(doc: &SemanticDoc) -> SemanticDoc {
    let mut d = doc.clone();
    for sec in &mut d.sections {
        sec.decorations.clear();
        // HWPX 규약: 가로 여부는 저장된 상자에서 유도한다. rhwp 가 HWPX 에 남긴
        // `landscape=true` + 세로 상자(WIDELY 오표기)에 HWP5 스왑을 적용하지 않는다.
        sec.page.landscape = sec.page.width > sec.page.height;
        strip_form_marks(&mut sec.blocks);
    }
    d
}

/// `benchmark1.hwpx` 에서 우리가 살린 요소의 개수. rhwp 경로는 HWPX Skeleton 이
/// 세로 상자에 `landscape=true` 를 붙여 스왑 후보가 1이다. 머리말 표·폼은 이 픽스처에 없다.
const BENCH1_OURS_EXTRAS: RevivedExtras = RevivedExtras {
    form_control_marks: 0,
    header_footer_tables: 0,
    landscape_swaps: 0,
};
const BENCH1_RHWP_EXTRAS: RevivedExtras = RevivedExtras {
    form_control_marks: 0,
    header_footer_tables: 0,
    landscape_swaps: 1,
};

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

/// **조판 파리티 (T0 부분집합 동등)** — 같은 `.hwpx` 를 우리 파서 / rhwp lift 로 읽어
/// **rhwp 가 표현하는 본문 부분집합**만 같은 엔진으로 조판한다.
///
/// #42 수리가 폼 컨트롤·머리말 표·HWP5 가로 스왑을 살리면, 그 요소는 rhwp lift 에 없거나
/// (HWPX Skeleton 의 오표기 `landscape=true`) 다르게 부호화된다. 그 차이를 "우리 301 vs
/// rhwp 282"처럼 전량 동등으로 잠그면 수리가 게이트를 깨뜨린다. 그래서:
/// 1. 살린 요소는 비교에서 **명시적으로 제외**하고 (`rhwp_expressible_subset`)
/// 2. 제외 개수는 `BENCH1_*_EXTRAS` 로 **고정**한다 — 침묵 구멍 방지.
/// 3. 살린 요소 자체는 이 파일이 아닌 픽스처 테스트가 잠근다.
///
/// 잠그는 것 (부분집합):
/// 1. **총 줄수 완전 일치** — 표 앵커 문단(`is_table_anchor`)을 안 세우면 표마다 빈 줄이 1개씩
///    초과 예약된다(측정: 368 vs 301, 정확히 표 67개만큼 초과). 구조 회귀의 가장 예민한 탐지기.
/// 2. **쪽수 완전 일치** — 이슈 074 이후 두 파서는 같은 표 높이를 얻는다. 실측 22쪽/301줄.
///    바닥을 명시적으로 깔아도 결과가 같아야 한다.
#[test]
fn hwpx_parser_typesets_like_the_rhwp_lift() {
    let bytes = bench();
    let ours = hwp_hwpx::HwpxParser::new()
        .parse(&bytes, hwp_model::types::SourceFormat::Hwpx)
        .expect("자체 파서");
    let theirs = hwp_rhwp::parse_to_semantic_guarded(&bytes).expect("rhwp 경로");

    let ours_x = revived_extras(&ours);
    let theirs_x = revived_extras(&theirs);
    assert_eq!(
        ours_x, BENCH1_OURS_EXTRAS,
        "우리 파서에서 제외한 살린 요소 수가 바뀌었다: {ours_x:?}"
    );
    assert_eq!(
        theirs_x, BENCH1_RHWP_EXTRAS,
        "rhwp lift 에서 제외한 살린 요소 수가 바뀌었다: {theirs_x:?}"
    );

    let ours = rhwp_expressible_subset(&ours);
    let theirs = rhwp_expressible_subset(&theirs);

    let (op, ol) = typeset(&ours);
    let (tp, tl) = typeset(&theirs);

    let mut floored = ours.clone();
    for sec in &mut floored.sections {
        floor_rows_to_stored(&mut sec.blocks);
    }
    let (fp, fl) = typeset(&floored);
    println!(
        "조판 파리티(부분집합) — 제외 ours={ours_x:?} rhwp={theirs_x:?} · 우리 {op}쪽/{ol}줄 (행높이 바닥고정 시 {fp}쪽/{fl}줄) · rhwp lift {tp}쪽/{tl}줄"
    );

    assert_eq!(
        (op, ol),
        (22, 301),
        "benchmark1.hwpx 부분집합 조판이 22쪽/301줄에서 벗어났다: {op}쪽/{ol}줄"
    );
    assert_eq!(
        ol, tl,
        "총 줄수 불일치(부분집합): 우리 {ol} vs rhwp lift {tl}"
    );
    assert_eq!(
        op, tp,
        "쪽수 불일치(부분집합): 우리 파서 {op} vs rhwp lift {tp}"
    );
    assert_eq!(
        (fp, fl),
        (op, ol),
        "저장 행높이를 명시적으로 깔았더니 결과가 달라졌다 = 조판기가 이미 바닥을 쓰고 있지 않다"
    );
}
