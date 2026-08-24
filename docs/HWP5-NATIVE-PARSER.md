# First-party HWP5 parser boundary

Issue #107 introduced the first owned binary-HWP layer; issue #154 added its first semantic slice,
issue #156 added the minimum source-layout facts needed by the shared typesetter, issue #158 owns
the paragraph support-pool boundary, and issue #160 owns DocInfo styles plus content-free paragraph
header refusal reasons; issue #161 adds strict column definitions and the shared multi-column layout
contract. Issues #168–#196 then advanced one content-free control/table boundary at a time through
strict exact subsets. The bounded public benchmark now parses to the end in the first-party-only lane.
Issue #219 connects one already-proven decoration to production as a fail-closed enrichment; it is
not a generic parser cutover.

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

- `Engine::open`: binary HWP5 still uses the governed rhwp bootstrap for the base `SemanticDoc`.
  After that succeeds, the strict first-party parser may enrich only `Section.page_number`, and only
  when the complete owned parse succeeds, section topology is identical, and every pre-existing
  typed page-number value is compatible. Validation precedes mutation, so parse failure, topology
  mismatch, or any conflict is an atomic no-op. HWP3 remains the unmodified rhwp route.
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
- `hwp5_own_parser_eligibility`: runs the first-party parser and rhwp into the same typed semantic
  projection. Paragraphs and runs are split into body/decoration/table-cell/table-caption/note scopes;
  controls are split by semantic kind. Exact text is compared only in memory and leaves the report as
  one boolean. Unsupported input returns a static rejection code without invoking rhwp. Even an exact
  v2 semantic match remains `render-parity-unproven` until a per-document layout/PDF evidence channel
  is attached; v2 cannot produce a false-positive eligible result from counts and text alone.

The report's `topo-fnv1a64:*` value hashes only typed `SemanticDoc` topology markers and collection
cardinalities. It deliberately ignores text, URLs, image bytes, source paths, provenance bytes, and
style values. It is a regression fingerprint, not a document/content identity hash.

Raw-record counts and semantic counts are not treated as equivalent truth. In particular, native
`runs` currently counts `PARA_CHAR_SHAPE` position tuples and native `controls` counts
`CTRL_HEADER` records. Semantic `controls` counts typed table/image/equation/chart and remaining
field/note/raw control nodes. The differential makes these gaps measurable; it does not relax a gate
or claim semantic parity. On the completed bounded benchmark, sections/tables/images/equations/charts
currently agree while native-minus-oracle is paragraphs `+1`, runs `+7`, and controls `+6`.

The additive v2 semantic comparison classifies those numbers without changing v1:

- paragraph `+1` is the v1 semantic counter omitting one table-caption paragraph. Both semantic
  projections contain the same 91 body, 261 table-cell, and 1 table-caption paragraphs;
- control `+6` is six source metadata headers: one section definition, one column definition, two
  page-number-position controls, and two new-number controls. Both semantic projections contain the
  same 32 tables and no other active semantic control;
- run `+7` contains the same omitted caption run plus six empty text runs retained by the first-party
  parser and elided by rhwp: two in body paragraphs and four in table cells. Exact text comparison is
  equal. The additive empty-run typography projection records only opaque paragraph ordinals, semantic
  scope, run ordinal, resolved height, visible-content boolean, and layout role; it never records text,
  file names, paths, source hashes, or raw records.

Issue #200 classified the six-run delta without changing the parsed source model. Five differing
paragraphs contain visible content, so their trailing glyphless runs are invisible to the shared
typesetter. The remaining wholly empty body paragraph has two candidate empty runs versus one oracle
run, but both resolve to the same 1600 HWPUNIT effective height. A diagnostic-only normalization clone
drops only those layout-invisible runs (or retains the effective-height run for an empty paragraph).
Hostile fixtures keep different empty-paragraph heights and non-text controls non-equivalent.

The candidate and that evidence clone are exact across positioned flow/glyph paint, per-page SVG, and
PDF bytes. Candidate and rhwp still both produce 8 pages with equal per-page block/table/rect/line
counts, but exact block/table/cell/rect/line geometry does not yet match and the candidate has 24 more
painted glyphs (three per page). The empty-run difference is therefore semantically classified, while
the completed benchmark remains ineligible as `render-parity-unproven`; the remaining parser-wide
render delta must be isolated before cutover.

#202 decomposes that aggregate without retaining source content or identifying metadata. The repeated
three-glyph delta is entirely the first-party page-number decoration already owned by #164: rhwp's
semantic projection does not carry it, and removing only `Section.page_number` leaves every body glyph,
block, table, cell, rect, and line exact against the unmodified first-party candidate. Opaque masks over
the shared `PageLayerTree` give SVG and PDF the same decoration/body boundary. Against rhwp, body SVG is
exact on six of eight pages. Only zero-based page 2 has block/table/cell/rect/line deltas (all counts and
payload classes match; maximum bounded delta is 177 HWPUNIT), while page 7 has eight glyph x-position
deltas bounded by 72 HWPUNIT and otherwise exact geometry. This proves that page numbers are an oracle
omission rather than a native regression, but it does not waive the two remaining body-layout deltas;
the benchmark stays `render-parity-unproven` and ineligible.

#204 resolves both bounded body-layout deltas without editing vendored rhwp or changing production
routing. First, an exact 13-byte HWP5 cell `LIST_HEADER` extension carries the live layout width in its
first `u32`; one observed span cell's older core-width slot was stale by 176 HWPUNIT. The rhwp adapter
now accepts that extension only at the exact length, with a positive signed-32-bit width and an all-zero
reserved tail. A global column-boundary/span-equation solve is used only when every boundary is known,
positive, bounded, and mutually consistent; otherwise the entire solve fails closed to the prior
bounded heuristic. Second, the explicit-column caption path now applies `TableCaption.max_width` to
the same wrapping, alignment, and object-width calculations as the flat path. The bounded discriminator
is 143 HWPUNIT, whose half produced the former 71.5-HWPUNIT centered-glyph shift. Finally, HWP5 TABLE
bits 0–1/2 are kept as page-break/repeat-header semantics rather than being mistaken for HWPX
`noAdjust`; HWP5 stored row heights remain floors, while only the HWPX parser may request exact clipping.

After those corrections, all eight pages are exact against the raw rhwp oracle for body glyphs, blocks,
tables, cells, rectangles, lines, images, and body-only SVG. The first-party page-number decoration is
still intentionally present only in the candidate (three glyphs per page). Removing only that owned
decoration makes PDF bytes, page count, replay counters, and diagnostics exact against the rhwp PDF.
This is strong evidence for the one bounded benchmark, not generic HWP5 coverage: production remains
on rhwp, `external/rhwp` remains immutable, and eligibility remains false until the parser-wide corpus
and cutover gates below are satisfied.

#219 then promoted only that typed page-number fact into `Engine::open`. The base HWP5 document is
still decoded by rhwp; a complete strict first-party parse acts as the fail-closed evidence source.
On the canonical eight-page benchmark, production SVG and PDF now match the first-party candidate,
including three page-number glyphs per page. HWP3, HWPX, the generic cutover eligibility result, and
vendored rhwp are unchanged. This bounded enrichment does not imply that unsupported first-party
documents can bypass rhwp.

## Cutover rule

Completing one bounded benchmark is only the first eligibility milestone. The content-free committed
HWP5 matrix currently covers 13 public cases and reports eligible 0, render-parity-unproven 1,
unsupported-semantic 7, unsupported-border-fill 3, unsupported-style-semantics 1, and
invalid-container 1. The optional
rights-reviewed private intake expands this to 33 cases: the additional 20 classify as
unsupported-style-semantics 15, unsupported-border-fill 3, and unsupported-table-topology 2. This is a truthful starting
matrix rather than a coverage score: every unknown, unsupported, malformed, ambiguous, or
unexplained semantic difference is ineligible. The next #94 slices must classify each rejection,
keep the private 20-file rights-reviewed intake in the same local gate when present, and promote
BinData/images, decorations, and other controls only when
encountered semantics have faithful shared-IR representations. The production route may change only
when corpus differential gates, native/wasm parity, hostile input tests, and the canonical
8/18/24-page + 98.9% line gate remain green. Explicit own-parser mode must continue to fail closed for
every unsupported semantic construct.
