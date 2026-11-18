//! #544 — 공개 코퍼스에서 글 앞으로 띄운 표가 있는 두 문서(조사: 공개 · 비공개 HWPX 86개와 .hwp 40개 중
//! 이 둘뿐이고, 글 뒤 표는 없다). 표는 흐름 높이를 쓰지 않고, 표만 품은 호스트 문단은 보통 빈 줄 하나를
//! 쓴다.

use hwp_hwpx::parse::parse_semantic;
use hwp_model::prelude::*;
use hwp_typeset::{block_pages, body_box, place_doc, ApproxFontMetrics, NaiveLayout, PlacedDoc};

fn open(rel: &str) -> SemanticDoc {
    let path = format!(
        "{}/../../corpus/hwpxlib_corpus/{rel}",
        env!("CARGO_MANIFEST_DIR")
    );
    parse_semantic(&std::fs::read(&path).expect(&path)).expect("parse")
}

fn top_level_tables(doc: &PlacedDoc, page: usize) -> Vec<(usize, f64, f64)> {
    doc.pages[page]
        .tables
        .iter()
        .filter(|t| t.ancestors.is_empty())
        .map(|t| (t.block, t.x, t.y))
        .collect()
}

/// The same document without its tables, their hosts left as ordinary paragraphs.
fn without_tables(doc: &SemanticDoc) -> SemanticDoc {
    let mut out = doc.clone();
    for sec in &mut out.sections {
        sec.blocks.retain(|b| matches!(b, Block::Paragraph(_)));
        for b in &mut sec.blocks {
            if let Block::Paragraph(p) = b {
                p.is_table_anchor = false;
            }
        }
    }
    out
}

/// Every (page, line top below the body top) of glyph `ch`.
fn glyph_spots(doc: &SemanticDoc, placed: &PlacedDoc, ch: char) -> Vec<(usize, f64)> {
    let (_, mt, _, _) = body_box(&doc.sections[0].page);
    placed
        .pages
        .iter()
        .enumerate()
        .flat_map(|(pi, pg)| {
            pg.glyphs
                .iter()
                .filter(move |g| g.ch == ch)
                .map(move |g| (pi, g.baseline - g.size * 0.85 - mt))
        })
        .collect()
}

/// 프로젝트 계획서: 글 앞 표 2개(1×1 · 14×9, 문단 0 · 4 가 품음) + 빈 문단 + 「완」(문단 73). 다른 프로그램의
/// PDF 는 2쪽이고 「완」 줄이 2쪽 본문 위끝에서 436pt 아래 — 표 둘이 흐름 높이를 전혀 쓰지 않을 때의 자리다.
/// 엔진은 4쪽이었다(표 둘을 흐름에 넣음).
///
/// 「완」 줄 자리는 표를 뺀 같은 문서(호스트는 보통 빈 문단)와 같다 — 표가 더하는 흐름은 0 이고 호스트 둘은
/// 보통 빈 줄을 쓴다. ⚠️ 그 자리(45,360)가 PDF(43,600)보다 한 줄쯤 아래인 것은 표가 아니라 문단 0 의 글 앞
/// **그림** 때문이다 — HWPX 파서가 그림의 배치를 읽지 않아 글자처럼 취급해 그 줄이 2,227 높이가 된다(#568).
#[test]
fn project_plan_front_tables_take_no_flow() {
    let doc = open("error/20250523/프로젝트 계획서.hwpx");
    let placed = place_doc(&doc, &ApproxFontMetrics);
    let naive = NaiveLayout.layout(&doc, &ApproxFontMetrics).unwrap();
    assert_eq!(placed.pages.len(), 2, "place_doc");
    assert_eq!(naive.pages.len(), 2, "NaiveLayout");
    // 「완」은 표 칸에 없다 — 표를 뺀 문서에서 하나뿐인 자리가 본문 줄의 자리다.
    let plain = without_tables(&doc);
    let wan = glyph_spots(&plain, &place_doc(&plain, &ApproxFontMetrics), '완');
    assert_eq!(wan.len(), 1, "{wan:?}");
    assert_eq!(wan[0].0, 1, "「완」은 2쪽");
    assert!(
        glyph_spots(&doc, &placed, '완').contains(&wan[0]),
        "표가 있어도 같은 자리: {wan:?}"
    );
    // 두 표는 1쪽 문단 0 · 4 의 자리에 그려진다. 14×9 표는 앵커 아래 들어가는 행까지 1쪽에, 나머지는 2쪽
    // 본문 맨 위에서 잇는다.
    let (_, mt, _, body_h) = body_box(&doc.sections[0].page);
    let pieces = |placed: &PlacedDoc| -> Vec<(usize, usize, usize, f64, f64)> {
        placed
            .pages
            .iter()
            .enumerate()
            .flat_map(|(pi, pg)| {
                pg.tables
                    .iter()
                    .filter(|t| t.ancestors.is_empty() && t.rows == 14)
                    .map(move |t| (pi, t.first_row, t.last_row, t.y, t.h))
            })
            .collect()
    };
    assert_eq!(top_level_tables(&placed, 0).len(), 2);
    let big = pieces(&placed);
    assert_eq!(big.len(), 2, "{big:?}");
    let (first, rest) = (big[0], big[1]);
    assert_eq!((first.0, first.1, rest.0, rest.2), (0, 0, 1, 14), "{big:?}");
    assert_eq!(rest.1, first.2, "{big:?}");
    assert!(
        first.3 + first.4 <= mt + body_h,
        "1쪽 조각은 본문 안: {big:?}"
    );
    assert_eq!(rest.3, mt, "2쪽 본문 맨 위");

    // 한글이 저장한 14×9 표의 `sz` 높이 66,284 는 행 0~9 의 합 = 앵커 아래 들어가는 행이다. 지금 엔진은 문단 0
    // 의 글 앞 그림을 HWPX 파서가 글자처럼 취급해(배치를 읽지 않음 — #568) 그 줄이 2,227 높이가 되고, 호스트
    // 문단 4 가 1,187 아래에 놓여 행 0~8 만 들어간다. 그림을 떠 있게 고친 사본에서는 저장 값 그대로다.
    let mut floated = doc.clone();
    for block in &mut floated.sections[0].blocks {
        if let Block::Paragraph(p) = block {
            for inline in p.runs.iter_mut().flat_map(|r| &mut r.content) {
                if let Inline::Image(image) = inline {
                    image.treat_as_char = false;
                }
            }
        }
    }
    let big = pieces(&place_doc(&floated, &ApproxFontMetrics));
    assert_eq!(
        big.iter().map(|p| (p.0, p.1, p.2, p.4)).collect::<Vec<_>>(),
        vec![(0, 0, 10, 66_284.0), (1, 10, 14, 49_437.0)]
    );
}

/// 재난안전: 표지 문단(호스트)이 글 앞 표(오프셋 22,694 · 높이 32,200)를 품고, 다음 문단은
/// `pageBreak="1"`. 한글 저장 줄: 호스트 줄 = 앞 줄 + 1,500 + 720 · 본문 폭, 다음 문단은 다음 쪽 0 — 표지에
/// 그려진 것이 떠 있는 개체뿐이어도 쪽 나누기가 실행된다. 표는 호스트 문단 위 + 오프셋 + 바깥 위 여백에.
#[test]
fn disaster_cover_front_table_sits_at_its_offset_and_the_break_still_runs() {
    let doc = open("error/20250808/2015년_12월_재난안전종합상황_분석_및_전망.hwpx");
    let sec = &doc.sections[0];
    let t_idx = sec
        .blocks
        .iter()
        .position(|b| matches!(b, Block::Table(t) if hwp_typeset::table_floats_over_text(t)))
        .expect("글 앞 표");
    let host = t_idx + 1; // HWPX 순서 [표, 호스트]
    assert!(matches!(&sec.blocks[host], Block::Paragraph(p) if p.is_table_anchor));
    let after_host = host + 1;
    assert!(matches!(&sec.blocks[after_host], Block::Paragraph(p) if p.page_break_before));
    let pages = block_pages(&doc, &ApproxFontMetrics);
    assert_eq!(pages[0][t_idx], 0, "표는 표지에");
    assert_eq!(pages[0][host], 0, "호스트 줄도 표지에");
    assert_eq!(pages[0][after_host], 1, "쪽 나누기 문단은 둘째 쪽 맨 위");
    let placed = place_doc(&doc, &ApproxFontMetrics);
    let host_band = placed.pages[0]
        .blocks
        .iter()
        .find(|b| b.block == host)
        .expect("호스트 줄의 띠");
    assert!(host_band.h > 0.0, "호스트는 줄을 쓴다");
    let Block::Table(t) = &sec.blocks[t_idx] else {
        unreachable!()
    };
    let drawn = top_level_tables(&placed, 0)
        .into_iter()
        .find(|(b, _, _)| *b == t_idx)
        .expect("표지에 그린 표");
    let want = host_band.y + 22_694.0 + t.outer_margin_top as f64;
    assert!(
        (drawn.2 - want).abs() < 1e-6,
        "표 위 {} · 기대 {want}",
        drawn.2
    );
}

/// #544 — 파서가 이제 떠 있는 표에 `float_placement` · `treat_as_char` 를 싣지만, 고치지 않은 저장은 구역 XML 을
/// 바이트 그대로 둔다(두 공개 문서).
#[test]
fn unedited_save_keeps_floating_tables_byte_for_byte() {
    for rel in [
        "error/20250523/프로젝트 계획서.hwpx",
        "error/20250808/2015년_12월_재난안전종합상황_분석_및_전망.hwpx",
    ] {
        let path = format!(
            "{}/../../corpus/hwpxlib_corpus/{rel}",
            env!("CARGO_MANIFEST_DIR")
        );
        let bytes = std::fs::read(&path).expect(&path);
        let doc = parse_semantic(&bytes).expect("parse");
        assert!(doc.sections[0]
            .blocks
            .iter()
            .any(|b| matches!(b, Block::Table(t) if t.float_placement.is_some())));
        let saved = hwp_hwpx::serialize::serialize(&doc).expect("serialize");
        let part = |zip: &[u8]| {
            hwp_hwpx::package::Package::open(zip)
                .unwrap()
                .read_part("Contents/section0.xml")
                .unwrap()
        };
        assert!(
            part(&saved) == part(&bytes),
            "{rel}: section0.xml 이 바뀌었다"
        );
    }
}

/// #544 리뷰 1 — 공개 두 문서의 떠 있는 표는 모두 보인다: 「보이지 않는 행」 알림이 없다.
#[test]
fn public_floating_tables_have_no_unseen_rows() {
    for rel in [
        "error/20250523/프로젝트 계획서.hwpx",
        "error/20250808/2015년_12월_재난안전종합상황_분석_및_전망.hwpx",
    ] {
        let placed = place_doc(&open(rel), &ApproxFontMetrics);
        let reports: Vec<_> = placed
            .pages
            .iter()
            .flat_map(|pg| &pg.undrawn_shapes)
            .filter(|u| u.reason == hwp_typeset::UndrawnShape::FloatingTableRows)
            .collect();
        assert!(reports.is_empty(), "{rel}: {reports:?}");
    }
}
