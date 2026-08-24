use hwp_core::{open_hwp5_own, Engine};
use hwp_model::layout::PageLayerTree;
use hwp_render::{render_doc_diagnostic_masks, render_doc_trees, DiagnosticPaintCategory, SvgSink};
use hwp_typeset::ApproxFontMetrics;

fn fixture() -> Vec<u8> {
    std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../benchmarks/benchmark.hwp"
    ))
    .unwrap()
}

fn masked_svg(tree: &PageLayerTree, categories: &[DiagnosticPaintCategory]) -> String {
    assert_eq!(tree.ops.len(), categories.len());
    let body = PageLayerTree {
        schema_version: tree.schema_version,
        width: tree.width,
        height: tree.height,
        ops: tree
            .ops
            .iter()
            .zip(categories)
            .filter(|(_, category)| **category == DiagnosticPaintCategory::Body)
            .map(|(op, _)| op.clone())
            .collect(),
    };
    SvgSink::svg_for(&body)
}

#[test]
fn benchmark_masks_prove_page_number_ownership_and_isolate_body_pages() {
    let bytes = fixture();
    let candidate = open_hwp5_own(&bytes).unwrap();
    let production = Engine::open(&bytes).unwrap();
    let candidate_masks = render_doc_diagnostic_masks(&candidate, &ApproxFontMetrics);
    let production_masks = render_doc_diagnostic_masks(&production, &ApproxFontMetrics);
    assert_eq!(candidate_masks.len(), 8);
    assert_eq!(candidate_masks.len(), production_masks.len());

    for (candidate_mask, production_mask) in candidate_masks.iter().zip(&production_masks) {
        let candidate_decoration = candidate_mask
            .categories
            .iter()
            .filter(|category| **category == DiagnosticPaintCategory::PageDecoration)
            .count();
        let production_decoration = production_mask
            .categories
            .iter()
            .filter(|category| **category == DiagnosticPaintCategory::PageDecoration)
            .count();
        assert_eq!(candidate_decoration, production_decoration);
        assert!(!candidate_mask
            .categories
            .contains(&DiagnosticPaintCategory::BoundaryCrossing));
        assert!(!production_mask
            .categories
            .contains(&DiagnosticPaintCategory::BoundaryCrossing));
    }

    let mut without_page_number = candidate.clone();
    for section in &mut without_page_number.sections {
        section.page_number = None;
    }
    let candidate_trees = render_doc_trees(&candidate, &ApproxFontMetrics);
    let without_trees = render_doc_trees(&without_page_number, &ApproxFontMetrics);
    let without_masks = render_doc_diagnostic_masks(&without_page_number, &ApproxFontMetrics);
    for (((candidate_tree, candidate_mask), without_tree), without_mask) in candidate_trees
        .iter()
        .zip(&candidate_masks)
        .zip(&without_trees)
        .zip(&without_masks)
    {
        assert_eq!(
            masked_svg(candidate_tree, &candidate_mask.categories),
            masked_svg(without_tree, &without_mask.categories),
            "removing page-number decoration must leave the body SVG exact"
        );
    }

    let production_trees = render_doc_trees(&production, &ApproxFontMetrics);
    let differing_body_pages: Vec<_> = candidate_trees
        .iter()
        .zip(&candidate_masks)
        .zip(&production_trees)
        .zip(&production_masks)
        .enumerate()
        .filter_map(
            |(page, (((candidate_tree, candidate_mask), production_tree), production_mask))| {
                (masked_svg(candidate_tree, &candidate_mask.categories)
                    != masked_svg(production_tree, &production_mask.categories))
                .then_some(page)
            },
        )
        .collect();
    assert!(
        differing_body_pages.is_empty(),
        "all production body SVG pages remain exact after page-number enrichment"
    );
}
