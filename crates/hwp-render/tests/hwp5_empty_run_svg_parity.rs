use hwp_core::{normalize_hwp5_empty_runs_for_layout_evidence, open_hwp5_own, Engine};
use hwp_render::render_doc_svg;
use hwp_typeset::ApproxFontMetrics;

#[test]
fn empty_run_evidence_normalization_is_svg_exact() {
    let bytes = std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../benchmarks/benchmark.hwp"
    ))
    .unwrap();
    let candidate = open_hwp5_own(&bytes).unwrap();
    let production = Engine::open(&bytes).unwrap();
    let mut normalized = candidate.clone();
    normalize_hwp5_empty_runs_for_layout_evidence(&mut normalized);

    let candidate_svg = render_doc_svg(&candidate, &ApproxFontMetrics);
    let normalized_svg = render_doc_svg(&normalized, &ApproxFontMetrics);
    let production_svg = render_doc_svg(&production, &ApproxFontMetrics);
    assert!(
        candidate_svg == normalized_svg,
        "empty-run normalization must be SVG-exact without printing source content"
    );
    assert!(
        candidate_svg == production_svg,
        "production SVG must retain the strictly owned page-number decoration"
    );
}
