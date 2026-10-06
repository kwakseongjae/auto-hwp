//! #421 — 처음부터 합성한 HWPX(`.hwp → .hwpx` 변환 등)가 내장 바탕(Skeleton)의 작성자 · 작성일을
//! `Contents/content.hpf` 에 그대로 싣던 회귀 가드.
//!
//! 바탕 파일을 저장한 계정 이름(`creator` · `lastsaveby`)과 바탕을 만든 날(2025-09-17)이 변환한 모든
//! 문서의 문서 정보로 나갔다. 이제 그 값은 비운다(빈 `<opf:meta …/>`). HWPX 입력 문서의 메타데이터는
//! 그대로다(무편집 왕복 바이트 동일).

use hwp_hwpx::package::Package;
use hwp_hwpx::parse::parse_semantic;
use hwp_hwpx::serialize::serialize;
use hwp_model::prelude::*;

/// A document with NO HWPX provenance — the shape a lifted `.hwp` has — so `serialize` takes the
/// from-scratch path seeded from the built-in template.
fn lifted_doc() -> SemanticDoc {
    let mut doc = SemanticDoc::default();
    doc.char_shapes.push(CharShape::default());
    doc.para_shapes.push(ParaShape::default());
    doc.sections.push(Section {
        blocks: vec![Block::Paragraph(Paragraph {
            runs: vec![Run {
                char_shape: 0,
                content: vec![Inline::Text("변환된 본문".into())],
                ..Default::default()
            }],
            ..Default::default()
        })],
        ..Default::default()
    });
    doc
}

fn content_hpf(bytes: &[u8]) -> String {
    String::from_utf8(
        Package::open(bytes)
            .unwrap()
            .read_part("Contents/content.hpf")
            .unwrap(),
    )
    .unwrap()
}

/// The text of `<opf:meta name="{name}" …>text</opf:meta>`, `""` for an empty element, `None` if absent.
fn meta(hpf: &str, name: &str) -> Option<String> {
    let open = format!("<opf:meta name=\"{name}\" content=\"text\"");
    let a = hpf.find(&open)? + open.len();
    let rest = &hpf[a..];
    if rest.starts_with("/>") {
        return Some(String::new());
    }
    let body = &rest[1..];
    Some(body[..body.find("</opf:meta>")?].to_string())
}

#[test]
fn synthesized_package_does_not_carry_the_template_author_or_dates() {
    let template = content_hpf(include_bytes!("../../../corpus/hwpx/Skeleton.hwpx"));
    let author = meta(&template, "creator").unwrap();
    assert!(
        !author.is_empty(),
        "fixture: the template has an author to leak"
    );

    let out = serialize(&lifted_doc()).expect("from-scratch synthesis");
    let hpf = content_hpf(&out);
    for name in [
        "creator",
        "lastsaveby",
        "CreatedDate",
        "ModifiedDate",
        "date",
    ] {
        assert_eq!(
            meta(&hpf, name).as_deref(),
            Some(""),
            "{name}: emptied (was {:?} in the template)",
            meta(&template, name)
        );
    }
    assert!(!hpf.contains(&author), "no template account name anywhere");
    assert!(!hpf.contains("2025-09-17"), "no template date anywhere");
    assert!(
        hwp_hwpx::export::validate_synthesis_safety(&out).ok,
        "still open-safe"
    );
    // The body still made it.
    let back = parse_semantic(&out).unwrap();
    assert!(back.plain_text().contains("변환된 본문"));
}

#[test]
fn hwpx_input_keeps_its_own_metadata() {
    // An HWPX-in document is not the template — its content.hpf rides verbatim.
    let src = std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../corpus/hwpx/FormattingShowcase.hwpx"
    ))
    .unwrap();
    let mut doc = parse_semantic(&src).unwrap();
    if let Block::Paragraph(p) = &mut doc.sections[0].blocks[1] {
        p.dirty.mark();
    }
    doc.sections[0].dirty.mark();
    let out = serialize(&doc).unwrap();
    assert_eq!(content_hpf(&out), content_hpf(&src));
}
