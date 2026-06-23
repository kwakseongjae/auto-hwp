# Self-owned document engine — architecture decision + roadmap

Decided 2026-06-23 from a hard research workflow (6 streams + synthesis).

## North star
Upload `.hwp` / `.hwpx` / `.docx` / `.pdf` → parse into OUR IR (`SemanticDoc`, which preserves the
original faithfully and remembers the source extension) → render it faithfully with OUR engine
(looks like the original) → view + edit (content + design) → export **HTML + PDF**. React drives the
editing UI.

## Verdict — own engine, STAGED + HYBRID render
- **Edit surface = browser DOM/HTML** (the `hwp-jsx → hwp-export::emit_html` iframe): free
  caret/selection/**Korean IME**/accessibility — non-negotiable for a Korean-first editor.
- **Fidelity + export surface = our own renderer**: `hwp-typeset` (layout) → `PaintOp` →
  canvas/SVG. Independent of browser CSS quirks and of rhwp.
- **PDF = krilla** fed by `hwp-typeset`'s positioned/shaped glyphs ⇒ PDF == own-render, native Korean
  font embed/subset. No bundled Chromium. (Interim: OS webview print of `emit_html`.)
- Both surfaces **regenerate from the single IR** (`SemanticDoc`). **Never patch the render in place**
  — that (plus rhwp's broken edit/serialize) caused the "edited .hwp drops/overlaps content" bug.

## rhwp → PARSE-ONLY
rhwp is a reader/renderer; its edit/serialize is broken (Hancom-rejects). We were doing
`edited SemanticDoc → synthesize HWPX → rhwp re-render`, where rhwp drops the appended content.
Keep `hwp-rhwp::lift` (HWP5 ingest, ~95%) behind the feature gate; remove rhwp from render/edit/serialize.

## Format support (honest)
| format | level | why |
|---|---|---|
| HWPX | full content+design edit | the IR *is* HWPX-in-memory; near-lossless parse + dirty-only serialize |
| HWP5 (.hwp) | full edit | parse-only via rhwp lift; edit/render through our stack |
| DOCX | full-ish edit | text/tables/styles map; shapes/SmartArt/charts ride `Inline::Raw` (non-editable) |
| PDF | view + annotate/overlay | fixed-layout, no semantic structure; glyphs not paragraphs |

## The long pole
A **real shaper**: replace `ApproxFontMetrics` in `hwp-typeset` with rustybuzz/harfrust + real
per-script font metrics. Gates BOTH on-screen pixel fidelity AND faithful PDF. The paint IR
(`PaintOp`/`PageLayerTree`/`LineSeg`) already exists in `hwp-model/src/layout.rs` (scaffold;
`NullRenderer` in `hwp-render`). ~62% of the self-owned pipeline already exists (IR + `hwp-typeset`
98.9% line-break + `hwp-jsx`/`hwp-export`); blocked at shaper + paint ops.

## Roadmap
- **P0 — fix in-app HTML overlap** ✅ (commit 3d2c31c): emit line-height per `.pN` from `line_spacing`,
  reset cell-paragraph margins, content-height iframe. WKWebView now matches Blink.
- **P1 — demote rhwp to parse-only** (S): remove rhwp render/SVG/edit/serialize calls from the app;
  keep `lift` only; route all display through `emit_html` (and later the own-renderer). Kills the
  "synthesized HWPX → re-parse → dropped content" foot-gun.
- **P2 — real shaper behind `FontMetricsProvider`** (L): rustybuzz/harfrust + font metrics replacing
  `ApproxFontMetrics`; add 금칙(kinsoku) + 배분/나눔 justification + 자간/장평 advance to the same pass.
- **P3 — own renderer: fill the paint IR** (L): real `Renderer` (replace `NullRenderer` in
  `hwp-render`) walking `hwp-typeset` `LineSeg`s → `PaintOp::{Glyph,Rect,Image}` → `PageLayerTree`;
  SVG sink first (DOM hit-test + vector export for free), canvas sink if perf needs it.
- **P4 — PDF export via krilla** (M): feed shaped glyphs + page breaks; PDF == own-render.
- **P5 — DOCX + PDF ingest** (L): DOCX reader (EMU/twips→HWPUNIT, shapes→Raw); PDF reader
  (pdfium-render) → positioned glyphs for faithful view + overlay edits.

P0/P1 = days; the engine (P2+P3) = months. Reuse: hwp-model, hwp-hwpx, hwp-jsx, hwp-export, hwp-ops,
hwp-ai, hwp-fidelity (oracle), hwp-typeset. Build: hwp-render paint ops, shaper, docx/pdf readers,
krilla backend. Demote: hwp-rhwp → parse-only.
