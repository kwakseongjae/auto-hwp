//! Benchmark fidelity tests against the user-provided `benchmark.hwp`.
//!
//! - `benchmark_is_hwp5` runs today (format gate).
//! - the rest are `#[ignore]` until their prerequisites land (H2Orestart, engine render),
//!   so CI stays green while the gate is wired. Run explicitly with `--ignored`.

use hwp_fidelity::{benchmark_path, FidelityBand, Prerequisites};

#[test]
fn benchmark_present_and_hwp5() {
    let path = benchmark_path();
    assert!(path.exists(), "benchmark.hwp must be at repo root: {}", path.display());
    let bytes = std::fs::read(&path).expect("read benchmark.hwp");
    assert_eq!(
        hwp_core::Engine::detect(&bytes),
        hwp_model::types::SourceFormat::Hwp5,
        "benchmark.hwp should be detected as HWP5 binary"
    );
}

/// Oracle reference render + cross-renderer fidelity compare. Kept as ONE test so the
/// two soffice invocations run sequentially (two soffice instances on one profile collide).
/// Run: `cargo test -p hwp-fidelity --features rhwp -- --ignored`.
#[test]
#[ignore = "needs engine render (--features rhwp) + oracle (H2Orestart + JDK)"]
fn benchmark_oracle_and_fidelity() {
    let pre = Prerequisites::detect();
    assert!(pre.can_reference(), "oracle prerequisites missing: {pre:?}");

    // 1) oracle reference render exists
    let out = std::env::temp_dir().join("tfhwp_fidelity_ref");
    let pdf = hwp_fidelity::reference_pdf(&benchmark_path(), &out).expect("reference render");
    assert!(pdf.exists(), "expected reference PDF at {}", pdf.display());

    // 2) cross-renderer compare
    assert!(pre.can_compare(), "compare prerequisites missing: {pre:?}");
    let report = hwp_fidelity::compare(&benchmark_path()).expect("fidelity compare");
    assert!(report.our_pages > 0, "expected at least one rendered page");
    // Content agreement: page 1 must not diverge (cross-renderer pixel agreement).
    // NOTE: overall may be RED from pagination differences (our page count vs LibreOffice) —
    // a known structural-divergence signal, not a per-page content failure.
    assert_ne!(
        report.pages[0].band,
        FidelityBand::Red,
        "page 1 diverges from the oracle render: {:?}",
        report.pages[0]
    );
}
