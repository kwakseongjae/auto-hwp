//! Benchmark fidelity gate against the user-provided `benchmark.hwp` (+ ground-truth `benchmark.pdf`).
//!
//! - `benchmark_present_and_hwp5` runs in CI (format gate); it SKIPS gracefully when the fixture
//!   is absent so CI without the user-provided document stays green.
//! - `benchmark_engine_has_no_unexpected_divergence` is the real M1 gate: `#[ignore]` because it
//!   needs the engine render (`--features rhwp`) plus a reference (the ground-truth PDF, or the
//!   H2Orestart oracle). Run it explicitly with
//!   `cargo test -p hwp-fidelity --features rhwp -- --ignored`.
//!
//! The allowlist LOGIC itself is unit-tested in `src/lib.rs` (no prerequisites), so the fidelity
//! contract is enforced in CI even on machines where the render cannot run.

use hwp_fidelity::{benchmark_allowlist, benchmark_path, reference_pdf_for, unexpected_divergences, FidelityBand, Prerequisites};

#[test]
fn benchmark_present_and_hwp5() {
    let path = benchmark_path();
    if !path.exists() {
        eprintln!(
            "skip: benchmark.hwp not present at {} (user-provided fidelity fixture)",
            path.display()
        );
        return;
    }
    let bytes = std::fs::read(&path).expect("read benchmark.hwp");
    assert_eq!(
        hwp_core::Engine::detect(&bytes),
        hwp_model::types::SourceFormat::Hwp5,
        "benchmark.hwp should be detected as HWP5 binary"
    );
}

/// The production "원본 그대로" fidelity gate. Our engine render must have NO unexpected divergence
/// from the reference: against the ground-truth `benchmark.pdf` this is ABSOLUTE all-pages-Red-0;
/// against the LibreOffice+H2Orestart oracle the documented pagination divergence is allowlisted
/// while every aligned page must still match.
#[test]
#[ignore = "needs engine render (--features rhwp) + a reference (ground-truth benchmark.pdf, or H2Orestart+JDK oracle)"]
fn benchmark_engine_has_no_unexpected_divergence() {
    let path = benchmark_path();
    if !path.exists() {
        eprintln!("skip: benchmark.hwp not present at {}", path.display());
        return;
    }

    // `compare()` prefers the ground-truth PDF (needs only the engine render); otherwise it needs
    // the oracle. Running this gate requires the engine render either way.
    let pre = Prerequisites::detect();
    let has_ground_truth = reference_pdf_for(&path).is_some();
    assert!(
        pre.engine_render,
        "build with --features rhwp to run the fidelity gate ({pre:?})"
    );
    assert!(
        has_ground_truth || pre.can_reference(),
        "no ground-truth benchmark.pdf and oracle unavailable: {pre:?}"
    );

    let report = hwp_fidelity::compare(&path).expect("fidelity compare");
    assert!(report.our_pages > 0, "expected at least one rendered page");

    // Diagnostics: the per-page verdict (visible with `--nocapture`).
    eprintln!(
        "fidelity: reference={:?} ours={} ref={}",
        report.reference, report.our_pages, report.ref_pages
    );
    for p in &report.pages {
        eprintln!("  page {:>2}: {:?} ({:?})", p.index + 1, p.band, p.similarity);
    }

    let unexpected = unexpected_divergences(&report, benchmark_allowlist());
    assert!(
        unexpected.is_empty(),
        "fidelity regression vs {:?} reference: {unexpected:#?}",
        report.reference
    );

    // Belt-and-suspenders: with a ground-truth reference the gate is absolute — exact page count
    // and zero Red pages (no allowlist entry applies to ground truth).
    if has_ground_truth {
        assert_eq!(report.our_pages, report.ref_pages, "ground-truth page count must match exactly");
        assert!(
            report.pages.iter().all(|p| p.band != FidelityBand::Red),
            "ground-truth fidelity requires all pages Red 0"
        );
    }
}
