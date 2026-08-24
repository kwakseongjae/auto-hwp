# First-party HWP5 parser boundary

Issue #107 introduced the first owned binary-HWP layer; issue #154 added its first semantic slice,
issue #156 added the minimum source-layout facts needed by the shared typesetter, issue #158 owns
the paragraph support-pool boundary, and issue #160 owns DocInfo styles plus content-free paragraph
header refusal reasons; issue #161 adds strict column definitions and the shared multi-column layout
contract. Issues #168–#196 then advanced one content-free control/table boundary at a time through
strict exact subsets. The bounded public benchmark now parses to the end in the first-party-only lane.
None of these slices changes production parsing.

## What is owned now

`crates/hwp-hwp5` parses the CFB `FileHeader`, exposes every documented property/security flag,
walks `DocInfo` and `BodyText/SectionN` records, and preserves unknown records as `(tag, level,
size, header/data/end offsets, extended-header bit)`. It also decodes the strict DocInfo font,
character-shape, paragraph-shape, border-fill, tab-definition, numbering, bullet, and style pools plus
direct paragraph text and character-shape runs into `SemanticDoc`. STYLE names are validated as strict
UTF-16 but not copied into telemetry; kind, next-style, and the active para/character-shape reference
are range checked. The documented STYLE base and the observed optional zero reserved tail are accepted;
nonzero or unknown tails fail closed. Known binary border edges, solid shade,
and diagonal directions map to the shared `BorderFillDef`; unknown line values and image, gradient,
patterned, alpha, or mixed fills are refused rather than flattened. Paragraph references are range
checked. A pool that is merely present is not treated as active: custom tabs, numbering/bullets, and
visible paragraph border/fill still fail closed when a paragraph would depend on semantics the shared
typesetter does not yet own. The owned section-definition boundary maps a strict 40-byte `PAGE_DEF` to
`Section.page`, including all six margins, gutter, and HWP5 landscape orientation. A strict
19-byte `secd` extension is accepted only in the documented representative-language/master-page-tail
shape. Exact 28-byte foot/endnote-shape records are validated but remain dormant because note controls
are unsupported. Page-border records may be discarded only when their resolved `BorderFillDef` is
visually inert; visible page borders, shades, or diagonals fail closed. A strict
`PARA_LINE_SEG` reader validates declared counts and UTF-16 scalar/control starts, but exposes stored
line-box metrics only for true blank spacer paragraphs. Stored line breaks never override our
typesetter and zero-height segments are non-authoritative. A strict `cold` reader accepts bounded
1–32-column normal definitions, owned LTR/RTL direction, exact equal-width and
observed unequal proportional payloads, and known separator line values. Source proportions are
resolved against the validated page body into absolute HWPUNIT widths/gaps before they enter the
source-neutral `ColumnLayout`; malformed lengths, zero widths, trailing gaps, unknown upper attrs,
directions, distribution/parallel kinds, or separator values fail closed. Multiple column zones are
accepted only when none carries a separator; a separator zone must begin with the section and remain
its only zone until exact vertical spans are owned. `place_doc`, `NaiveLayout`, and `block_pages` select the
same column flow only when a paragraph carries a column-zone/break signal, leaving the established
single-column lane unchanged. Paragraphs and tables advance through identical column/page transitions,
and separator rules lower through the shared `PlacedLine`/`PaintOp::Line` path used by SVG and PDF.
Offsets are relative to the decompressed
standard stream. Source bytes, text,
filenames, credentials, and source hashes are never copied into the probe or differential report.

Untrusted input is bounded before and during inspection:

- raw file: 64 MiB;
- CFB entries: 4,096;
- cumulative decompressed record data: 256 MiB;
- records per stream: 1,000,000;
- every normal and extended record length is checked before forming a span.

The semantic slices additionally cross-check ID-mapping pool counts, paragraph-declared run and line
counts, UTF-16 scalar/control boundaries, references, support-pool variable lengths, supported
inline-control masks, record hierarchy, page dimensions, and positive body-box geometry. Run construction is bounded to
binary-search validation plus a linear text pass; it does not rescan the paragraph once per run.

Encrypted, distribution, DRM, and public-key-encrypted bodies are opaque to this slice and are
rejected instead of being interpreted as records.

## Parser modes

- `Engine::open`: unchanged production route. Binary HWP still uses the governed rhwp bootstrap.
- `open_hwp5_own`: explicit first-party-only route. It returns a `SemanticDoc` only for the owned
  text, single-sided page setup, strict column subset, page numbering, and explicitly enumerated
  table subsets. These include exact merged/full-grid forms, bounded depth-1 nested tables, multiple
  ordered table controls, fixed row geometry, and top captions represented by shared source-neutral
  IR. Unenumerated table attributes/topologies, floating objects, images, fields, notes, equations, charts,
  decorations, page border/fill, duplex binding, active custom tabs/lists/paragraph borders,
  unknown body controls, and unsupported pool values fail closed with a static reason plus tag,
  section, and byte span only. It cannot call rhwp. The bounded public benchmark now reaches the end
  without exposing content or using a fallback. This proves that document's exact subsets, not generic
  HWP5 coverage or production readiness. The owned lane includes strict
  single-section `pgnp` positioning and `nwno` page-counter restarts; other counters, zero starts,
  conflicting duplicates, missing positions, and multi-section inheritance fail closed. Exact duplicate
  `pgnp`/`nwno` records are idempotently collapsed by typed equality. Every owned `tbl ` control lowers
  to shared `Table`/`Cell`/`TableCaption` IR, so SVG and PDF consume the same `place_doc` geometry.
- `hwp5_differential`: explicitly runs the owned probe and current rhwp semantic oracle, then reports
  section/paragraph/run/table/image/control/equation/chart counts and their deltas.

The report's `topo-fnv1a64:*` value hashes only typed `SemanticDoc` topology markers and collection
cardinalities. It deliberately ignores text, URLs, image bytes, source paths, provenance bytes, and
style values. It is a regression fingerprint, not a document/content identity hash.

Raw-record counts and semantic counts are not treated as equivalent truth. In particular, native
`runs` currently counts `PARA_CHAR_SHAPE` position tuples and native `controls` counts
`CTRL_HEADER` records. Semantic `controls` counts typed table/image/equation/chart and remaining
field/note/raw control nodes. The differential makes these gaps measurable; it does not relax a gate
or claim semantic parity. On the completed bounded benchmark, sections/tables/images/equations/charts
currently agree while native-minus-oracle is paragraphs `+1`, runs `+7`, and controls `+6`. Those
content-free deltas must be classified before any production cutover claim.

## Cutover rule

Completing one bounded benchmark is only the first eligibility milestone. The next #94 slices must
classify the remaining semantic-count deltas, run fail-closed own-parser eligibility across the
privacy-safe public corpus, and promote BinData/images, decorations, and other controls only when
encountered semantics have faithful shared-IR representations. The production route may change only
when corpus differential gates, native/wasm parity, hostile input tests, and the canonical
8/18/24-page + 98.9% line gate remain green. Explicit own-parser mode must continue to fail closed for
every unsupported semantic construct.
