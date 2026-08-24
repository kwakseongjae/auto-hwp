# PDF visual oracle (report-only V0/V1/V2)

This document describes the bounded report-only foundation in GitHub issue #121, under the broader
#93 visual-oracle track. The low-level comparator compares an auto-hwp PDF with an explicitly
classified PDF reference. Issue #213 adds a one-command HWP/HWPX runner and semantic regions emitted
from the exact placement used by the PDF export. It does **not** infer that a nearby PDF is ground
truth or decide pass/fail.
Current reports use `schema_version: 4`; non-finite values are rejected rather than emitted as
non-standard JSON `NaN`/`Infinity` tokens.

The existing stored-lineseg `layout-check` remains the fast layout regression gate. This visual report
is additive and does not replace or relax it.

## First T1 calibration (issue #101)

The first committed calibration contract is split into two metadata-only files:

- `corpus/pdf-calibration-manifest.json` pins 20 official law.go.kr HWP5/PDF attachment pairs,
  their rights/provenance records, source/reference hashes, Hancom PDF producer metadata, normalized
  `pdffonts` fingerprints, the own-engine font hash, 144 DPI, and the no-normalization policy.
- `corpus/pdf-calibration-baseline.json` is the redacted machine-readable result produced at engine
  commit `d803ab1f6540adb7b54ae60959d9923d4e534b2f`. It records 18 scored reports (19 pages) and two
  page-count structural mismatches. It contains no pass field or aggregate quality threshold.

The two structural mismatches are `law-go-271027-17184503` and
`law-go-271027-17184525`: the official PDF has one page while the own engine exports two. Their
pixel comparison is deliberately absent rather than represented as a low or zero score. Among the
18 structurally comparable pairs, the results remain diagnostics: several worst tiles have zero
recall and the worst-page ink/edge metrics show substantial fidelity work remains. Calibration does
not turn those observations into a gate.

The full side-by-side, overlay, and heatmap HTML/PNG reports stay under `corpus/private/` and are
gitignored. Given a private flat directory containing the 20 HWP5 files and another containing the
20 matching official PDFs, reproduce the whole HWP5 → own PDF → structural check → pixel report
pipeline with:

```bash
cargo build -p auto-hwp-cli --features "pdf shaper rhwp"
node scripts/pdf-visual-calibrate.mjs --run \
  --source-root corpus/private/pdf-calibration/sources \
  --reference-root corpus/private/pdf-calibration/references \
  --output-dir corpus/private/pdf-calibration/run-001 \
  --cli target/debug/auto-hwp
```

The output directory must not exist. The runner verifies every source/reference hash and byte count,
recomputes each reference font fingerprint, exports candidates through `export-pdf`, and builds the
entire result in a private staging directory before an atomic rename. A tool/input error removes only
that unique staging directory. A structural mismatch remains a successful report-only observation.
`node scripts/pdf-visual-calibrate.mjs --check` validates the committed manifest and baseline without
network access or private binaries; CI runs this check alongside the existing Python resource-limit
and self-compare determinism suite.

## Scope

`scripts/pdf-visual-check.py` currently provides:

- required T0/T1/T2/T3 reference classification;
- SHA-256 identity for the candidate and reference in every JSON and HTML report;
- a structural stage for page count, per-page MediaBox size, valid CropBox coordinates/size,
  rotation, and CropBox orientation;
- 144 DPI Poppler rasterization on white after the structural stage succeeds;
- page-by-page rasterization with input/page/pixel/PNG/metric-work/report/timeout limits;
- deterministic integer translation alignment bounded to ±3 px;
- complementary global, local, foreground, ink, edge, bounding-box, and tile metrics;
- local side-by-side, overlay, and heatmap diagnostics;
- content-free text/table/image/object region metrics bound to the exact candidate PDF SHA-256;
- a worst-five semantic-region ranking that reuses the one whole-page translation and performs no
  object-local alignment;
- explicit JSON `null` plus reasons when a metric is unscorable;
- no absolute thresholds and no pass/fail field.

The candidate must be the actual own-engine PDF. Do not pass output from the legacy rhwp `render`
command and describe it as the candidate.

## Reference tiers

The caller must supply `--reference-tier`; the script never guesses it from a filename or directory.

| Tier | Intended authority |
|---|---|
| T0 | Licensed Hancom Windows/WebHWP rendering with product/build/font provenance |
| T1 | Official PDF confirmed to represent the same published document |
| T2 | HWP/HWPX plus stored-lineseg three-way diagnostic; useful but not absolute visual truth |
| T3 | rhwp, LibreOffice, or another debugging aid; never ground truth |

Classification is an assertion by the operator, not something this program can authenticate. T0 and
T1 require nonempty renderer/product, build, OS, font fingerprint, and provenance note fields; the
command fails closed when any is absent. A populated record is labelled `self_attested`, never
“complete” or authenticated. The report and HTML preserve these values alongside both file hashes.
T2/T3 may omit unavailable fields but remain explicitly lower-authority references.

References containing private, licensed, or user content must stay on an authorized private runner.
Only self-created or appropriately redistributable fixtures belong in public CI.

## Dependencies

Python dependencies are deliberately limited to the standard library. Runtime comparison needs
Poppler commands on `PATH`:

```bash
pdfinfo -v
pdftoppm -v
```

On macOS, install them with `brew install poppler`. Poppler command versions are recorded in the
report because raster output can change across versions.

## Usage

For normal document diagnosis, build the CLI and run the atomic one-command path. Binary `.hwp`
additionally needs the `rhwp` parser feature; this does not make rhwp the renderer. The candidate PDF
and content-free region evidence are both derived from our shared IR and placement.

```bash
cargo build -p auto-hwp-cli --features "pdf shaper rhwp"
node scripts/document-visual-check.mjs benchmarks/benchmark.hwp \
  --reference benchmarks/benchmark.pdf \
  --reference-tier T3 \
  --output-dir /tmp/benchmark-visual-report \
  --cli target/debug/auto-hwp
```

Use T0/T1 only with the complete self-attested provenance options documented below. The output
directory must not already exist. Candidate export, region evidence, JSON, HTML, and assets are built
in a private sibling staging directory and renamed together only after every step succeeds.

The lower-level two-step interface remains available for isolated comparator work:

```bash
target/debug/auto-hwp export-pdf benchmarks/benchmark.hwp \
  -o /tmp/benchmark-own.pdf \
  --visual-regions /tmp/benchmark-own.regions.json
python3 scripts/pdf-visual-check.py /tmp/benchmark-own.pdf \
  --reference benchmarks/benchmark.pdf \
  --candidate-regions /tmp/benchmark-own.regions.json \
  --reference-tier T1 \
  --reference-product "official publication PDF" \
  --reference-build "recorded by fixture manifest" \
  --reference-os "recorded by fixture manifest" \
  --font-fingerprint "sha256:..." \
  --candidate-font-fingerprint "sha256:..." \
  --reference-note "Pair identity verified by document owner" \
  --output-dir /tmp/benchmark-visual-report
```

Open `/tmp/benchmark-visual-report/index.html` locally. The one-command result keeps the comparator
under `report/report.json` and `report/assets/`, alongside the exact candidate PDF, SHA-bound region
evidence, and a content-free `summary.json`.

Input paths are redacted to their basenames by default so private directory names do not leak into a
shared report. `--include-input-paths` is an explicit local-only override; SHA-256 remains the stable
identity in either mode.

Inputs are opened as regular file descriptors with `O_NOFOLLOW` where the platform provides it, then
copied into a private snapshot. Staging, final report, and `assets/` directories are forcibly mode
`0700`; JSON, HTML, and every source/copied/generated PNG are forcibly mode `0600`, independent of a
caller umask such as `000` or `022`.

The process exits nonzero only for tool/input/report-generation errors. A structural mismatch or bad
visual score still exits successfully in this report-only phase and is represented in the report
status. Consumers must not reinterpret exit zero as a fidelity pass.

## Structural stage

`pdfinfo` is run before either PDF is rasterized. The report compares:

1. page count;
2. MediaBox physical width and height for each page;
3. a positive CropBox contained in MediaBox;
4. CropBox offset coordinates and physical width/height;
5. normalized page rotation;
6. effective CropBox portrait/landscape/square orientation.

Physical width and height may differ by at most 1.0 pt. This admits normal A4 writer rounding such as
`595×841 pt` versus `595.28×841.88 pt`, while a larger size difference, page-count change, rotation,
or orientation change remains a structural mismatch. Full MediaBox coordinates are retained in JSON
for diagnosis; the hard comparison concerns physical page size.

CropBox offset and size use the same 1.0 pt writer-rounding tolerance. A changed crop origin, visible
extent, invalid/non-positive CropBox, or CropBox outside MediaBox is a structural mismatch. Both
`pdfinfo` inspection and `pdftoppm -cropbox` therefore describe and render the same visible page box.

If any structural item differs, root `status` is `structural_mismatch`,
`pixel_comparison_attempted` is false, and no SSIM-like score is produced. The program does not hide a
page-size error by stretching, rotating, or cropping either page.

At 144 DPI, an accepted 1 pt page-size rounding can produce a one- or two-pixel raster difference.
The smaller raster is therefore padded only on its right/bottom with white to a shared canvas. The
maximum permitted padding is 3 px: 2 px for 1 pt at 144 DPI plus one pixel for independent boundary
rounding. A larger raster difference makes that page `unscorable`. Neither case resizes content.

## Raster and alignment contract

- `pdftoppm` renders at exactly 144 DPI with its white page background.
- every Poppler call renders one exact page with `-cropbox -singlefile`; all page/resource checks
  derivable from PDF metadata finish before the first raster command, while actual PNG byte and pixel
  totals are rechecked after each page;
- PNG alpha, if present, is flattened onto white by the decoder.
- each input is copied once into a unique temporary directory before hashing, inspection, and raster;
- rendered pages are selected by exact numeric page number, not a broad stale glob;
- candidate and reference retain their original pixels and scale; only the smaller accepted A4 page
  receives recorded white right/bottom padding to a shared canvas;
- no scaling, fractional resampling, rotation, crop, or content-aware mask is allowed;
- only a whole-page integer translation is searched, within ±3 px in each axis;
- the chosen `dx`/`dy`, search objective, scale `1.0`, rotation `0`, and `crop=false` are reported.

`candidate_translation_px` describes the translation applied to candidate content. For example,
`dx=-2, dy=1` means move candidate ink two pixels left and one pixel down to align with the reference.
Pixels shifted outside the unchanged page canvas become white and are still penalized by ink loss.
The report records clipped candidate ink/edge counts, and precision/F1/IoU/ink-ratio denominators use
the pre-translation candidate count, so moving candidate-only ink off-canvas cannot improve a score.

Alignment chooses the translation with the greatest exact binary-ink intersection. Deterministic
tie-breaking favors the smallest movement. Alignment is diagnostic; raw candidate PNGs remain in the
report so the offset cannot conceal the original rendering.

## Resource limits

The defaults are soft operational limits. Every CLI override is revalidated by `ResourceLimits`
against a non-bypassable hard ceiling; constructing `ResourceLimits` directly does not evade it.
An A4 page at 144 DPI is about 2.0 million pixels, so the page default is intentionally close to real
work rather than the former unsafe 25 million-pixel allowance.

| Option | Default | Hard ceiling | Scope |
|---|---:|---:|---|
| `--max-input-bytes` | 100 MiB | 1 GiB | each input snapshot |
| `--max-pages` | 200 | 1,000 | each PDF, checked before detailed `pdfinfo` |
| `--max-page-pixels` | 4,500,000 | 8,000,000 | each 144 DPI raster |
| `--max-total-pixels` | 250,000,000 | 1,000,000,000 | estimated and actual pixels across both PDFs |
| `--max-raster-bytes` | 64 MiB | 256 MiB | each Poppler PNG |
| `--max-total-raster-bytes` | 512 MiB | 2 GiB | all Poppler PNGs across both PDFs |
| `--max-png-decompressed-bytes` | 128 MiB | 512 MiB | one PNG's decoded scanlines |
| `--max-ink-pixels` | 600,000 | 1,000,000 | foreground pixels in each page image before Python set allocation |
| `--max-alignment-work` | 30,000,000 | 50,000,000 | candidate ink pixels × translation candidates per page |
| `--max-edge-work` | 16,000,000 | 30,000,000 | foreground upper bound, then exact visible edge pixels × 13 probes per page |
| `--max-report-asset-bytes` | 64 MiB | 128 MiB | each final raw/aligned/overlay/heatmap PNG |
| `--max-report-bytes` | 512 MiB | 2 GiB | final JSON + HTML + all PNG assets |
| `--max-subprocess-output-bytes` | 1 MiB | 4 MiB | combined stdout/stderr for each Poppler command |
| `--subprocess-timeout-seconds` | 60 | 300 | each `pdfinfo` or page `pdftoppm` process |

Input copying is streaming and stops after the configured byte ceiling. CropBox dimensions provide a
pixel preflight before rasterization; actual PNG dimensions and cumulative counts are checked again.
The PNG decoder checks compressed file bytes, declared pixel count, expected scanline bytes, and uses
bounded zlib output rather than unbounded `decompress`. A limit or timeout is a tool error, not a zero
fidelity score, and atomic report staging leaves no partial output.

Before metrics allocate `set[int]`, the implementation counts reference and candidate ink using a
constant-memory byte scan. It rejects either excessive ink or `candidate ink × (2d+1)²` alignment
work before the up-to-49-offset search begins. This fail-closed boundary protects the two raw ink
sets and up-to-49-offset search without attempting a high-risk bitmap rewrite. Before those sets are
allocated, it also rejects the conservative `(reference ink + candidate ink) × 13` edge-work upper
bound. Every edge is a subset of foreground ink, so this bounds derived edge work without allocating a
potentially 13-times-larger dilation. Matching then probes the fixed radius-2 neighborhood directly and
rechecks its exact visible-edge probe count against `--max-edge-work`.

On POSIX, each `pdftoppm` child receives `RLIMIT_FSIZE` equal to the configured per-raster byte limit,
then the completed file is checked again. Platforms without `RLIMIT_FSIZE` explicitly report
`post_write_stat_only_platform_fallback` in the environment fingerprint. Raw copies and every derived
asset are checked immediately after generation and again after private staging copy; JSON and HTML
are included in the final report byte budget. `MemoryError` and `OverflowError` become explicit tool
errors instead of uncaught tracebacks or fidelity scores. Each Poppler process is drained concurrently
through bounded stdout/stderr readers; crossing their combined byte limit kills the child and fails the
comparison without retaining the excess output.

## Metrics

All metrics are reported per page. They are rounded to six decimal places in JSON for stable review.
There is intentionally no aggregate score that can compensate for a lost object on one page.

### SSIM-like measures

Raw and translated-only `global` values use the luminance/contrast/structure formula over the whole
grayscale page. Raw and aligned `local` values apply the same formula to fixed 64×64 px windows and
report the mean and worst window. Partial edge windows are weighted by their actual pixel count, so a
one-pixel-wide final window cannot count as much as a full 64×64 window. These are called
**SSIM-like**, not standards-certified SSIM: the implementation is small, deterministic, and
dependency-free rather than a replacement for a calibrated image-science library.

### Union-foreground MAE

Foreground means grayscale `<245`. The union-foreground MAE averages normalized absolute grayscale
difference only where the reference or candidate contains foreground. It avoids dilution by a large
white margin. When both pages are blank, the value is unscorable (`null`), not zero.

### Ink precision, recall, F1, IoU, and ratio

Binary ink metrics use the same `<245` threshold after translation:

- precision asks how much candidate ink coincides with reference ink;
- recall asks how much reference ink survives in the candidate;
- F1 balances those directions;
- IoU measures intersection over union;
- ink ratio is candidate ink count divided by reference ink count.

A missing candidate object therefore lowers recall even if whole-page SSIM-like remains high. If a
denominator does not exist, the corresponding metric is JSON `null` and its reason appears under
`unscorable_metrics`. A nonblank reference with a blank candidate has recall/F1/IoU `0`, because that
is measurable loss; precision remains unscorable because the candidate has no predicted ink.

### Edge F1

Edges are the four-neighbor boundary of binary ink. Precision and recall permit a Euclidean tolerance
of at most 2 px to avoid turning rasterizer anti-aliasing into false object loss. The tolerance is
fixed and recorded. It is not a whole-object shift allowance; the preceding translation remains
bounded to ±3 px.

### Content bounding box

The report records both raw and aligned candidate/reference ink bounding boxes plus
left/top/right/bottom, width, and height deltas. Raw SSIM-like/bbox values prevent a translation that
clips candidate-only edge content from looking perfect; aligned ink denominators also retain clipped
candidate ink. If either side has no ink, bounding-box comparison is unscorable.

### Worst-tile recall

The page is partitioned into fixed 128×128 px tiles. Every tile containing reference ink receives an
exact ink-recall value, and the worst tile is reported with its coordinates and ink counts. This is
the first report-only local-region alarm: a tiny missing equation or chart cannot disappear inside an
otherwise white, globally similar page.

### Semantic regions

When `--candidate-regions` is supplied, visual-region schema v2 divides the candidate placement into
four content-free categories: paint-backed paragraph bands (`text`), placed table boxes (`table`), raster images
(`image`), and SVG-backed equations/charts/other objects (`object`). IDs and HWPUNIT geometry are
present; source text, paths, binary identifiers, and font paths are absent.

For paragraph bands, source-visible text is reduced to a boolean and checked against the exact placed
glyph stream. Any glyph inside the band wins as `painted`, including a generated marker on a
text-empty paragraph. Without a glyph, source-visible paragraphs become `expected-missing`; only a
band with neither source-visible text nor a placed glyph is an intentional blank. Intentional blank
page-fragments are counted separately and never enter pixel ranking. `expected-missing` is an explicit
unscorable placement failure. Non-text regions use `not-applicable`. A painted region that rasterizes
without candidate ink remains partially unscorable with an explicit metric reason rather than being hidden.

The manifest must be strict UTF-8 JSON with exactly the known fields, ordered one-based pages, finite
positive in-page geometry, unique per-page IDs, matching MediaBox dimensions, and an exact SHA-256
match to the candidate PDF. It is rejected on unknown categories/fields, non-finite values, duplicate
IDs, page mismatch, symlink input, excessive entries, or more than 16 page-equivalents of overlapping
region area. These bounds keep repeated full-page regions from multiplying metric work.

Each region is cropped only after the page's single bounded translation is chosen. There is no second
search that could hide a locally misplaced object. The report records independent SSIM-like, MAE,
ink, and edge diagnostics, explicit unscorable reasons, per-category counts, and the worst five
regions. Regions are additive and may overlap—for example, cell text remains inside a table region—so
they are diagnostic lenses rather than a partition or an aggregate quality score.

### Bounded vertical-transition trace

For `text` and `table` regions, the report also emits a content-free, report-only vertical trace.
It keeps the page's already-selected global alignment and the region's fixed horizontal extent, then
compares candidate and reference row-ink profiles over integer vertical offsets from -128 through
+128 pixels. Ranking is lexicographic: active-row F1 first, row-ink-count cosine second. There is no
minimum score or confidence threshold. A unique best rank is labeled `hypothesis`; an exact tie is
`ambiguous`; absent candidate/reference overlap, missing placement evidence, or exhausted bounded work
is `unscorable`. Image/object regions are `not-applicable`.

The search reads each candidate crop and the union of its reference search window once. Per-page work
is capped at 50,000,000 pixel/profile operations. The report records the considered offset range,
best and runner-up evidence, tied offsets, active-row counts, and work units. None of these fields feed
page metrics, region metrics, alignment, thresholds, status, or `policy.pass`.

Adjacent non-overlapping text/table regions are ordered by aligned top coordinate. When both endpoint
traces are unique and their reference hypotheses remain non-overlapping and monotonic, the report
records candidate/reference gap hypotheses and the offset increment. Ties, missing evidence, source
overlap, or hypothesis-induced overlap remain explicit ambiguity instead of becoming a layout fact.

## Visual report

For every dimension-compatible page, `index.html` shows:

- reference raster;
- raw candidate raster;
- translated-only candidate raster;
- overlay, with reference-only ink red and candidate-only ink blue;
- absolute grayscale-difference heatmap;
- a metric table and the complete page JSON.

The summary lists up to five lowest-ink-F1 pages, five lowest-recall worst tiles, and five worst
semantic regions when evidence is present. These are diagnostic rankings only, not acceptance
decisions. HTML has no remote scripts, fonts, or network dependencies.

## Determinism and identity

The report records:

- candidate and reference SHA-256;
- explicit tier and required-but-self-attested T0/T1 provenance fields;
- fixed DPI, ink threshold, edge tolerance, local-window size, and tile size;
- Poppler tool versions;
- OS, machine, Python, candidate/reference font identifiers, and a canonical environment SHA-256;
- all configured limits and actual/estimated resource usage;
- the exact alignment policy and selected offsets.

Inputs are first copied into an immutable per-run snapshot. SHA-256, `pdfinfo`, and `pdftoppm` all read
that snapshot, so a source path replaced during the run cannot make a hash describe different rendered
bytes. Final output is staged and renamed as one directory.

No wall-clock timestamp, random identifier, temporary path, or default output location is written to
the output. Repeating a comparison with identical file bytes, command arguments, Poppler version,
and OS/font environment should therefore produce identical report bytes and asset PNGs even when the
input parents and output directories differ.

The current CLI computes hashes and binds semantic evidence to the exact PDF, but it does not consume
a cryptographically signed fixture manifest. The ≥20-pair T1 calibration stores reviewed source and
reference hashes, producer/build/OS/export/font metadata, and redistribution authority. A sibling
`.pdf` alone must never be promoted to T0 or T1.

## Report-only interpretation

This slice intentionally defines no universal green/yellow/red bands. Font differences and reference
authority must be measured across representative T0/T1 samples before thresholds are adopted.

Recommended rollout remains:

1. collect report-only distributions with stable reference and font fingerprints;
2. inspect worst pages/tiles and correct sink loss;
3. introduce per-fixture regression-only baselines after repeatability is established;
4. separately decide absolute fidelity targets from T0/T1 evidence;
5. never allow aggregate improvement to erase a failing page or object region.

`policy.pass` is therefore always JSON `null`. `status` distinguishes `structural_mismatch`,
`partially_unscorable`, and `scored_report`; none means “passed.”

### First T1 calibration (2026-08-22)

The first live pass used five same-post HWPX/PDF attachment pairs from the official
[MOHW publication](https://www.mohw.go.kr/board.es?act=view&bid=0027&list_no=1490937&mid=a10503010100).
Source binaries and full reports remained under ignored/private paths; no document was added to Git.

| Pair | Own → official pages | Status | Mean global SSIM-like | Mean ink F1 | Finding |
|---|---:|---|---:|---:|---|
| 01 | 4 → 4 | `scored_report` | 0.150700 | 0.318802 | typography/table geometry drift |
| 02 | 4 → 4 | `scored_report` | 0.123952 | 0.173607 | typography/table geometry drift |
| 03 | 6 → 6 | `scored_report` | 0.151803 | 0.283513 | CELL continuation restored; pages 1–3 portrait, 4–6 landscape; #95 |
| 04 | 3 → 3 | `scored_report` | 0.124490 | 0.175401 | final-page landscape restored; #96 |
| 05 | 9 → 9 | `scored_report` | 0.074480 | 0.257094 | page count alone hides large visual drift |

The three documents scored in the initial pass had worst-tile recall `0.0`. This run proves that the
structure-first stage and local-region alarm expose failures that a page-count or
white-background-dominated score would miss. It does **not** provide enough samples to define an
acceptance threshold.

The #95/#96 follow-up on 2026-08-24 re-ran the same two private T1 pairs after the own HWPX parser
and paginator fixes. Both are now structurally comparable, so pixel metrics are reported instead of
silently assigning structural failures a score. Both still have worst-tile recall `0.0`; restoring
page count and orientation is therefore a prerequisite, not evidence of complete visual fidelity.

### Deterministic-font remeasurement (2026-08-25, #217)

The canonical public 8-page HWP/PDF pair was rerun in two independent processes with the #215 public
Nanum OFL registry. Both runs produced the same candidate PDF SHA-256
`2ee862963eceb8c3c31e2a05d8ee915b3e3ad61778a4b541e9aae005fc2d0ad9`, registry fingerprint
`sha256:39841f738d60ca1822789c92bbc30d134969910589584b3766a4d9365b3742a9`, 8 pages, and 102
semantic regions (70 text, 32 table). All 3,143 non-whitespace glyph requests were reported as
OFL fallback rather than exact realization; no path, text, font bytes, or source hash entered the
report.

The registry changed the worst-page ink F1 from `0.218434` to `0.221304`. Per-page changes ranged
from `-0.008762` to `+0.002870`; mean table-region ink F1 changed by `-0.000277` and mean numeric
text-region ink F1 by `+0.000277`. All eight content-bbox height deltas were unchanged. Fifty-two of
70 text regions remained at ink F1 `0.0`, including 25 where the candidate region had no ink while
the same aligned reference band did. This is a useful negative result: deterministic substitution
made the export reproducible and diagnosable, but did not explain the dominant fidelity gap.

Direct inspection isolates one already-owned non-font defect: the official PDF paints a bottom-center
page-number decoration while the production rhwp semantic lift omits it. The existing content-free
`hwp5_empty_run_layout` regression proves the first-party HWP5 candidate owns exactly three decoration
glyphs per page and that removing only `Section.page_number` leaves body glyph/block/table/cell/rect/
line/image evidence exact. The next bounded implementation should connect that owned decoration to
the production path fail-closed; it must not modify rhwp, claim OFL fallback as exact, or relax the
visual oracle.

### Fail-closed page-number enrichment remeasurement (2026-08-25, #219)

The bounded #219 enrichment restored the owned bottom-center page number while retaining rhwp as the
base HWP5 decoder. The canonical run remained 8 pages and 102 semantic regions, and produced candidate
PDF SHA-256 `25524c3dfc15e19498fb5623e74bc38f16ba9e751dba7470ef441406cdb9e5bd`.
Aggregate page ink F1 moved only slightly because the decoration is small: pages 1–8 changed from
`0.819208, 0.853208, 0.791151, 0.318353, 0.252517, 0.358842, 0.290394, 0.221304` to
`0.819227, 0.853170, 0.791077, 0.318685, 0.252800, 0.358870, 0.290371, 0.221422`.

The structural signal is decisive: content-bbox height deltas collapsed from
`-100, -559, -59, -952, -639, -610, -91, -143` pixels to
`+2, +5, -2, +2, +1, -1, +1, +1`. Direct inspection confirms that the candidate now paints the
bottom-center page number at the reference location. This closes the missing-decoration defect, not
the broader typography/color fidelity gap; the T3 reference, thresholds, translation bounds, and
report-only `pass=null` policy remain unchanged.

### Paint-backed text-region remeasurement (2026-08-25, #221)

Visual-region schema v2 reran the exact #219 candidate PDF without changing its SHA-256
`25524c3dfc15e19498fb5623e74bc38f16ba9e751dba7470ef441406cdb9e5bd`, proving that this evidence
change does not alter placement or export bytes. Of the former 70 broad paragraph bands, 42 are now
classified as intentional blanks and excluded from pixel ranking. All remaining 28 text regions are
`painted`, all 28 contain candidate ink, and none is `expected-missing`.

Twelve of those 28 painted regions remain partially unscorable because the globally aligned
reference band contains no ink. Eleven contain only 22 candidate pixels and one contains 2,406,
while additional scored text regions have zero overlap despite ink on both sides. Together with
direct page inspection, this replaces the earlier ambiguous “candidate missing text” signal with a
bounded cumulative vertical-position drift: lower-page candidate symbols/headings occupy bands where
the reference content has already moved. The next rendering child should isolate the first divergent
vertical increment; font weight/category remains a separate axis. T3 authority, translation bounds,
thresholds, and `pass=null` remain unchanged.

### First vertical-transition trace (2026-08-25, #223)

The trace reran the exact #219/#221 candidate PDF SHA-256
`25524c3dfc15e19498fb5623e74bc38f16ba9e751dba7470ef441406cdb9e5bd`; export bytes, eight-page
structure, global translations, page/region scores, T3 authority, and `pass=null` were unchanged.
All 60 paint-backed text/table regions produced content-free trace evidence: 55 unique hypotheses and
5 exact ties in the first run. Repeated short marker rows explain the ties and remain visible rather
than receiving an arbitrary nearest match. Of 52 adjacent pairs, 26 remain valid hypotheses and 26
are explicit ambiguity because their source regions overlap, their endpoints tie, or the inferred
reference gaps would overlap. Two independent runs produced byte-identical JSON and HTML reports.

The earliest stable page-4/page-5 divergence is bounded to `table-0001 → table-0002`: the first table
anchors at 0 px while the second table's reference-row hypothesis is +17 px and +19 px lower,
respectively. The same transition class is +9 px on page 1 and +33 px on page 7, while later isolated
text rows often repeat and therefore do not yet identify a safe renderer formula. This supports a
separate consecutive-table/anchor-spacing investigation; it does not justify changing table height,
paragraph line metrics, or font realization in #223.

### HWP5 table-anchor spacing ownership (2026-08-25, #225)

The #223 transition was decomposed without changing placement. On canonical page 4, the candidate
and reference first-table ink spans are rows 143–206 and 143–205, while the second table begins on
rows 210 and 229. The first table's height is therefore not the missing 19-pixel increment.

Content-free HWP5 `PARA_LINE_SEG` evidence identifies the exact source-owned distance. On pages 4 and
5, the first table host has `(vertical_pos=0, line_height=3285, line_spacing=960)` and the next host
starts at `vertical_pos=4245`; on page 1 the corresponding values are `(0, 2130, 452)` and `2582`.
At the report's 144 DPI, 960 and 452 HWPUNIT are 19.2 and 9.04 pixels—the observed +19 and +9
transition increments. The production layout instead advances only by table height plus the preceding
bottom and following top margins: 3,286 rather than 4,246 HWPUNIT on pages 4/5, and 1,989 rather than
2,441 on page 1.

The strict owned HWP5 parser, rhwp-base lift, and production-enriched document have identical
top-level table margins and placed table geometry, so this is neither margin parse loss nor an
own-vs-rhwp discrepancy. Synthetic tests separately pin summed (not collapsed) table margins, a
zero-height pure anchor, a real blank spacer, fresh-page behavior, and `place_doc`/`NaiveLayout`/
`block_pages` page ownership. An owned HWPX pair retains only its explicit outer margins and carries
no source anchor-line metric, so HWPX's established zero-height anchor contract must not inherit this
HWP5-only source evidence. A renderer fix belongs in a separate child and must preserve that boundary.

### First-party source-adjacent anchor spacing (2026-08-25, #227)

The initial implementation deliberately tested the weaker hypothesis “every positive table-host
`line_spacing` is a post-table gap.” It produced nine candidate pages against the eight-page source and
was rejected. Positive spacing becomes authoritative only when the immediately following pure table
host starts at exactly `previous.vertical_pos + previous.line_height + previous.line_spacing`. A page
reset, ordinary paragraph, missing/multi-line metric, or arithmetic mismatch therefore leaves the
render-only value at zero. When one host contains multiple table controls, only its final table owns
the gap.

The strict first-party HWP5 parser owns this evidence. The production rhwp-base document receives it
only after a whole-document strict parse and validation-before-mutation comparison of section count,
ordered table/cell topology, stored sizes, and margins. rhwp itself still supplies zero for the new
axis; HWPX and synthesized tables also remain zero. `place_doc`, `NaiveLayout`, `block_pages`, and the
column variants consume the same value once, after the table's bottom margin. Overflow advances the
next block to a fresh page/lane and resets the cursor, so spacing is never carried onto the new lane.

The canonical document contains six such source-adjacent hosts. It remains eight pages, while the
page 1/4/5 first table transitions move from +9/+17/+19 pixels to 0/0/0. Page ink F1 deltas against the
#223 report are +0.062901, +0.000087, -0.000397, +0.134124, +0.186803, +0.407532, +0.128682, and
-0.002868 for pages 1–8 respectively. The two small negative deltas remain visible rather than being
masked or thresholded. Two independent runs produced byte-identical candidate PDF SHA-256
`61ab5f3a9329c9d78376813d63cffb62aa9f495962dda5bae97f402baa0789fb` and report SHA-256
`45a910358e2ebffe4eb906eef6cdcc157546f86a3ce2ee33f5a8ef320d7b7e49`; T3, global alignment,
scoring, thresholds, and `policy.pass=null` are unchanged.

## Tests

Run the dependency-free synthetic metric and PNG codec suite with:

```bash
python3 scripts/tests/test_pdf_visual_check.py -v
```

The suites cover exact identity, bounded translation, clipped-ink penalties, translation overflow,
missing small foreground, blank/unscorable semantics, missing-all-ink loss, 2 px edge tolerance,
white padding without resampling, PNG round-trips, A4 tolerance, and structural mismatches. It also
exercises valid/different CropBoxes, `-cropbox` page rendering, input/page/pixel/raster/decompression,
ink/alignment/edge-work, derived-asset, and report-total limits; subprocess output caps, timeouts,
and POSIX file-size caps;
T0/T1 provenance, path redaction, forced `0700`/`0600` modes under umask `000` and `022`, secure
symlink rejection, finite box/rotation validation, resource-exhaustion conversion,
structural-before-raster orchestration, strict SHA-bound semantic-region validation, bounded region
work, fixed-global-alignment region scoring, complete unscorable HTML/JSON output, and atomic failure.
The Node suite additionally covers one-command private staging, no-overwrite behavior, source-path
redaction, symlink rejection, and failed-subprocess cleanup.
When Poppler and
`benchmarks/benchmark.pdf` are present, it rasterizes the first page and performs an exact
self-compare; otherwise that integration case is skipped.

Both suites are wired into `scripts/verify-local.sh` and the required GitHub `build-test` job. The
Python suite includes a two-run whole-report determinism check
covering the raw byte-identical `report.json`, HTML, and every raw/derived PNG asset without deleting,
normalizing, or ignoring any clock or path field.
Synthetic/structural/resource tests need no third-party Python dependency; the one Poppler
self-compare remains automatically skipped when Poppler or the benchmark fixture is unavailable.

## Known limits

- Provenance is required and labelled `self_attested`, but no signed manifest authenticates it yet.
- Semantic evidence describes candidate placement, not reference-document object boundaries; metrics
  therefore answer “how does this candidate region compare at the same location?” rather than doing
  cross-document object matching.
- Equations and charts share the `object` category; subtype attribution remains future work.
- Paragraph regions are block bands. Text inside a table is diagnosed through the containing table
  region rather than duplicated as an independent text region.
- It does not mask dynamic regions; broad automatic masking would make missing content easier to hide.
- Poppler version and platform are recorded but not enforced by a baseline manifest yet.
- A non-POSIX platform cannot stop `pdftoppm` while it is writing an oversized file; it falls back to
  the documented post-write stat check.
- The output parent is checked before final rename but is not held by a directory file descriptor for
  the entire run; use a trusted local parent until that remaining TOCTOU hardening is implemented.

Those limits are reasons to keep this phase report-only, not reasons to weaken the existing layout
oracle.
