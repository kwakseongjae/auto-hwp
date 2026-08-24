#![cfg(feature = "pdf")]

use hwp_core::{normalize_hwp5_empty_runs_for_layout_evidence, open_hwp5_own};
use hwp_export::pdf::{export_pdf, PdfOptions};
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
