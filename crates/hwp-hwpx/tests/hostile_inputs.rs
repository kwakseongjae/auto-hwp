//! Hostile-input hardening tests (issue #014, R4).
//!
//! Every case proves the two properties the issue requires: a **fast, explicit, typed error**
//! (never a panic / OOM / hang). Fixtures are generated in-memory (deterministic, no large blobs
//! committed to the repo — the generators below ARE the "generation script"; see
//! `tests/fixtures/hostile/README.md`). Each test bounds its wall time so a regression that
//! reintroduced a hang would fail loudly.
//!
//! The five hostile shapes from the issue:
//!   1. zip bomb (single high-ratio deflate entry)          → `DocLimit::DecompressedTooLarge`
//!   2. depth-100 nested-table HWPX                          → `DocLimit::TableNestingTooDeep`
//!   3. 100k-entry zip                                       → `DocLimit::TooManyEntries`
//!   4. truncated file                                       → `HardenedError::Malformed` (fast)
//!   5. corrupt CFB header (fed to the HWPX opener)          → `HardenedError::Malformed` (fast)
//!
//! (The HWP5/rhwp `catch_unwind` boundary is proven separately in `crates/hwp-rhwp/tests`.)

use std::io::{Cursor, Write};
use std::time::{Duration, Instant};

use hwp_hwpx::package::Package;
use hwp_hwpx::parse::parse_semantic_guarded;
use hwp_ingest::limits::{self, DocLimit, HardenedError};
use zip::write::SimpleFileOptions;
use zip::CompressionMethod;

const MIMETYPE: &[u8] = b"application/hwp+zip";

/// Build a minimal HWPX zip: a STORED `mimetype` + the given `(name, deflated-bytes)` parts.
fn hwpx_with_parts(parts: &[(&str, &[u8])]) -> Vec<u8> {
    let mut w = zip::ZipWriter::new(Cursor::new(Vec::new()));
    w.start_file(
        "mimetype",
        SimpleFileOptions::default().compression_method(CompressionMethod::Stored),
    )
    .unwrap();
    w.write_all(MIMETYPE).unwrap();
    for (name, data) in parts {
        w.start_file(
            *name,
            SimpleFileOptions::default().compression_method(CompressionMethod::Deflated),
        )
        .unwrap();
        w.write_all(data).unwrap();
    }
    w.finish().unwrap().into_inner()
}

/// Time a closure and assert it returned within `max`.
fn timed<T>(label: &str, max: Duration, f: impl FnOnce() -> T) -> T {
    let t0 = Instant::now();
    let out = f();
    let dt = t0.elapsed();
    assert!(
        dt <= max,
        "{label}: took {dt:?}, expected <= {max:?} (must not hang)"
    );
    out
}

// 1) ZIP BOMB — a single deflate entry that inflates past MAX_DECOMPRESSED_TOTAL. The stream is
//    written incrementally so building the fixture is cheap (compressed output ~tens of KB); the
//    guarded reader stops at the cap (bounded ~256 MiB peak) instead of exhausting memory.
#[test]
fn zip_bomb_single_entry_is_rejected_by_decompressed_cap() {
    // Build the bomb: section0.xml is a deflated run of zeros just over the 256 MiB cap.
    let over = limits::MAX_DECOMPRESSED_TOTAL + (1 << 20); // cap + 1 MiB
    let mut w = zip::ZipWriter::new(Cursor::new(Vec::new()));
    w.start_file(
        "mimetype",
        SimpleFileOptions::default().compression_method(CompressionMethod::Stored),
    )
    .unwrap();
    w.write_all(MIMETYPE).unwrap();
    w.start_file(
        "Contents/section0.xml",
        SimpleFileOptions::default().compression_method(CompressionMethod::Deflated),
    )
    .unwrap();
    let chunk = vec![0u8; 1 << 20]; // 1 MiB of zeros; deflate collapses it to ~1 KB
    let mut written = 0u64;
    while written < over {
        w.write_all(&chunk).unwrap();
        written += chunk.len() as u64;
    }
    let bytes = w.finish().unwrap().into_inner();
    // The compressed bomb is small enough to be a "small artifact".
    assert!(
        bytes.len() < 5 * 1024 * 1024,
        "bomb compresses small: {} bytes",
        bytes.len()
    );

    // Inflating ~256 MiB of zeros is the intended bounded cost; allow generous headroom but still
    // bound it (a true hang would blow past this).
    let err = timed("zip_bomb", Duration::from_secs(20), || {
        parse_semantic_guarded(&bytes)
    })
    .expect_err("zip bomb must be rejected");
    assert_eq!(
        err,
        HardenedError::Limit(DocLimit::DecompressedTooLarge {
            limit: limits::MAX_DECOMPRESSED_TOTAL
        }),
        "zip bomb → typed DecompressedTooLarge"
    );
}

// 2) DEPTH-100 NESTED TABLE — the table-nesting depth counter fires long before depth 100.
#[test]
fn deeply_nested_table_is_rejected_by_nesting_cap() {
    let mut xml = String::from(r#"<hs:sec xmlns:hs="s" xmlns:hp="p"><hp:p><hp:run>"#);
    for _ in 0..100 {
        xml.push_str(r#"<hp:tbl rowCnt="1" colCnt="1"><hp:tr><hp:tc><hp:subList><hp:p><hp:run>"#);
    }
    xml.push_str("deep");
    for _ in 0..100 {
        xml.push_str("</hp:run></hp:p></hp:subList></hp:tc></hp:tr></hp:tbl>");
    }
    xml.push_str("</hp:run></hp:p></hs:sec>");
    let bytes = hwpx_with_parts(&[("Contents/section0.xml", xml.as_bytes())]);

    let err = timed("nested_table", Duration::from_secs(1), || {
        parse_semantic_guarded(&bytes)
    })
    .expect_err("depth-100 table must be rejected");
    match err {
        HardenedError::Limit(DocLimit::TableNestingTooDeep { limit, .. }) => {
            assert_eq!(limit, limits::MAX_TABLE_NESTING);
        }
        other => panic!("expected TableNestingTooDeep, got {other:?}"),
    }
}

// 3) 100k-ENTRY ZIP — rejected by the entry-count cap right after the central directory is read.
#[test]
fn hundred_thousand_entries_is_rejected_by_entry_cap() {
    let mut w = zip::ZipWriter::new(Cursor::new(Vec::new()));
    w.start_file(
        "mimetype",
        SimpleFileOptions::default().compression_method(CompressionMethod::Stored),
    )
    .unwrap();
    w.write_all(MIMETYPE).unwrap();
    let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    for i in 0..100_000u32 {
        w.start_file(format!("e/{i}"), opts).unwrap();
    }
    let bytes = w.finish().unwrap().into_inner();

    // Time ONLY the guarded open (fixture construction is setup, not the property under test).
    let err = timed("entry_count", Duration::from_secs(2), || {
        Package::open_guarded(&bytes)
    })
    .err()
    .expect("100k entries must be rejected");
    match err {
        HardenedError::Limit(DocLimit::TooManyEntries { count, limit }) => {
            assert!(count > limit && limit == limits::MAX_ENTRY_COUNT);
        }
        other => panic!("expected TooManyEntries, got {other:?}"),
    }
}

// 4) TRUNCATED FILE — a valid HWPX cut in half; the zip layer rejects it fast (not a limit).
#[test]
fn truncated_file_is_rejected_fast() {
    let full = hwpx_with_parts(&[("Contents/section0.xml", b"<hs:sec/>")]);
    let truncated = &full[..full.len() / 2];
    let err = timed("truncated", Duration::from_secs(1), || {
        parse_semantic_guarded(truncated)
    })
    .expect_err("truncated archive must be rejected");
    assert!(
        matches!(err, HardenedError::Malformed(_)),
        "truncated → Malformed, got {err:?}"
    );
}

// 5) CORRUPT CFB HEADER — an OLE/CFB (HWP5) magic + garbage, fed to the HWPX opener: it is not a
//    zip, so the opener rejects it fast and explicitly (no panic). The rhwp path's own panic guard
//    is covered in crates/hwp-rhwp/tests.
#[test]
fn corrupt_cfb_header_is_rejected_fast_by_hwpx_opener() {
    let mut bytes = vec![0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
    bytes.extend_from_slice(&[0xFFu8; 256]); // garbage body
    let err = timed("corrupt_cfb", Duration::from_secs(1), || {
        parse_semantic_guarded(&bytes)
    })
    .expect_err("a CFB fed to the HWPX opener must be rejected");
    assert!(
        matches!(err, HardenedError::Malformed(_)),
        "corrupt CFB → Malformed, got {err:?}"
    );
}

// RAW-SIZE cap: an over-64-MiB input is rejected before any parse work (cheap, upfront).
#[test]
fn oversize_raw_file_is_rejected_upfront() {
    // We don't allocate 64 MiB of real data: build a tiny valid zip then assert the predicate on a
    // synthetic length via open_guarded on a >cap buffer of zeros (not a valid zip, but the raw-size
    // check runs FIRST, before ZipArchive::new).
    let huge = vec![0u8; (limits::MAX_RAW_FILE as usize) + 1];
    let err = timed("raw_size", Duration::from_secs(1), || {
        Package::open_guarded(&huge)
    })
    .err()
    .expect("oversize raw must be rejected");
    match err {
        HardenedError::Limit(DocLimit::RawFileTooLarge { size, limit }) => {
            assert_eq!(limit, limits::MAX_RAW_FILE);
            assert_eq!(size, limits::MAX_RAW_FILE + 1);
        }
        other => panic!("expected RawFileTooLarge, got {other:?}"),
    }
}

// POSITIVE CONTROL: a normal corpus HWPX still parses cleanly through the guarded path — the guard
// must not reject legitimate documents (the other half of the issue).
#[test]
fn normal_corpus_hwpx_still_parses_through_guarded_path() {
    let root = concat!(env!("CARGO_MANIFEST_DIR"), "/../..");
    for rel in [
        "benchmarks/benchmark1.hwpx",
        "corpus/hwpx/FormattingShowcase.hwpx",
        "corpus/hwpx/footnote-01.hwpx",
        "corpus/hwpx/form-01.hwpx",
    ] {
        let path = format!("{root}/{rel}");
        let bytes = std::fs::read(&path).unwrap_or_else(|_| panic!("read {rel}"));
        let doc = parse_semantic_guarded(&bytes)
            .unwrap_or_else(|e| panic!("{rel} must parse through the guarded path: {e:?}"));
        assert!(!doc.sections.is_empty(), "{rel} has sections");
        // And the layout guard passes for a normal document.
        limits::check_layout_limits(&doc)
            .unwrap_or_else(|e| panic!("{rel} must pass the layout guard: {e:?}"));
    }
}
