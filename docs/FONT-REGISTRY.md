# Deterministic font registry (schema v1)

The own renderer and PDF exporter accept the same explicit font bytes. Deterministic mode does not
scan system directories, fetch fonts, upload document fonts, or redistribute proprietary Hancom/HCR/
Malgun/Human faces. A user may supply a lawfully obtained local face; the repository fixture uses
only the bundled Nanum OFL assets.

Use the public six-face regular/bold/gothic/serif alias fixture:

```bash
auto-hwp export-pdf corpus/hwpx/footnote-01.hwpx \
  --font-registry corpus/font-registry/ofl-registry-v1.json \
  --font-report font-realization.json -o out.pdf
```

The manifest is strict JSON: `schema_version` must be `1`; unknown fields fail. Every face declares
`family`, `style` (`regular`, `bold`, `italic`, or `bold-italic`), a local `path`, a pinned lowercase or
uppercase `sha256`, and optional integer `face_index` (currently only `0`). The shell rejects symlinks,
non-regular files, collections, malformed/unsupported containers, duplicate normalized family/style,
hash mismatch, and configured face/per-face/total byte limit violations before opening the document or
writing export artifacts.

The report contains only a registry fingerprint, face count, requested typographic category/style,
`exact`/`fallback`/`unavailable` status, selected face SHA-256, and glyph count. It contains no document
text, family name, font/document path, or raw bytes. `fallback` is an explicit OFL substitution, never
an exact-fidelity claim. A missing lane is zero usage; an `unavailable` lane means requested glyphs had
no realizable face.

`scripts/document-visual-check.mjs --font-registry …` forwards the generated registry fingerprint to
the #213 report automatically and rejects a conflicting manual candidate fingerprint.
