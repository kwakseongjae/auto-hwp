<p align="center"><img src="./assets/brand/autohwp-banner.png" alt="auto-hwp (오토한글) — an engine that works on Korean HWP documents directly" width="100%"></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@auto-hwp/react"><img src="https://img.shields.io/npm/v/@auto-hwp/react?style=flat-square&label=npm" alt="npm"></a>
  <a href="https://www.npmjs.com/package/@auto-hwp/react"><img src="https://img.shields.io/npm/dm/@auto-hwp/react?style=flat-square&label=downloads" alt="downloads"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/github/license/kwakseongjae/auto-hwp?style=flat-square&label=license" alt="license"></a>
</p>

# auto-hwp (오토한글)

An engine that opens, edits and exports Korean HWP/HWPX documents — in the browser and in the terminal.
There is no server: everything runs on the user's own machine.

[한국어](./README.md) · [Demo](https://kwakseongjae.github.io/auto-hwp/) · [Benchmark](https://kwakseongjae.github.io/auto-hwp/bench/) ·
[Embed](./docs/EMBED-GUIDE.en.md) · [CLI](./docs/CLI-GUIDE.md) · [MCP](./docs/MCP-GUIDE.md) ·
[Bulk form filling](./docs/BULK-GUIDE.md) · [Why](./docs/WHY.md#english) · [Contributing](./CONTRIBUTING.md)

<p align="center"><img src="./docs/assets/edit-loop.gif" alt="Opening a sample document, marking a table, editing it in plain language and exporting to PDF" width="960"></p>
<p align="center"><sub>The actual demo (2026-07) — open → mark a table → edit by talking → review the card → apply → PDF. The wait on the model's response is fast-forwarded.</sub></p>

## Try it

### Web — zero install

- **Document editing**: open a Korean document, edit it, save as HTML/PDF/HWPX → [open](https://kwakseongjae.github.io/auto-hwp/)
- **Bulk form filling**: 1 form + an N-row roster → N documents as a zip (rule-based, works with no AI) → [open](https://kwakseongjae.github.io/auto-hwp/bulk) · [guide](./docs/BULK-GUIDE.md)

The file never leaves the browser. Only if you **opt into AI editing** does your instruction plus the document
profile, body excerpt and table context go — after an explicit consent prompt — through a Cloudflare Worker
to OpenRouter (GPT-5.6 Luna); the file itself is never uploaded. The demo takes `.hwp` only.

### npm — 60 seconds

```bash
npm i @auto-hwp/react     # pulls in the engine (@auto-hwp/engine) + the headless core
```

```tsx
import { useMemo, useState } from 'react';
import { HwpWorkspace, WasmAdapter, workspacePanel, type HwpWorkspaceProps } from '@auto-hwp/react';
import '@auto-hwp/react/styles.css';

// The LLM call happens on YOUR server — no package in this repo ever sees an API key (BYOK).
const askAi: HwpWorkspaceProps['onAiRequest'] = async (instruction, anchors, docContext) => {
  const res = await fetch('/api/hwp-edit', {
    method: 'POST',
    body: JSON.stringify({ instruction, anchors, docContext }),
  });
  return res.json();                     // an array of validated edit commands (Intents)
};

export function Editor() {
  // No argument = the wasm is fetched from jsDelivr, pinned to the installed version (nothing to copy).
  const adapter = useMemo(() => new WasmAdapter(), []);
  const [doc, setDoc] = useState<{ bytes: Uint8Array; name: string } | null>(null);

  return (
    <div style={{ height: '100vh' }}>
      <input type="file" accept=".hwp,.hwpx" onChange={async (e) => {
        const f = e.currentTarget.files?.[0];
        if (f) setDoc({ bytes: new Uint8Array(await f.arrayBuffer()), name: f.name });
      }} />
      <HwpWorkspace
        adapter={adapter}
        document={doc}
        enableEditing
        onAiRequest={askAi}
        sidePanel={workspacePanel({ onAiRequest: askAi })}
      />
    </div>
  );
}
```

Open, typeset, render, manual editing and HTML/PDF/HWPX export all live inside that component. Drop
`sidePanel` and you get a bare editor with no panel (`onAiRequest` is then never called). Offline, on an
intranet or behind a strict CSP, serve the wasm yourself —
[EMBED-GUIDE §2.2](./docs/EMBED-GUIDE.en.md#22-override--self-host-the-static-files). See
[`examples/ai-proxy-express`](./examples/ai-proxy-express) and [`examples/vite-embed`](./examples/vite-embed).

### CLI

```bash
cargo install --git https://github.com/kwakseongjae/auto-hwp auto-hwp-cli --features rhwp,shaper,pdf
```

Conversion, layout checking and bulk form filling, all local → [CLI guide](./docs/CLI-GUIDE.md). To attach
it permanently to an editor use the [MCP server](./docs/MCP-GUIDE.md); for any Claude Code session there
is a [skill](./skills/hwp/SKILL.md).

## Frameworks

| Stack | What works today | Start |
|---|---|---|
| **React** | A finished UI, `<HwpWorkspace/>` — pages, selection, overlays, manual editing, panel slot | `@auto-hwp/react` → the quickstart above |
| **Vanilla · Svelte · Vue** | Engine + headless core. `@auto-hwp/editor-core` has **zero** React/DOM dependencies, so it binds to any framework — but you **assemble the UI yourself** | [`editor-core/examples/vanilla.ts`](./packages/editor-core/examples/vanilla.ts) (open→select→edit→undo→export, no React) |
| **Web-component wrapper** | Not available yet (roadmap) | — |

There are four packages — `@auto-hwp/engine` (the wasm engine) · `@auto-hwp/editor-core` (headless state) ·
`@auto-hwp/ai-protocol` (AI protocol, no network, no keys) · `@auto-hwp/react` (optional UI). With the
engine alone it is `HwpDoc.open` → `renderPageSvgSanitized` → `applyIntent` → `exportPdf`, and the **34
methods** including geometry queries are specified as the [`EngineAdapter`
contract](./packages/editor-core/src/adapter.ts) — enough to build a fully custom editor.

## What it can do

| Capability | What you get | API · CLI |
|---|---|---|
| **Open** | `.hwp` (HWP5) / `.hwpx` auto-detected → an editable document model. Distribution-DRM documents decrypted | `HwpDoc.open` · `auto-hwp info` |
| **Typeset** | Korean typesetting rules reimplemented (kinsoku, width/letter spacing, old Hangul), including pagination and row-level table splitting | `pageCount` · `auto-hwp layout-check` |
| **Render · geometry** | One SVG string per page, plus point → block/table/cell/glyph hit-testing and caret rects | `renderPageSvgSanitized` · `hitTest` · `tableCellAt` |
| **Structured editing** | Fill cells/paragraphs, insert table/paragraph/chart/image, append rows, move/delete blocks, find & replace, char format, column widths, page margins — all typed edit commands (Intents), one undo unit each | `applyIntent` · `undo`/`redo` |
| **Document profile** | Title, outline, table inventory and body excerpt extracted deterministically (zero LLM calls) — the canonical AI context | `docProfile` · `auto-hwp ai-context` |
| **Export** | PDF (layout-preserving, Korean font embedded) · HTML (semantic reflow) · HWPX (untouched regions byte-identical) | `exportPdf`·`exportHtml`·`toHwpx` |
| **Fonts** | Register TTF/OTF bytes and typesetting, screen and PDF all switch to that face. The 8 catalog faces are OFL (redistribution and PDF embedding are legal) | `registerFont` · [font catalog](./docs/FONT-CATALOG.md) |
| **Bulk form filling** | Form + field definitions + roster → N finished documents + a per-row validation report | `auto-hwp inspect`/`fill` · [guide](./docs/BULK-GUIDE.md) |

Only **19** of those edit commands are open to the AI, and only what passes schema validation reaches the
document — proposals preview as cards, "reveal target" shows the block before you approve, and each card
reverts on its own (an agentic mode adds web search with cited evidence). The protocol is
`@auto-hwp/ai-protocol`; the full spec is [INTENT-SCHEMA](./docs/INTENT-SCHEMA.md). What is missing is
explicit too — there are **no commands for deleting table rows or inserting/deleting columns**.

## How it differs from the other open-source options

| | **auto-hwp** | rhwp | hwp.js |
|---|---|---|---|
| **License** | Apache-2.0 — free for commercial embedding, no seat or concurrency limits | MIT | Apache-2.0 |
| React-native SDK | `<HwpWorkspace/>` in `@auto-hwp/react` + a headless core | iframe-embedded web component (`@rhwp/editor`) | viewer/parser library (`hwp.js`) |
| Bulk form filling, finished | web + CLI (1 form + an N-row roster → N documents as a zip) | not found | not found |
| Chat-driven ("vibe") editing | 19 typed edit commands · preview cards before apply · per-card revert | not found | not found |
| Automated fidelity gate | page count + line-break match rate checked on every commit ([accuracy](#accuracy-and-limits)) | not found | not found |
| Distribution surface | npm · CLI · MCP server · Claude Code skill · web demo | browser extensions · VS Code extension · npm · web demo | npm |
| Latest npm release | `@auto-hwp/engine` 0.0.3 (2026-07) | `@rhwp/core` 0.8.2 (2026-07) | `hwp.js` 0.0.3 (2020-10) |

<sub>As of 2026-07, from each project's public repository and npm registry metadata only. "Not found"
means we could not find it in public material — not that it is impossible. rhwp is also the upstream
auto-hwp bootstraps its `.hwp` parsing from ([NOTICE](./NOTICE)).</sub>

Since 2026-05-18 local-government On-nara systems must also attach documents in an open format (HWPX);
central ministries have been on it since 2022 ([ZDNet, in Korean](https://zdnet.co.kr/view/?no=20260512173412)).
auto-hwp opens `.hwp` and `.hwpx` into one document model and saves as HWPX — `.hwpx` **input** is still alpha.

## Accuracy and limits

| Gate | Hancom render | auto-hwp |
|---|---|---|
| benchmark.hwp (gov form) | 8 pages | 8 pages |
| benchmark1.hwp (application form) | 18 pages | 18 pages |
| line-break position match | — | 98.9%+ |
| 49 real government documents ([sources](./corpus/GOV-SOURCES.md)) | — | full open → render → PDF → text pipeline passes |

`scripts/verify-local.sh` enforces the gate on every commit, and every number plus the exact command that
reproduces it is published on the **[benchmark page](https://kwakseongjae.github.io/auto-hwp/bench/)**.
Measured at 130 pages, edit → screen is 136ms on a worker thread (the UI never blocks); undo memory is capped by a 128MiB budget.

**Known limitations**
- **Equations & charts in PDF**: drawn for real on screen and in HTML, but exported as **placeholder boxes** (you are warned before exporting).
- **Password-protected `.hwp`**: not supported — refused honestly (distribution-DRM decryption IS supported).
- **No binary `.hwp` re-save**: the save format is HWPX. With HWPX input, untouched regions stay
  byte-identical; with `.hwp` input the output is a **conversion**, so pagination and table widths can differ.
  (For lossy `.hwpx` — Hancom's own "save as" collapses line spacing and row heights — a **layout-recovery**
  mode detects the degradation and restores an approximation of the original.)
- The page-count gate is measured on the benchmarks above — not a guarantee for arbitrary documents.

## Documentation

| Doc | Contents |
|---|---|
| [EMBED-GUIDE](./docs/EMBED-GUIDE.en.md) | Per-bundler wasm/worker serving, self-hosting, CSP, fonts, AI proxy, the full panel-slot API |
| [CLI-GUIDE](./docs/CLI-GUIDE.md) · [MCP-GUIDE](./docs/MCP-GUIDE.md) | Terminal usage · permanent editor attachment |
| [BULK-GUIDE](./docs/BULK-GUIDE.md) · [INTENT-SCHEMA](./docs/INTENT-SCHEMA.md) | Bulk form filling (web · CLI) · the full edit-command spec |
| [BENCHMARK](./docs/BENCHMARK.md) · [FONT-CATALOG](./docs/FONT-CATALOG.md) | Gate numbers and how to reproduce them · the 8 bundled faces and their licenses |
| [WHY](./docs/WHY.md#english) | Why we built our own engine · the pipeline · design note · crate map · local build |
| [SDK-LAYERS](./docs/SDK-LAYERS.md) · [CONTRIBUTING](./CONTRIBUTING.md) | Layer contracts · verification suite and invariants |

## License · contributing

Apache-2.0 ([LICENSE](./LICENSE)). Third-party notices in [NOTICE](./NOTICE) — rhwp (MIT), Nanum fonts (OFL),
and how the GPL oracle is kept out-of-process. Contribution rules and the accuracy gates: [CONTRIBUTING.md](./CONTRIBUTING.md).
