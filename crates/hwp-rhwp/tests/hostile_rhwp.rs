//! HWP5 (rhwp) boundary hardening (issue #014, R4 — step 3).
//!
//! The vendored `external/rhwp` parser must not be modified, so the ONLY defense against it
//! panicking / hanging / OOMing on hostile CFB input is our `std::panic::catch_unwind` boundary +
//! the raw-size cap in front of it. These tests feed corrupt / truncated / oversize CFB to the
//! hardened entry point and assert a **fast, explicit, typed error** — and, crucially, that the
//! test process itself survives (a panic escaping the boundary would abort the test binary).
//!
//! Requires `--features rhwp` (the vendored parser is only compiled then). Without the feature the
//! guarded entry point is inert, so the meaningful assertions are gated below.

#![cfg(feature = "rhwp")]

use std::time::{Duration, Instant};

use hwp_ingest::limits::{self, DocLimit, HardenedError};
use hwp_rhwp::parse_to_semantic_guarded;

const CFB_MAGIC: [u8; 8] = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];

fn timed<T>(label: &str, max: Duration, f: impl FnOnce() -> T) -> T {
    let t0 = Instant::now();
    let out = f();
    let dt = t0.elapsed();
    assert!(dt <= max, "{label}: took {dt:?}, expected <= {max:?} (must not hang)");
    out
}

/// A CFB magic followed by garbage: rhwp must not take the process down — the boundary converts any
/// panic to `DocLimit::Panicked`, and a clean rejection to `Malformed`. Either is acceptable; the
/// point is a typed error and a surviving process.
#[test]
fn corrupt_cfb_is_caught_not_crashing() {
    let mut bytes = CFB_MAGIC.to_vec();
    bytes.extend_from_slice(&[0xABu8; 1024]);
    let err = timed("corrupt_cfb", Duration::from_secs(5), || parse_to_semantic_guarded(&bytes))
        .expect_err("corrupt CFB must be rejected, not parsed");
    assert!(
        matches!(err, HardenedError::Limit(DocLimit::Panicked) | HardenedError::Malformed(_)),
        "corrupt CFB → Panicked or Malformed, got {err:?}"
    );
}

/// Truncated valid HWP5: a real file cut to a few hundred bytes. Same guarantee.
#[test]
fn truncated_hwp5_is_caught_not_crashing() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../benchmark.hwp");
    let full = std::fs::read(path).expect("benchmark.hwp at repo root");
    let truncated = &full[..full.len().min(300)];
    let err =
        timed("truncated_hwp5", Duration::from_secs(5), || parse_to_semantic_guarded(truncated))
            .expect_err("truncated HWP5 must be rejected");
    assert!(
        matches!(err, HardenedError::Limit(DocLimit::Panicked) | HardenedError::Malformed(_)),
        "truncated HWP5 → Panicked or Malformed, got {err:?}"
    );
}

/// The raw-size cap runs BEFORE rhwp is invoked at all.
#[test]
fn oversize_raw_is_rejected_before_rhwp() {
    let huge = vec![0u8; (limits::MAX_RAW_FILE as usize) + 1];
    let err = timed("oversize", Duration::from_secs(1), || parse_to_semantic_guarded(&huge))
        .expect_err("oversize raw must be rejected");
    assert!(
        matches!(err, HardenedError::Limit(DocLimit::RawFileTooLarge { .. })),
        "oversize → RawFileTooLarge, got {err:?}"
    );
}

/// POSITIVE CONTROL: a real .hwp still parses cleanly through the guarded boundary (the guard must
/// not reject legitimate input) and passes the layout guard.
#[test]
fn valid_hwp5_still_parses_through_guarded_boundary() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../benchmark.hwp");
    let bytes = std::fs::read(path).expect("benchmark.hwp");
    let doc = parse_to_semantic_guarded(&bytes).expect("benchmark.hwp parses through the boundary");
    assert!(!doc.sections.is_empty(), "benchmark.hwp has sections");
    limits::check_layout_limits(&doc).expect("benchmark.hwp passes the layout guard");
}
