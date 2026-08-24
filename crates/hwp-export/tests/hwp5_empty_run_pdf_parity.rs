#![cfg(feature = "pdf")]

use hwp_core::{normalize_hwp5_empty_runs_for_layout_evidence, open_hwp5_own, Engine};
use hwp_export::pdf::{export_pdf, PdfOptions};
use hwp_render::{render_doc_diagnostic_masks, DiagnosticPaintCategory};
use hwp_typeset::ApproxFontMetrics;

#[test]
fn empty_run_evidence_normalization_is_pdf_exact() {
    let bytes = std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../benchmarks/benchmark.hwp"
    ))
    .unwrap();
    let candidate = open_hwp5_own(&bytes).unwrap();
    let mut normalized = candidate.clone();
    normalize_hwp5_empty_runs_for_layout_evidence(&mut normalized);

    let candidate_pdf = export_pdf(&candidate, &ApproxFontMetrics, &PdfOptions::default()).unwrap();
    let normalized_pdf =
        export_pdf(&normalized, &ApproxFontMetrics, &PdfOptions::default()).unwrap();
    assert!(
        candidate_pdf.bytes == normalized_pdf.bytes
            && candidate_pdf.pages == normalized_pdf.pages
            && candidate_pdf.replay == normalized_pdf.replay
            && candidate_pdf.diagnostics == normalized_pdf.diagnostics,
        "empty-run normalization must be PDF-byte-exact without printing source content"
    );
}

#[test]
fn page_decoration_mask_agrees_with_pdf_replay_counts() {
    let bytes = std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../benchmarks/benchmark.hwp"
    ))
    .unwrap();
    let candidate = open_hwp5_own(&bytes).unwrap();
    let oracle = Engine::open(&bytes).unwrap();
    let candidate_masks = render_doc_diagnostic_masks(&candidate, &ApproxFontMetrics);
    let oracle_masks = render_doc_diagnostic_masks(&oracle, &ApproxFontMetrics);
    let candidate_pdf = export_pdf(&candidate, &ApproxFontMetrics, &PdfOptions::default()).unwrap();
    let oracle_pdf = export_pdf(&oracle, &ApproxFontMetrics, &PdfOptions::default()).unwrap();

    assert_eq!(candidate_pdf.pages, 8);
    assert_eq!(candidate_pdf.pages, oracle_pdf.pages);
    for (((candidate_page, oracle_page), candidate_mask), oracle_mask) in candidate_pdf
        .replay
        .iter()
        .zip(&oracle_pdf.replay)
        .zip(&candidate_masks)
        .zip(&oracle_masks)
    {
        let candidate_decoration = candidate_mask
            .categories
            .iter()
            .filter(|category| **category == DiagnosticPaintCategory::PageDecoration)
            .count();
        let oracle_decoration = oracle_mask
            .categories
            .iter()
            .filter(|category| **category == DiagnosticPaintCategory::PageDecoration)
            .count();
        assert_eq!(candidate_decoration, oracle_decoration + 3);
        assert_eq!(candidate_page.text.produced, oracle_page.text.produced + 3);
        assert_eq!(candidate_page.text.replayed, oracle_page.text.replayed + 3);
        assert_eq!(candidate_page.text.stubbed, oracle_page.text.stubbed);
        assert_eq!(candidate_page.table_geometry, oracle_page.table_geometry);
        assert_eq!(candidate_page.image, oracle_page.image);
        assert_eq!(candidate_page.equation, oracle_page.equation);
        assert_eq!(candidate_page.chart, oracle_page.chart);
    }
}
