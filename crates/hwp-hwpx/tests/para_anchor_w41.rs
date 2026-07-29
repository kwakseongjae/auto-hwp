//! W4.1 — HWPX 익스포터 **문단** 앵커링 재현/회귀 가드 (057 표 레인의 문단 판).
//!
//! 증상(수정 전): hwpx 오리진 문서에서 캐럿 Enter(`Op::SplitParagraph`)나 `InsertParagraphAt` 으로
//! 생긴 새 문단은 `source: None`(바이트 스팬 없음)이라 재직렬화 시 **섹션 맨 끝**에 inject 됐다
//! (serialize.rs 의 append 레인) → 저장·재열기하면 문서 순서가 파손됐다.
//! 수정 후: 새 문단은 이웃 문단의 `ParaSource::span` 을 앵커로 삼아 **제자리**에 삽입된다.

use hwp_hwpx::parse::parse_semantic;
use hwp_hwpx::serialize::serialize;
use hwp_model::prelude::*;

const HEAD: &str = "W41머리조각";
const TAIL: &str = "W41꼬리조각";

fn showcase() -> Vec<u8> {
    let p = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../corpus/hwpx/FormattingShowcase.hwpx"
    );
    std::fs::read(p).expect("read corpus/hwpx/FormattingShowcase.hwpx")
}

fn section0_xml(bytes: &[u8]) -> String {
    let pkg = hwp_hwpx::package::Package::open(bytes).unwrap();
    String::from_utf8(pkg.read_part("Contents/section0.xml").unwrap()).unwrap()
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

/// 오리진에서 읽어온(= `source` 스팬을 가진) 단순 본문 문단들의 블록 인덱스.
fn simple_para_indices(doc: &SemanticDoc) -> Vec<usize> {
    doc.sections[0]
        .blocks
        .iter()
        .enumerate()
        .filter_map(|(i, b)| match b {
            Block::Paragraph(p)
                if p.source.as_ref().is_some_and(|s| s.simple)
                    && !para_text(b).trim().is_empty() =>
            {
                Some(i)
            }
            _ => None,
        })
        .collect()
}

/// `Op::SplitParagraph` 와 동일한 모델 변이: 머리 문단은 정체성(`source` 스팬)을 그대로 두고 내용만
/// 바꾸고, 꼬리는 `source: None` 새 문단으로 바로 다음 인덱스에 삽입한다.
fn split_at(doc: &mut SemanticDoc, bi: usize) {
    let sec = doc.sections.get_mut(0).unwrap();
    let Block::Paragraph(p) = &mut sec.blocks[bi] else {
        panic!("block {bi} is not a paragraph")
    };
    let para_shape = p.para_shape;
    let para_ref = p.para_ref.clone();
    let style_name = p.style_name.clone();
    let char_shape = p.runs.first().map(|r| r.char_shape).unwrap_or(0);
    let char_ref = p.runs.first().and_then(|r| r.char_ref.clone());
    p.runs = vec![Run {
        char_shape,
        char_ref: char_ref.clone(),
        content: vec![Inline::Text(HEAD.into())],
    }];
    p.dirty.mark();
    let tail = Paragraph {
        para_shape,
        para_ref,
        style_name,
        runs: vec![Run {
            char_shape,
            char_ref,
            content: vec![Inline::Text(TAIL.into())],
        }],
        source: None,
        dirty: Dirty(true),
        ..Default::default()
    };
    sec.blocks.insert(bi + 1, Block::Paragraph(tail));
    sec.dirty.mark();
}

/// 재현 본체: 중간 문단을 나눈 뒤 재방출 → 꼬리 문단이 **머리 바로 다음**에 앉아야 한다
/// (수정 전 레드 — 꼬리가 섹션 맨 끝으로 밀려 문서 순서가 뒤집혔다).
#[test]
fn split_paragraph_tail_lands_next_to_its_head_not_at_section_end() {
    let src = showcase();
    let mut doc = parse_semantic(&src).unwrap();

    let simple = simple_para_indices(&doc);
    assert!(
        simple.len() >= 2,
        "fixture must have ≥2 simple body paragraphs, got {simple:?}"
    );
    let bi = simple[0];
    // 머리 뒤에 오는 원본 문단(문서 순서 기준 후행 sentinel).
    let follower = para_text(&doc.sections[0].blocks[simple[1]])
        .trim()
        .to_string();
    assert!(!follower.is_empty(), "follower sentinel has text");
    let n_blocks = doc.sections[0].blocks.len();

    split_at(&mut doc, bi);
    let out = serialize(&doc).unwrap();
    let doc2 = parse_semantic(&out).unwrap();

    // ① 블록 수는 정확히 +1 (중복 append 없음).
    assert_eq!(
        doc2.sections[0].blocks.len(),
        n_blocks + 1,
        "exactly one new paragraph"
    );

    // ② 머리/꼬리가 원 위치에 연속으로 앉는다.
    assert_eq!(
        para_text(&doc2.sections[0].blocks[bi]).trim(),
        HEAD,
        "head paragraph keeps its original block index"
    );
    assert_eq!(
        para_text(&doc2.sections[0].blocks[bi + 1]).trim(),
        TAIL,
        "tail paragraph sits immediately AFTER its head (not at the section end)"
    );

    // ③ 문서 순서: 머리 < 꼬리 < 후행 원본 문단.
    let text = doc2.plain_text();
    let ph = text.find(HEAD).expect("head text present");
    let pt = text.find(TAIL).expect("tail text present");
    let pf = text.find(&follower).expect("follower text present");
    assert!(
        ph < pt && pt < pf,
        "document order must be head→tail→follower, got head={ph} tail={pt} follower={pf}"
    );

    // ④ 마커(placeholder)가 저장 바이트에 새지 않는다.
    let xml = section0_xml(&out);
    assert!(
        !xml.contains('\u{0}'),
        "no anchor placeholder leaks into the saved XML"
    );
    assert!(
        hwp_hwpx::export::validate_open_safety(&out).ok,
        "output is open-safe"
    );
}

/// 앵커가 **다음** 형제뿐인 경우: 섹션 첫 문단 앞에 새 문단을 끼우면 그 문단보다 앞에 놓여야 한다.
#[test]
fn inserted_paragraph_before_first_body_paragraph_stays_first() {
    let src = showcase();
    let mut doc = parse_semantic(&src).unwrap();

    let simple = simple_para_indices(&doc);
    let bi = *simple.first().expect("fixture has a simple body paragraph");
    let anchor_text = para_text(&doc.sections[0].blocks[bi]).trim().to_string();

    let sec = doc.sections.get_mut(0).unwrap();
    sec.blocks.insert(
        bi,
        Block::Paragraph(Paragraph {
            runs: vec![Run {
                content: vec![Inline::Text(HEAD.into())],
                ..Default::default()
            }],
            source: None,
            dirty: Dirty(true),
            ..Default::default()
        }),
    );
    sec.dirty.mark();

    let out = serialize(&doc).unwrap();
    let doc2 = parse_semantic(&out).unwrap();

    let text = doc2.plain_text();
    let pn = text.find(HEAD).expect("new paragraph text present");
    let pa = text
        .find(&anchor_text)
        .expect("anchor paragraph text present");
    assert!(
        pn < pa,
        "an inserted paragraph must precede the paragraph it was inserted before"
    );
}

/// verbatim 해자 무회귀: 무편집 재방출은 섹션 XML을 바이트 그대로 보존한다(앵커 레인이 꺼져 있다).
#[test]
fn noedit_export_keeps_section_verbatim() {
    let src = showcase();
    let doc = parse_semantic(&src).unwrap();
    let out = serialize(&doc).unwrap();
    assert_eq!(
        section0_xml(&out),
        section0_xml(&src),
        "no-edit section XML is byte-verbatim"
    );
}
