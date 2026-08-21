//! Issue 82: `.hwp` lift must not emit extra body paragraphs for Picture controls.
//!
//! HWPX Overlay isolated drawText/caption subLists. The twin leak on the lift path is
//! different: `object_paragraph` after a Picture control. Captions stay nested on the rhwp
//! Picture (not flattened). Memo/header/footer/note were already not leaking.
#![cfg(feature = "rhwp")]

use hwp_model::prelude::*;
use rhwp::model::control::Control;

fn repo_file(rel: &str) -> Vec<u8> {
    let path = format!("{}/../../{rel}", env!("CARGO_MANIFEST_DIR"));
    std::fs::read(&path).unwrap_or_else(|e| panic!("read {path}: {e}"))
}

fn body_para_count(blocks: &[Block]) -> usize {
    blocks
        .iter()
        .filter(|b| matches!(b, Block::Paragraph(_)))
        .count()
}

fn body_images(blocks: &[Block]) -> usize {
    blocks
        .iter()
        .filter_map(|b| match b {
            Block::Paragraph(p) => Some(p),
            _ => None,
        })
        .flat_map(|p| &p.runs)
        .flat_map(|r| &r.content)
        .filter(|i| matches!(i, Inline::Image(_)))
        .count()
}

#[test]
fn issue_265_picture_controls_do_not_add_extra_body_paragraphs() {
    let bytes = repo_file("corpus/hwp/issue_265.hwp");
    let rdoc = rhwp::parse_document(&bytes).expect("rhwp parse");
    let our = hwp_rhwp::parse_to_semantic_guarded(&bytes).expect("lift");

    let rhwp_body: usize = rdoc.sections.iter().map(|s| s.paragraphs.len()).sum();
    let our_body: usize = our
        .sections
        .iter()
        .map(|s| body_para_count(&s.blocks))
        .sum();
    let images: usize = our.sections.iter().map(|s| body_images(&s.blocks)).sum();

    let rhwp_pictures: usize = rdoc
        .sections
        .iter()
        .flat_map(|s| &s.paragraphs)
        .flat_map(|p| &p.controls)
        .filter(|c| matches!(c, Control::Picture(_)))
        .count();
    let rhwp_caption_paras: usize = rdoc
        .sections
        .iter()
        .flat_map(|s| &s.paragraphs)
        .flat_map(|p| &p.controls)
        .filter_map(|c| match c {
            Control::Picture(pic) => Some(
                pic.caption
                    .as_ref()
                    .map(|cap| cap.paragraphs.len())
                    .unwrap_or(0),
            ),
            Control::Table(t) => Some(
                t.caption
                    .as_ref()
                    .map(|cap| cap.paragraphs.len())
                    .unwrap_or(0),
            ),
            _ => None,
        })
        .sum();

    assert_eq!(
        our_body, rhwp_body,
        "lift body paragraphs must zip 1:1 with rhwp (was +4 picture object paras)"
    );
    assert_eq!(
        images, rhwp_pictures,
        "each body Picture control must still lift to an Inline::Image"
    );
    assert!(
        rhwp_caption_paras > 0,
        "fixture must keep nested picture captions so we do not flatten them by accident"
    );
    assert_eq!(
        our_body, rhwp_body,
        "nested captions ({rhwp_caption_paras}) must not appear as extra body paragraphs"
    );

    #[cfg(feature = "shaper")]
    let fonts = hwp_typeset::RealFontMetrics::new();
    #[cfg(not(feature = "shaper"))]
    let fonts = hwp_typeset::ApproxFontMetrics;
    let naive = hwp_typeset::NaiveLayout
        .layout(&our, &fonts)
        .expect("NaiveLayout")
        .pages
        .len();
    let placed = hwp_typeset::place_doc(&our, &fonts).pages.len();
    assert_eq!(
        naive, placed,
        "LOCKSTEP: NaiveLayout {naive} != place_doc {placed}"
    );
}
