# First-party HWP5 parser boundary

Issue #107 introduces the first owned binary-HWP layer without changing production parsing.

## What is owned now

`crates/hwp-hwp5` parses the CFB `FileHeader`, exposes every documented property/security flag,
walks `DocInfo` and `BodyText/SectionN` records, and preserves unknown records as `(tag, level,
size, header/data/end offsets, extended-header bit)`. Offsets are relative to the decompressed
standard stream. Source bytes, text, filenames, credentials, and source hashes are never copied
into the probe or differential report.

Untrusted input is bounded before and during inspection:

- raw file: 64 MiB;
- CFB entries: 4,096;
- cumulative decompressed record data: 256 MiB;
- records per stream: 1,000,000;
- every normal and extended record length is checked before forming a span.

Encrypted, distribution, DRM, and public-key-encrypted bodies are opaque to this slice and are
rejected instead of being interpreted as records.

## Parser modes

- `Engine::open`: unchanged production route. Binary HWP still uses the governed rhwp bootstrap.
- `open_hwp5_own`: explicit first-party-only route. It validates the owned layers, then returns the
  precise pending-capability error until DocInfo and text decoding land. It cannot call rhwp.
- `hwp5_differential`: explicitly runs the owned probe and current rhwp semantic oracle, then reports
  section/paragraph/run/table/image/control/equation/chart counts and their deltas.

The report's `topo-fnv1a64:*` value hashes only typed `SemanticDoc` topology markers and collection
cardinalities. It deliberately ignores text, URLs, image bytes, source paths, provenance bytes, and
style values. It is a regression fingerprint, not a document/content identity hash.

Raw-record counts and semantic counts are not treated as equivalent truth. In particular, native
`runs` currently counts `PARA_CHAR_SHAPE` position tuples and native `controls` counts
`CTRL_HEADER` records. Semantic `controls` counts typed table/image/equation/chart and remaining
field/note/raw control nodes. The differential makes these gaps measurable; it does not relax a gate
or claim semantic parity.

## Cutover rule

The next #94 slices promote DocInfo pools and paragraph text/control decoding into this crate. The
production route may change only when public-corpus differential gates, native/wasm parity, hostile
input tests, and the canonical 8/18/24-page + 98.9% line gate remain green. Explicit own-parser mode
must continue to fail closed for every unsupported semantic construct.
