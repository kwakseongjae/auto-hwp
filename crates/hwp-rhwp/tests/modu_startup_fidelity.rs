#![cfg(feature = "rhwp")]

use hwp_model::document::{Block, Table};
use hwp_typeset::{place_doc, ApproxFontMetrics};
use std::path::PathBuf;

/// 실물 한글 양식(모두의창업)은 공개 레포에 재배포하지 않는다 — `corpus/private/`(gitignore)에만 둔다.
/// 파일이 없는 환경(fresh clone / CI)에서도 컴파일·테스트가 깨지지 않도록 `include_bytes!`(컴파일타임)
/// 대신 런타임 fs 읽기를 쓰고, 부재 시 점수를 꾸며내지 않고 missing-oracle로 정직하게 skip한다(068 규율).
const BENCH_REL: &str = "corpus/private/modu-startup/modu-startup.hwp";

fn bench_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join(BENCH_REL)
}

fn image_fill_count(table: &Table) -> usize {
    table
        .cells
        .iter()
        .map(|cell| {
            usize::from(cell.fill_image.is_some())
                + cell
                    .blocks
                    .iter()
                    .map(|block| match block {
                        Block::Paragraph(_) => 0,
                        Block::Table(nested) => image_fill_count(nested),
                    })
                    .sum::<usize>()
        })
        .sum()
}

#[test]
fn real_title_form_keeps_image_bands_and_source_vertical_rhythm() {
    let path = bench_path();
    let Ok(bytes) = std::fs::read(&path) else {
        eprintln!(
            "⚠️  missing-oracle: {BENCH_REL} 부재 — 로컬 전용 실물 벤치라 skip합니다.\n\
             (실물 한글 양식은 공개 커밋 금지 — corpus/private/에만 두며 git 미추적. \
             찾은 경로: {})",
            path.display()
        );
        return;
    };
    let doc = hwp_rhwp::parse_to_semantic_guarded(&bytes).expect("parse real startup form");

    assert_eq!(
        doc.bin_data.len(),
        2,
        "both decorative band rasters are embedded"
    );
    let lifted_fills: usize = doc
        .sections
        .iter()
        .flat_map(|section| &section.blocks)
        .map(|block| match block {
            Block::Paragraph(_) => 0,
            Block::Table(table) => image_fill_count(table),
        })
        .sum();
    assert_eq!(
        lifted_fills, 2,
        "both borderFill image brushes survive the lift"
    );

    let placed = place_doc(&doc, &ApproxFontMetrics);
    assert_eq!(placed.pages.len(), 6);
    let title_page = &placed.pages[1];
    let mut bands: Vec<_> = title_page
        .images
        .iter()
        .filter(|image| image.is_background)
        .collect();
    bands.sort_by(|a, b| a.y.total_cmp(&b.y));
    assert_eq!(bands.len(), 2);
    assert!(
        (23_000.0..25_000.0).contains(&bands[0].y),
        "stored empty-line metrics keep the title table at its Hancom y; got {}",
        bands[0].y
    );
    assert!(bands.iter().all(|band| band.w > 47_000.0 && band.h > 400.0));
}
