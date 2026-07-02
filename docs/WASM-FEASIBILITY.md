# WASM feasibility — core crates on `wasm32-unknown-unknown` (issue 007, P0-A)

- Date: 2026-07-02
- Toolchain: repo `rust-toolchain.toml` (targets include `wasm32-unknown-unknown`, already installed)
- Method: `cargo check -p <crate> [--features …] --target wasm32-unknown-unknown` for all 11 combos in issue 007.
- Reproduce: `bash scripts/wasm-smoke.sh` (exits 0 when the whole pass set is green).

## Verdict: **A안 — all 11 combos compile to wasm32.**

Both feared long-poles compile:
- **rhwp (HWP5 binary parsing)** compiles to wasm — `external/rhwp` is *designed* for wasm
  (crate-type `[cdylib, rlib]`, wasm-bindgen deps, heavy native PDF/skia/resvg deps gated
  behind `cfg(not(target_arch = "wasm32"))`, and a separate `cfg(target_arch = "wasm32")`
  block for `js-sys`/`web-sys`/`web-time`/`console_error_panic_hook`).
- **krilla 0.8.2 (PDF export)** compiles to wasm — its closure is pure-Rust
  (skrifa / subsetter / write-fonts / read-fonts / tiny-skia-path / yoke / png / flate2 …),
  no `getrandom`, no `fontdb`, and `tiny-skia-path` (not full `tiny-skia`).

No `getrandom` in either the `hwp-export --features pdf` closure or the
`hwp-rhwp --features rhwp` closure (verified with `cargo tree -i getrandom … --target
wasm32-unknown-unknown` → "package ID specification `getrandom` did not match any packages").

This supersedes the R9 pessimistic framing ("HWP5 parsing wasm-unverified, worst case web
v1 = HWPX-only"). The web shell CAN open `.hwp` directly and CAN export PDF in-browser
— subject to the runtime font caveat below (a 015 concern, not a compile blocker).

## Per-combo results (11/11 ✅)

| # | Combo | Result | Notes / key deps in wasm closure |
|---|-------|--------|----------------------------------|
| 1 | `hwp-model` | ✅ | thiserror 2 only. |
| 2 | `hwp-ops` | ✅ | hwp-model only. |
| 3 | `hwp-typeset` (base) | ✅ | hwp-model only. |
| 4 | `hwp-typeset --features shaper` | ✅ | + rustybuzz 0.20.1, ttf-parser 0.25.1 (pure Rust). |
| 5 | `hwp-render` | ✅ | + base64 0.21.7. |
| 6 | `hwp-hwpx` | ✅ | quick-xml 0.37.5 + zip 2 (default-features off, `deflate` only) + flate2/miniz_oxide. `zip` did NOT re-enable time/crypto features. |
| 7 | `hwp-jsx` | ✅ | serde / serde_json 1. |
| 8 | `hwp-export` (base) | ✅ | pure (no krilla without `pdf`). |
| 9 | `hwp-export --features pdf` | ✅ | + krilla 0.8.2 closure (skrifa, subsetter, write-fonts, read-fonts, tiny-skia-path, yoke, png, flate2). No getrandom. |
| 10 | `hwp-ingest` | ✅ | hwp-model only (pure format detection OLE/CFB vs ZIP+OWPML). |
| 11 | `hwp-rhwp --features rhwp` | ✅ | + rhwp 0.7.15 → cfb 0.14 (uses `web-time` on wasm as an `Instant` shim), zip 8.6, flate2, png 0.18, image 0.25, blake3, moxcms, pcx, codepage, snafu, strum, uuid. wasm-only block: js-sys / web-sys / web-time / console_error_panic_hook. No getrandom. |

## `getrandom` trap — clear

`getrandom` needs a `wasm_js` feature to work on wasm and must NOT be in the core closure.
It is **absent** from both closures that could plausibly pull it (pdf/krilla and rhwp):

```
$ cargo tree -i getrandom -p hwp-export --features pdf --target wasm32-unknown-unknown
error: package ID specification `getrandom` did not match any packages
$ cargo tree -i getrandom -p hwp-rhwp   --features rhwp --target wasm32-unknown-unknown
error: package ID specification `getrandom` did not match any packages
```

`uuid` is in the rhwp closure but is compiled without its random (`v4`) feature, so it does
not drag in `getrandom`.

## Compile-pass ≠ runtime-safe: font-loading via `std::fs` (015, NOT a 007 blocker)

`wasm32-unknown-unknown` provides a *compile-time stub* for `std::fs`, so these compile
cleanly today but would **trap at runtime** on wasm (there is no filesystem):

- `crates/hwp-typeset/src/shaper.rs:88` — `std::fs::read(...)` for font loading (`shaper` feature).
- `crates/hwp-export/src/pdf.rs:89,100` — `std::fs::read(...)` for font loading (`pdf` feature).
- `crates/hwp-jsx/src/lib.rs:863` (`write_project_dir` / `read_project_dir` nearby) — real lib
  API using `std::fs`; compiles on wasm but is a no-op-at-best there.

Implication for 015: fonts must be **injected as bytes** (`register_font(bytes)`), not read
from a path — exactly the R8 "font injection, not bundling" design. This is a 015 runtime
concern, not a 007 compile blocker, so nothing is changed in these files here.

`cfb 0.14` already routes `std::time::Instant` through `web-time` on wasm, so the
"`Instant` runtime trap" hazard from the 015 pitfalls list does not apply to rhwp's CFB path.

## Architecture decision

- **A안 (all pass) — ADOPTED.** The web shell can open `.hwp` directly, and PDF export
  runs in-browser (krilla in wasm). Neither the B안 fallback (web v1 = HWPX-only, `.hwp`
  converted by the 013 service) nor the C안 fallback (PDF via service only) is required.
- Downstream (015): add `open_hwp` to the wasm binding surface (not only `open_hwpx`), keep
  `exportPdf` in-wasm, and design font loading as byte injection (never `std::fs`).

015's "전제" section has been updated to record this A verdict.

## Notes for 015 (do NOT act on these here — out of 007 scope)

- Font loading is the only known wasm runtime gap; solve via injection (`register_font`).
- Bundle size is unmeasured (needs the actual `wasm-pack` build in 015); krilla's font
  subsetting stack (skrifa/subsetter/write-fonts) is the likely heavyweight to watch with
  `twiggy`/`wasm-opt`.
- `cargo check` (no `--tests`) was used, matching the issue. Test-only `std::fs` /
  `std::time::Instant` in hwp-hwpx and hwp-rhwp are `#[cfg(test)]` and never compiled here.
