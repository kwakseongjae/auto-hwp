//! #543 — 공개 코퍼스의 HWPX 표 캡션(재난안전 문서 · 위 캡션 10개). 파서가 `Table.caption` 으로 읽고, .hwp 가
//! 이미 타는 공유 흐름으로 그려진다. 고치지 않은 저장은 바이트 그대로다.

use hwp_hwpx::parse::parse_semantic;
use hwp_model::prelude::*;
use hwp_typeset::{body_box, place_doc, ApproxFontMetrics, NaiveLayout, PlacedDoc};

const DISASTER: &str = "error/20250808/2015년_12월_재난안전종합상황_분석_및_전망.hwpx";

fn read(rel: &str) -> Vec<u8> {
    let path = format!(
        "{}/../../corpus/hwpxlib_corpus/{rel}",
        env!("CARGO_MANIFEST_DIR")
    );
    std::fs::read(&path).expect(&path)
}

fn captions(doc: &SemanticDoc) -> Vec<(usize, &TableCaption)> {
    doc.sections[0]
        .blocks
        .iter()
        .enumerate()
        .filter_map(|(i, b)| match b {
            Block::Table(t) => t.caption.as_ref().map(|c| (i, c)),
            Block::Paragraph(_) => None,
        })
        .collect()
}

fn text(blocks: &[Block]) -> String {
    blocks
        .iter()
        .filter_map(|b| match b {
            Block::Paragraph(p) => Some(p),
            Block::Table(_) => None,
        })
        .flat_map(|p| &p.runs)
        .flat_map(|r| &r.content)
        .filter_map(|i| match i {
            Inline::Text(t) => Some(t.as_str()),
            _ => None,
        })
        .collect()
}

/// Ink glyphs inside the body box — the running header / footer repeat on every page, so a document that
/// gains a page would otherwise gain their glyphs too.
fn ink(doc: &SemanticDoc, placed: &PlacedDoc) -> usize {
    let (_, mt, _, body_h) = body_box(&doc.sections[0].page);
    placed
        .pages
        .iter()
        .flat_map(|pg| &pg.glyphs)
        .filter(|g| !g.ch.is_whitespace() && g.baseline > mt && g.baseline <= mt + body_h + 1.0)
        .count()
}

#[test]
fn disaster_captions_are_read_and_drawn() {
    let doc = parse_semantic(&read(DISASTER)).expect("parse");
    let caps = captions(&doc);
    assert_eq!(caps.len(), 10, "위 캡션 10개");
    for (_, c) in &caps {
        assert_eq!(c.position, TableCaptionPosition::Top);
        assert_eq!((c.spacing, c.width, c.include_margin), (850, 8504, false));
        assert!(c.max_width > 40_000, "lastWidth {}", c.max_width);
        // 모양 풀이가 캡션 문단도 돈다(0 = 풀지 않은 기본 모양).
        let p = c.blocks.iter().find_map(|b| match b {
            Block::Paragraph(p) => Some(p),
            Block::Table(_) => None,
        });
        assert!(p.is_some_and(|p| p.para_shape != 0 && p.runs.iter().any(|r| r.char_shape != 0)));
    }
    // 캡션 글이 모두 그려진다: 캡션을 뺀 같은 문서보다 그린 글자가 캡션 글자 수만큼 많다.
    let chars: usize = caps
        .iter()
        .map(|(_, c)| {
            text(&c.blocks)
                .chars()
                .filter(|ch| !ch.is_whitespace())
                .count()
        })
        .sum();
    let mut bare = doc.clone();
    for b in &mut bare.sections[0].blocks {
        if let Block::Table(t) = b {
            t.caption = None;
        }
    }
    let placed = place_doc(&doc, &ApproxFontMetrics);
    assert_eq!(
        ink(&doc, &placed) - ink(&bare, &place_doc(&bare, &ApproxFontMetrics)),
        chars
    );
    // LOCKSTEP · 알림 없음(위 캡션은 그려진다).
    assert_eq!(
        placed.pages.len(),
        NaiveLayout
            .layout(&doc, &ApproxFontMetrics)
            .unwrap()
            .pages
            .len()
    );
    assert!(placed
        .pages
        .iter()
        .flat_map(|pg| &pg.undrawn_shapes)
        .all(|u| u.reason != hwp_typeset::UndrawnShape::TableCaption));
}

#[test]
fn unedited_save_keeps_the_captions_byte_for_byte() {
    let bytes = read(DISASTER);
    let doc = parse_semantic(&bytes).expect("parse");
    let saved = hwp_hwpx::serialize::serialize(&doc).expect("serialize");
    let part = |zip: &[u8]| {
        hwp_hwpx::package::Package::open(zip)
            .unwrap()
            .read_part("Contents/section0.xml")
            .unwrap()
    };
    assert!(part(&saved) == part(&bytes));
}
