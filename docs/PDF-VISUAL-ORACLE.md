# PDF visual oracle (report-only V0/V1)

This document describes the bounded report-only foundation in GitHub issue #121, under the broader
#93 visual-oracle track. It compares a PDF already exported by auto-hwp's own engine with an
explicitly classified PDF reference. It does **not** render HWP/HWPX itself, infer that a nearby PDF
is ground truth, or decide pass/fail.
Current reports use `schema_version: 3`; non-finite values are rejected rather than emitted as
non-standard JSON `NaN`/`Infinity` tokens.

The existing stored-lineseg `layout-check` remains the fast layout regression gate. This visual report
is additive and does not replace or relax it.

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

First export the candidate with our PDF path. Binary `.hwp` additionally needs the `rhwp` parser
feature; this does not make rhwp the renderer.

```bash
cargo run -p auto-hwp-cli --features pdf,shaper,rhwp -- \
  export-pdf benchmarks/benchmark.hwp -o /tmp/benchmark-own.pdf
```

Then compare that explicit candidate with a reference. The output directory must not already exist.
The report is built in a sibling staging directory and renamed into place only after JSON, HTML, and
all assets succeed, so a failed run does not leave a partial report that blocks retry.

```bash
python3 scripts/pdf-visual-check.py /tmp/benchmark-own.pdf \
  --reference benchmarks/benchmark.pdf \
  --reference-tier T1 \
  --reference-product "official publication PDF" \
  --reference-build "recorded by fixture manifest" \
  --reference-os "recorded by fixture manifest" \
  --font-fingerprint "sha256:..." \
  --candidate-font-fingerprint "sha256:..." \
  --reference-note "Pair identity verified by document owner" \
  --output-dir /tmp/benchmark-visual-report
```

Open `/tmp/benchmark-visual-report/index.html` locally. Machine-readable results are in
`report.json`; stable PNG assets are under `assets/`.

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

Future slices may add semantic text/table/image/equation/chart regions from `PageLayerTree`; these
fixed tiles do not claim to identify object types.

## Visual report

For every dimension-compatible page, `index.html` shows:

- reference raster;
- raw candidate raster;
- translated-only candidate raster;
- overlay, with reference-only ink red and candidate-only ink blue;
- absolute grayscale-difference heatmap;
- a metric table and the complete page JSON.

The summary lists up to five lowest-ink-F1 pages and five lowest-recall worst tiles. These are
diagnostic rankings only, not acceptance decisions. HTML has no remote scripts, fonts, or network
dependencies.

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

The current CLI computes hashes but does not yet consume a signed fixture manifest. Issue #101 owns
the ≥20-pair T0/T1 calibration and reviewed-manifest work: source/reference hash, Hancom
product/build, OS, export method, font-file hashes, and redistribution authority. A sibling `.pdf`
alone must never be promoted to T0 or T1.

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
| 03 | 4 → 6 | `structural_mismatch` | — | — | table/cell flow collapse; #95 |
| 04 | 3 → 3 | `structural_mismatch` | — | — | final page portrait vs official landscape; #96 |
| 05 | 9 → 9 | `scored_report` | 0.074480 | 0.257094 | page count alone hides large visual drift |

All three scored documents had worst-tile recall `0.0`. This run proves that the structure-first
stage and local-region alarm expose failures that a page-count or white-background-dominated score
would miss. It does **not** provide enough samples to define an acceptance threshold.

## Tests

Run the dependency-free synthetic metric and PNG codec suite with:

```bash
python3 scripts/tests/test_pdf_visual_check.py -v
```

The suite covers exact identity, bounded translation, clipped-ink penalties, translation overflow,
missing small foreground, blank/unscorable semantics, missing-all-ink loss, 2 px edge tolerance,
white padding without resampling, PNG round-trips, A4 tolerance, and structural mismatches. It also
exercises valid/different CropBoxes, `-cropbox` page rendering, input/page/pixel/raster/decompression,
ink/alignment/edge-work, derived-asset, and report-total limits; subprocess output caps, timeouts,
and POSIX file-size caps;
T0/T1 provenance, path redaction, forced `0700`/`0600` modes under umask `000` and `022`, secure
symlink rejection, finite box/rotation validation, resource-exhaustion conversion,
structural-before-raster orchestration, complete unscorable HTML/JSON output, and atomic failure.
When Poppler and
`benchmarks/benchmark.pdf` are present, it rasterizes the first page and performs an exact
self-compare; otherwise that integration case is skipped.

The standard-library suite is wired into `scripts/verify-local.sh` and the required GitHub
`build-test` job through `unittest discover`. It includes a two-run whole-report determinism check
covering the raw byte-identical `report.json`, HTML, and every raw/derived PNG asset without deleting,
normalizing, or ignoring any clock or path field.
Synthetic/structural/resource tests need no third-party Python dependency; the one Poppler
self-compare remains automatically skipped when Poppler or the benchmark fixture is unavailable.

## Known first-slice limits

- Inputs are PDF files; reference manifests are not yet parsed.
- Provenance is required and labelled `self_attested`, but no signed manifest authenticates it yet.
- The script assumes the caller already produced the candidate through `export-pdf`.
- It does not yet compare own SVG against own PDF from the same `PageLayerTree`.
- It cannot yet count text/table/image/equation/chart objects or PDF replay/stub events; issue #102
  owns object accounting and SVG/PDF replay/sink parity.
- It does not mask dynamic regions; broad automatic masking would make missing content easier to hide.
- It does not address the known PDF `PaintOp::Image.svg` equation/chart stub. Instead, the current
  image/tile diagnostics make that loss visible while the renderer fix proceeds separately.
- Poppler version and platform are recorded but not enforced by a baseline manifest yet.
- A non-POSIX platform cannot stop `pdftoppm` while it is writing an oversized file; it falls back to
  the documented post-write stat check.
- The output parent is checked before final rename but is not held by a directory file descriptor for
  the entire run; use a trusted local parent until that remaining TOCTOU hardening is implemented.

Those limits are reasons to keep this phase report-only, not reasons to weaken the existing layout
oracle.
