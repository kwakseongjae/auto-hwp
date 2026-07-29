//! W4.2 — 구조 문단(섹션 첫 문단 = `<hp:secPr>` 호스트)의 **텍스트 편집 개방** 재현/회귀 가드.
//!
//! 증상(수정 전): 섹션의 첫 `<hp:p>` 는 페이지 설정(`<hp:secPr>`)을 품기 때문에 파서가 항상
//! `simple = false` 로 표시한다 → `ensure_simple_para` 가 그 문단의 **텍스트 교체를 일괄 거부**했다.
//! 실문서에서 이 문단은 대개 **제목**이라, HWPX 를 열면 제목만 편집이 막히는 상태였다.
//! 수정 후: 파서가 그 문단의 "텍스트 런 구역"(`ParaSource::text_zone`)을 계산하고, 직렬화가 그
//! 바이트 범위만 교체한다 — `<hp:secPr>`/`<hp:ctrl>` 은 **바이트 그대로** 살아남는다.
//!
//! 057(셀 스팬 splice) → W4.1(문단 앵커) → W4.2(런 구역 splice) 로 이어지는 같은 규율의 확장.

use hwp_hwpx::parse::parse_semantic;
use hwp_mcp::{apply_intent, export_bytes, open_bytes, Intent, Outcome, Session};
use hwp_model::prelude::*;

fn fixture() -> Vec<u8> {
    let p = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../corpus/hwpx/FormattingShowcase.hwpx"
    );
    std::fs::read(p).expect("read corpus/hwpx/FormattingShowcase.hwpx")
}

fn para_text(b: &Block) -> String {
    match b {
        Block::Paragraph(p) => p
            .runs
            .iter()
            .flat_map(|r| &r.content)
            .filter_map(|i| match i {
                Inline::Text(t) => Some(t.as_str()),
                _ => None,
            })
            .collect(),
        Block::Table(_) => String::new(),
    }
}

fn section0_xml(bytes: &[u8]) -> String {
    let pkg = hwp_hwpx::package::Package::open(bytes).unwrap();
    String::from_utf8(pkg.read_part("Contents/section0.xml").unwrap()).unwrap()
}

/// 섹션의 secPr 호스트 문단 = `simple == false` 인 **첫** 최상위 문단.
fn secpr_host_index(doc: &SemanticDoc) -> usize {
    doc.sections[0]
        .blocks
        .iter()
        .position(
            |b| matches!(b, Block::Paragraph(p) if p.source.as_ref().is_some_and(|s| !s.simple)),
        )
        .expect("fixture has a structural (secPr host) paragraph")
}

/// `PageSetup` 은 `PartialEq` 를 안 가지므로 비교 가능한 튜플로 뽑는다(secPr 보존 확인용).
fn page_probe(doc: &SemanticDoc) -> (i32, i32, i32, i32, i32, i32, bool) {
    let p = &doc.sections[0].page;
    (
        p.width,
        p.height,
        p.margin_left,
        p.margin_right,
        p.margin_top,
        p.margin_bottom,
        p.landscape,
    )
}

const TITLE: &str = "W42 섹션 제목";

#[test]
fn parser_marks_secpr_host_editable_via_text_zone() {
    let doc = parse_semantic(&fixture()).unwrap();
    let bi = secpr_host_index(&doc);
    let Block::Paragraph(p) = &doc.sections[0].blocks[bi] else {
        unreachable!()
    };
    let src = p.source.as_ref().unwrap();
    assert!(!src.simple, "secPr 호스트는 여전히 non-simple 이어야 한다");
    let z = src
        .text_zone
        .expect("secPr 호스트 문단은 편집 가능한 텍스트 구역을 가져야 한다 (W4.2)");
    assert!(
        z.runs.0 < z.runs.1 && z.runs.1 <= p.runs.len(),
        "런 구간 {z:?}"
    );
    assert!(
        z.runs.0 > 0,
        "구조 런(secPr/ctrl)은 구역 밖이어야 한다 — 구역 시작 {}",
        z.runs.0
    );
    assert!(
        src.span.0 <= z.span.0 && z.span.1 <= src.span.1,
        "구역 바이트 스팬은 문단 스팬 안에 있어야 한다 ({:?} ⊄ {:?})",
        z.span,
        src.span
    );
}

/// 레드→그린의 본체: 예전엔 여기서 `apply_intent` 가 거부됐다.
#[test]
fn secpr_host_paragraph_accepts_text_commit_and_keeps_secpr_verbatim() {
    let src = fixture();
    let before = parse_semantic(&src).unwrap();
    let bi = secpr_host_index(&before);
    let page_before = page_probe(&before);
    let n_blocks = before.sections[0].blocks.len();

    let mut session = Session::default();
    open_bytes(&mut session, &src, "FormattingShowcase.hwpx").expect("open hwpx origin");

    let out = apply_intent(
        &mut session,
        Intent::SetParagraphRuns {
            section: 0,
            block: bi,
            runs: vec![hwp_ops::RunSpec {
                text: TITLE.into(),
                ..Default::default()
            }],
        },
    )
    .expect("섹션 첫 문단의 텍스트 커밋이 받아들여져야 한다 (W4.2)");
    assert!(!matches!(out, Outcome::Discarded(_)), "edit applied");

    let bytes = export_bytes(&session).expect("export_bytes");
    let xml = section0_xml(&bytes);

    // ① secPr 은 **한 번만**, 바이트 그대로 (중복 삽입·소실 둘 다 금지).
    assert_eq!(
        xml.matches("<hp:secPr").count(),
        1,
        "secPr 은 정확히 하나 남아야 한다"
    );
    for probe in [
        "<hp:pagePr",
        "<hp:footNotePr>",
        "<hp:pageBorderFill",
        "<hp:colPr",
    ] {
        assert!(xml.contains(probe), "구조 자식 {probe} 가 사라졌다");
    }
    // ② 새 텍스트가 실제로 들어갔다.
    assert!(xml.contains(TITLE), "새 제목 텍스트가 저장되지 않았다");

    // ③ 재파싱: 블록 수 불변(끝 append 복제 없음) + 첫 문단 텍스트 = 새 제목 + 페이지 설정 보존.
    let after = parse_semantic(&bytes).unwrap();
    assert_eq!(
        after.sections[0].blocks.len(),
        n_blocks,
        "블록 수가 변하면 안 된다"
    );
    assert_eq!(
        para_text(&after.sections[0].blocks[bi]),
        TITLE,
        "secPr 호스트 문단의 텍스트가 교체돼야 한다"
    );
    assert_eq!(
        page_probe(&after),
        page_before,
        "페이지 설정(secPr)은 편집 전과 동일해야 한다"
    );
    assert!(
        hwp_hwpx::export::validate_open_safety(&bytes).ok,
        "exported package is open-safe"
    );
}

/// 두 번 연속 편집해도 구역이 따라 움직인다(첫 커밋이 런 수를 바꾼 뒤에도 앵커 유효).
#[test]
fn secpr_host_paragraph_survives_a_second_text_commit() {
    let src = fixture();
    let bi = secpr_host_index(&parse_semantic(&src).unwrap());

    let mut session = Session::default();
    open_bytes(&mut session, &src, "FormattingShowcase.hwpx").unwrap();
    for text in ["첫 번째", "두 번째 제목입니다"] {
        apply_intent(
            &mut session,
            Intent::SetParagraphRuns {
                section: 0,
                block: bi,
                runs: vec![hwp_ops::RunSpec {
                    text: text.into(),
                    ..Default::default()
                }],
            },
        )
        .expect("연속 텍스트 커밋");
    }
    let bytes = export_bytes(&session).unwrap();
    let xml = section0_xml(&bytes);
    assert_eq!(xml.matches("<hp:secPr").count(), 1);
    assert!(!xml.contains("첫 번째"), "이전 커밋 텍스트가 남았다");
    assert!(xml.contains("두 번째 제목입니다"));
    let after = parse_semantic(&bytes).unwrap();
    assert_eq!(
        para_text(&after.sections[0].blocks[bi]),
        "두 번째 제목입니다"
    );
}

/// 무편집 왕복은 여전히 **바이트 동일** — 새 레인이 verbatim 해자를 건드리지 않았다.
#[test]
fn no_edit_roundtrip_stays_byte_verbatim() {
    let src = fixture();
    let mut session = Session::default();
    open_bytes(&mut session, &src, "FormattingShowcase.hwpx").unwrap();
    let bytes = export_bytes(&session).unwrap();
    assert_eq!(
        section0_xml(&bytes),
        section0_xml(&src),
        "무편집 저장은 섹션 XML 을 바이트 그대로 두어야 한다"
    );
}
