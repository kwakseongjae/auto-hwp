# Hostile HWPX fixtures (issue #014 — input hardening / R4)

These fixtures deliberately exercise the parser DoS defenses. Per the issue, the repo keeps the
**generators** (small) rather than large adversarial blobs.

## Where the generators live

The fixtures are generated **in-memory** by the integration test
[`crates/hwp-hwpx/tests/hostile_inputs.rs`](../../hostile_inputs.rs). That file IS the generation
script — each `#[test]` builds one hostile shape deterministically and asserts a fast, typed error:

| shape | generator fn | expected error |
|-------|--------------|----------------|
| zip bomb (single high-ratio deflate entry) | `zip_bomb_single_entry_is_rejected_by_decompressed_cap` | `DocLimit::DecompressedTooLarge` |
| depth-100 nested table | `deeply_nested_table_is_rejected_by_nesting_cap` | `DocLimit::TableNestingTooDeep` |
| 100 000-entry zip | `hundred_thousand_entries_is_rejected_by_entry_cap` | `DocLimit::TooManyEntries` |
| truncated file | `truncated_file_is_rejected_fast` | `HardenedError::Malformed` |
| corrupt CFB header | `corrupt_cfb_header_is_rejected_fast_by_hwpx_opener` | `HardenedError::Malformed` |
| oversize raw (>64 MiB) | `oversize_raw_file_is_rejected_upfront` | `DocLimit::RawFileTooLarge` |

The HWP5/rhwp side (corrupt/truncated CFB fed to the vendored parser, guarded by
`std::panic::catch_unwind`) is covered by `crates/hwp-rhwp/tests/hostile_rhwp.rs`.

Run: `cargo test -p hwp-hwpx --test hostile_inputs`

Building large blobs in-memory (and not committing them) keeps the repo small while still testing
the real limit constants defined in `crates/hwp-ingest/src/limits.rs`.

## Fuzzing (scaffold — not run in CI; issue #014 step 6)

The single natural fuzz target is **HWPX open**: feed arbitrary bytes to the hardened entry point
and assert it never panics / hangs (it must always return `Ok` or a typed error). A `cargo-fuzz`
target would be:

```rust
// fuzz/fuzz_targets/hwpx_open.rs
#![no_main]
use libfuzzer_sys::fuzz_target;
fuzz_target!(|data: &[u8]| {
    // Must terminate quickly with Ok or a typed HardenedError — never panic / OOM / hang.
    let _ = hwp_hwpx::parse::parse_semantic_guarded(data);
});
```

Run (nightly + cargo-fuzz installed):

```bash
cargo +nightly fuzz run hwpx_open
```

CI-continuous fuzzing is out of scope for #014 (documentation only). The `fuzz/` crate is
intentionally NOT added to the workspace to keep default `cargo build`/`test` nightly-free.
