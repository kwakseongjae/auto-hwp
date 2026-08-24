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
    let production = Engine::open(&bytes).unwrap();
    let mut candidate_without_page_number = candidate.clone();
    for section in &mut candidate_without_page_number.sections {
        section.page_number = None;
    }
    let candidate_masks = render_doc_diagnostic_masks(&candidate, &ApproxFontMetrics);
    let production_masks = render_doc_diagnostic_masks(&production, &ApproxFontMetrics);
    let candidate_pdf = export_pdf(&candidate, &ApproxFontMetrics, &PdfOptions::default()).unwrap();
    let production_pdf =
        export_pdf(&production, &ApproxFontMetrics, &PdfOptions::default()).unwrap();
    let body_pdf = export_pdf(
        &candidate_without_page_number,
        &ApproxFontMetrics,
        &PdfOptions::default(),
    )
    .unwrap();

    assert_eq!(candidate_pdf.pages, 8);
    assert_eq!(candidate_pdf.pages, production_pdf.pages);
    for (((candidate_page, production_page), candidate_mask), production_mask) in candidate_pdf
        .replay
        .iter()
        .zip(&production_pdf.replay)
        .zip(&candidate_masks)
        .zip(&production_masks)
    {
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
        assert_eq!(candidate_page.text, production_page.text);
        assert_eq!(
            candidate_page.table_geometry,
            production_page.table_geometry
        );
        assert_eq!(candidate_page.image, production_page.image);
        assert_eq!(candidate_page.equation, production_page.equation);
        assert_eq!(candidate_page.chart, production_page.chart);
    }
    assert!(
        candidate_pdf.bytes == production_pdf.bytes
            && candidate_pdf.pages == production_pdf.pages
            && candidate_pdf.replay == production_pdf.replay
            && candidate_pdf.diagnostics == production_pdf.diagnostics,
        "production PDF must retain the strictly owned page-number decoration"
    );
    assert_ne!(body_pdf.bytes, production_pdf.bytes);
}
