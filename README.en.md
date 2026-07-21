# tf-hwp

**A self-owned HWP/HWPX engine that runs in the browser** — open `.hwp`/`.hwpx`, render it
faithfully, edit it, and export HTML/PDF/HWPX. 100% client-side (WebAssembly), no server required.

[한국어](./README.md) · [Live demo](https://kwakseongjae.github.io/tf-hwp/) ·
[Embed guide](./docs/EMBED-GUIDE.md) · [Contributing](./CONTRIBUTING.md)

> HWP (Hangul Word Processor) is the de-facto standard document format for Korean government
> and enterprise paperwork — and notoriously hard to handle outside Hancom's own software.

```
.hwp / .hwpx ──▶ SemanticDoc (IR) ──▶ typesetter ──▶ SVG pages (screen · hit-testing)
                      │                          ├▶ PDF (layout-preserving, krilla)
                      │                          └▶ HTML (semantic reflow)
                      └── Intent JSON ──▶ Op ──▶ IR mutation (edit · undo/redo) ──▶ HWPX save
```

## Why

tf-hwp **owns the whole pipeline** — parse → typeset → render → edit → save — instead of
delegating rendering to external programs:

- **Accuracy locked by a gate** — page counts match Hancom's renderer exactly on real
  government-form benchmarks (8==8, 18==18) and line-break positions match 98.9%+;
  these are CI invariants, not aspirations.
- **Round-trip safe** — untouched content re-serializes byte-for-byte. Opening and
  saving a document never corrupts what you didn't edit.
- **Headless-first** — the engine has no UI. It returns SVG strings and export bytes;
  how you draw them is up to you. Build your own editor on top.

## Packages (npm)

| Package | Layer | Role |
|---|---|---|
| **`@tf-hwp/engine`** | L1 | **headless engine (wasm)** — parse · typeset · SVG/HTML/PDF/HWPX · Intent edits · undo. No UI |
| `@tf-hwp/editor-core` | L2 | headless editor state (selection/edit/session) — DOM-minimal, framework-free |
| `@tf-hwp/ai-protocol` | L2′ | vendor-neutral LLM protocol for vibe-editing (prompt/context/validate) — no fetch, no keys |
| `@tf-hwp/react` | L3 | **optional**: reference editor `<HwpWorkspace/>` + React bindings |

> Not yet published to the npm registry. Until then, consume `npm pack` tarballs following
> the recipe in `examples/vite-embed` (all four packages are publish-ready).

## Quick start ① — headless engine only (bring your own UI)

No React, no reference editor. The engine hands you SVG strings and bytes:

```js
import { initEngine, HwpDoc } from '@tf-hwp/engine';

await initEngine();                          // instantiate the wasm module once
const bytes = new Uint8Array(await file.arrayBuffer());
const doc = HwpDoc.open(bytes, file.name);   // .hwp / .hwpx auto-detected

// render — one SVG string per page; where and how to draw is yours
for (let p = 0; p < doc.pageCount(); p++) {
  container.insertAdjacentHTML('beforeend', doc.renderPageSvgSanitized(p));
}

// edit — Intent JSON (schema v0, docs/INTENT-SCHEMA.md)
doc.applyIntent({ intent: 'SetTableCell', section: 0, index: 1, row: 0, col: 0, text: 'value' });
doc.undo();

// export
const html = doc.exportHtml();               // semantic-reflow HTML
const pdf  = doc.exportPdf();                // layout-preserving PDF (Uint8Array)
const hwpx = doc.toHwpx();                   // round-trip-safe HWPX (Uint8Array)

doc.free();
```

Geometry queries (`hitTest`/`tableAt`/`blocksInRect`…) — 27 methods in total — are documented
as the [`EngineAdapter` contract](./packages/editor-core/src/adapter.ts), enough to build a
**fully custom editor** with click-selection, dragging and carets on top of the engine.
If you want a middle layer, use `@tf-hwp/editor-core` (selection model + edit controller,
framework-free).

## Quick start ② — reference editor (React)

```tsx
import { HwpWorkspace, WasmAdapter } from '@tf-hwp/react';
import '@tf-hwp/react/styles.css';

<HwpWorkspace
  adapter={adapter}                 // WasmAdapter (web) or your own adapter
  document={{ bytes, name }}
  enableEditing
  onAiRequest={myLlmBridge}         // optional vibe-editing — the LLM runs on YOUR server (BYOK)
/>
```

Full embed recipe (static wasm/worker serving, CSP, fonts, AI proxy):
[`docs/EMBED-GUIDE.md`](./docs/EMBED-GUIDE.md) · working example: [`examples/vite-embed`](./examples/vite-embed) ·
AI proxy example: [`examples/ai-proxy-express`](./examples/ai-proxy-express).

## Run the demo locally

```bash
git clone --recurse-submodules https://github.com/kwakseongjae/tf-hwp
cd tf-hwp

# build the engine wasm (Rust + wasm-bindgen — see CONTRIBUTING.md)
cargo build -p hwp-wasm --release --target wasm32-unknown-unknown
wasm-bindgen --target web --out-dir packages/engine/pkg target/wasm32-unknown-unknown/release/hwp_wasm.wasm

# demo app
cd apps/hwp-lab && npm install && npm run dev   # http://localhost:3000
```

For vibe-editing (AI), put `OPENROUTER_API_KEY` in `apps/hwp-lab/.env.local` — the key lives
only in the server route and never reaches the client bundle.

## Vibe editing (AI)

Click a cell/paragraph/table to anchor it, say "fill in this table", and the LLM returns
**Intent JSON** (a whitelisted schema) that the engine validates and applies.

- LLM calls always happen on **your server** (BYOK — no package in this repo ever sees an API key)
- model output touches the document only after schema validation + unknown-field rejection
- agentic mode: web search → cited evidence → streamed edit proposals

## Design note — what is canonical

The original plan was "HWP → XML (structure) + CSS (design) → the LLM picks which side to
edit". During implementation this pivoted to a **format-neutral IR (SemanticDoc) + typed
Intent edits** ([`docs/PIVOT-DESIGN.md`](./docs/PIVOT-DESIGN.md)):

- the render truth is **SemanticDoc → typeset → SVG** (comparable pixel-for-pixel with Hancom)
- the edit truth is **Intent JSON → Op → IR mutation** (schema-locked LLM output — more
  verifiable than free-form XML/CSS patches, with exact undo)
- the XML+CSS view survives as the optional [`hwp-jsx`](./crates/hwp-jsx) codec
  (JSX/CSS projection, round-trip-verified); HTML export descends from it

The goal — "the LLM detects whether to touch structure or design" — is intact; the medium
is typed Intents rather than XML/CSS text.

## Accuracy

| Benchmark | Hancom render | tf-hwp | Verdict |
|---|---|---|---|
| benchmark.hwp (gov form, 8pp) | 8 pages | 8 pages | ✅ match |
| benchmark1.hwp (application form, 18pp) | 18 pages | 18 pages | ✅ match |
| line-break position match | — | 98.9%+ | gate |

`scripts/verify-local.sh` enforces the gate on every commit. For lossy `.hwpx` conversions
(Hancom's own "save as .hwpx" collapses line spacing and row heights), a **layout-recovery**
mode detects the degradation fingerprint and restores an approximation of the original.

**Known limitations (honest disclosure)**
- **Equations & charts in PDF**: rendered for real on screen/HTML, but the PDF backend
  cannot vectorize them yet — they export as **placeholder boxes** (the app warns you
  before exporting). SVG→PDF vectorization is on the roadmap.
- **Password-protected `.hwp`**: not supported — refused honestly. (Distribution-DRM
  documents ARE decrypted — `hwp-crypto`.)
- **No binary `.hwp` re-save**: the save format is HWPX. Editing a `.hwp` also downloads
  as HWPX (untouched HWPX regions stay byte-identical).

## Rust crates (engine internals)

`hwp-model` (IR) · `hwp-hwpx` (HWPX codec) · `hwp-rhwp` (.hwp parse bootstrap,
[rhwp](https://github.com/kwakseongjae/rhwp) MIT) · `hwp-typeset` (kinsoku · width/letter
spacing · old Hangul) · `hwp-render` (PaintOp→SVG) · `hwp-export` (PDF/HTML) · `hwp-ops`
(op-bus · undo) · `hwp-mcp` (Intent schema) · `hwp-session` (geometry) · `hwp-wasm`
(bindings) · `hwp-crypto` (distribution-copy decryption) · `tf-hwp-cli` (CLI)

The CLI works standalone:

```bash
cargo run -p tf-hwp-cli --features rhwp -- own-render doc.hwp --out page.svg
cargo run -p tf-hwp-cli --features rhwp -- export-pdf doc.hwpx -o out.pdf
```

## License

MIT OR Apache-2.0 ([LICENSE-MIT](./LICENSE-MIT) / [LICENSE-APACHE](./LICENSE-APACHE)).
Third-party notices in [NOTICE](./NOTICE) — rhwp (MIT), Nanum fonts (OFL), and how the
GPL oracle is kept out-of-process.
