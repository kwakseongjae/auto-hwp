<p align="center"><img src="./assets/brand/autohwp-hero.png" alt="auto-hwp (오토한글) — an engine for Korean HWP documents and a web editor on top of it" width="100%"></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@auto-hwp/react"><img src="https://img.shields.io/npm/v/@auto-hwp/react?style=flat-square&label=npm" alt="npm"></a>
  <a href="https://www.npmjs.com/package/@auto-hwp/react"><img src="https://img.shields.io/npm/dm/@auto-hwp/react?style=flat-square&label=downloads" alt="downloads"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/github/license/kwakseongjae/auto-hwp?style=flat-square&label=license" alt="license"></a>
</p>

# auto-hwp (오토한글)

An **engine** that opens Korean HWP/HWPX documents, and a **web editor** built on top of it.
You build it yourself instead of handing documents to somebody else's service — the same core runs
as wasm in the browser or on your own server (a laptop, an intranet box).

**Try** — [demo](https://autohwp.com/) · [bulk form filling](https://autohwp.com/bulk) · [benchmark](https://autohwp.com/bench)<br>
**Integrate** — [embed](./docs/EMBED-GUIDE.en.md) · [self-host](./docs/SELF-HOST.md) · [CLI](./docs/CLI-GUIDE.md) · [MCP](./docs/MCP-GUIDE.md)<br>
**Read** — [why](./docs/WHY.md#english) · [handing this repo to an LLM](./docs/LLM-GUIDE.md) · [contributing](./CONTRIBUTING.md) · [한국어](./README.md)

## Try it

| Video | What you are watching |
|---|---|
| <img src="./docs/assets/guide-engine.gif" alt="Opening a Korean document, rendering it and exporting to PDF" width="380"> | **Engine** — open a Korean file, draw it faithfully on screen, export to PDF/HTML/HWPX. This path involves no AI at all. |
| <img src="./docs/assets/guide-vibe.gif" alt="Marking a table, editing it in plain language, reviewing the card and applying" width="380"> | **Vibe editing** — mark what to change, say it in plain language, and the proposal shows up as a card first. Only approved cards touch the document, and each reverts on its own. |
| <img src="./docs/assets/guide-bulk.gif" alt="Feeding one form and a roster to produce many finished documents at once" width="380"> | **Bulk form filling** — one form plus an N-row roster produces N finished documents as a zip. It is rule-based, so it works with no AI. |

### Our hosted demo — zero install (autohwp.com)

- **Document editing**: open a Korean document, edit it, save as HTML/PDF/HWPX → [open](https://autohwp.com/)
- **Bulk form filling**: 1 form + an N-row roster → N documents as a zip → [open](https://autohwp.com/bulk) · [guide](./docs/BULK-GUIDE.md)

The file never leaves the browser. Only if you **opt into AI editing** does your instruction plus the document profile, body
excerpt and table context go — after an explicit consent prompt — through our demo server to OpenRouter (GPT-5.6 Luna);
the file itself is never uploaded. That AI is **a trial we pay for**, so it has per-day and per-IP caps, and the demo takes
`.hwp` only. In a product, put your own proxy there — see below.

## Adding it to your own product

### Hand this to your coding agent

Paste the request below into Codex, Claude Code, Cursor, or another coding agent. The
[canonical agent prompt](./docs/launch/AGENT-PROMPT.md) carries the full checklist so the agent starts from the site docs,
pins the public stable release, preserves the local-processing boundary, and runs a real-file smoke test.

```text
Integrate auto-hwp into this project. First read https://autohwp.com/llms.txt,
https://autohwp.com/docs/llm, and https://autohwp.com/docs/embed; do not guess undocumented APIs.
Finish the no-AI local document path first, then verify opening, editing, and exporting a real HWP/HWPX file.
```

### npm — 60 seconds

```bash
npm i @auto-hwp/react@0.0.4 @auto-hwp/ai-protocol@0.0.4
# react pulls in the engine + headless core; the BYOK bridge below imports ai-protocol directly
```

```tsx
import { useMemo, useState } from 'react';
import { HwpWorkspace, WasmAdapter, workspacePanel, type HwpWorkspaceProps } from '@auto-hwp/react';
import { buildDocContext } from '@auto-hwp/ai-protocol';
import '@auto-hwp/react/styles.css';

// The LLM call happens on YOUR server — no package in this repo ever sees an API key (BYOK).
const askAi: HwpWorkspaceProps['onAiRequest'] = async (instruction, anchors, context) => {
  const res = await fetch('/api/hwp-edit', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      instruction,
      anchors,
      docContext: buildDocContext(context, anchors), // keeps document data inside the R5 fence
    }),
  });
  const data = await res.json();
  return data.intents ?? [];             // HwpWorkspace requires an Intent[]
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

Open, typeset, render, manual editing and HTML/PDF/HWPX export all live inside that component. Drop `sidePanel` and you
get a bare editor with no panel (`onAiRequest` is then never called). Offline, on an intranet or behind a strict CSP,
serve the wasm yourself — [EMBED-GUIDE §2.2](./docs/EMBED-GUIDE.en.md#22-override--self-host-the-static-files). A working app: [`examples/vite-embed`](./examples/vite-embed).

### The AI call goes through your own server (BYOK)

The `/api/hwp-edit` that `askAi` calls above is not ours — it is a server you run. Which model it reaches for, where the key
sits and how logs and rate limits are handled are all settled inside it, and our trial proxy never appears on that path.
Nothing here has to be written from scratch: [`examples/ai-proxy-express`](./examples/ai-proxy-express) is a thin server you
can copy as-is, and the prompt, the validation rules and the allowed-command list live in one place inside
`@auto-hwp/ai-protocol`, shared with the client — so the server and the screen can never drift onto different rules. If the
engine itself has to sit on your own infrastructure, [SELF-HOST](./docs/SELF-HOST.md) walks through both routes, Docker and Node/Bun.

### CLI

```bash
cargo install --git https://github.com/kwakseongjae/auto-hwp auto-hwp-cli --features rhwp,shaper,pdf
```

Conversion, layout checking and bulk form filling, all local → [CLI guide](./docs/CLI-GUIDE.md). To attach it permanently to an
editor use the [MCP server](./docs/MCP-GUIDE.md); for any Claude Code session there is a [skill](./skills/hwp/SKILL.md).

## Frameworks — what is React here and what is not

The engine (`@auto-hwp/engine`) and the headless core (`@auto-hwp/editor-core`) are **framework-agnostic JS/wasm** — they reference
neither React nor the DOM. `@auto-hwp/react` is a **React editor component library** built on top of them: something you `import`
into your React app, not a reason to build a React app in order to use auto-hwp. Other frameworks can bind to the engine + core
today; what we have not finished for them is the **ready-made UI, which exists for React only**.

| Stack | What works today | Start |
|---|---|---|
| **React** | A finished UI, `<HwpWorkspace/>` — pages, selection, overlays, manual editing, panel slot | `@auto-hwp/react` → the quickstart above |
| **Vanilla · Svelte · Vue** | Full capability through the engine + headless core — you only assemble the UI | [`editor-core/examples/vanilla.ts`](./packages/editor-core/examples/vanilla.ts) (open→select→edit→undo→export, no React) |
| **Web-component wrapper** | Not available yet (roadmap) | — |

There are four packages — `@auto-hwp/engine` (the wasm engine) · `@auto-hwp/editor-core` (headless state) ·
`@auto-hwp/ai-protocol` (AI protocol, no network, no keys) · `@auto-hwp/react` (optional UI). With the engine alone it is
`HwpDoc.open` → `renderPageSvgSanitized` → `applyIntent` → `exportPdf`, and the **34 methods** including geometry queries
are specified as the [`EngineAdapter` contract](./packages/editor-core/src/adapter.ts) — enough to build a custom editor.

## What you can do with auto-hwp

| Task | What you get | API · CLI |
|---|---|---|
| **Open** | `.hwp` (HWP5) and `.hwpx` are detected automatically and turned into an editable document model. Distribution (DRM) copies are decrypted too | `HwpDoc.open` · `auto-hwp info` |
| **Typeset** | Korean typesetting rules reimplemented — kinsoku, glyph width and letter spacing, old Hangul. When a page fills up, tables are split at row granularity and continued | `pageCount` · `auto-hwp layout-check` |
| **Render** | One SVG per page, and a way back: which block, table, cell or glyph a point on screen belongs to (caret rects included) | `renderPageSvgSanitized` · `hitTest` · `tableCellAt` |
| **Edit** | Fill cells and paragraphs, insert tables, paragraphs, charts and images, append rows, move and delete blocks, find and replace, character format, column widths, page margins — every one a typed edit command (Intent) and one undo step | `applyIntent` · `undo`/`redo` |
| **Doc&nbsp;profile** | Title, outline, table inventory and body excerpt extracted deterministically with zero LLM calls — the canonical context the AI reads | `docProfile` · `auto-hwp ai-context` |
| **Export** | PDF preserves the layout and embeds Korean faces, HTML reflows as semantic markup, and HWPX keeps untouched regions byte-identical | `exportPdf`·`exportHtml`·`toHwpx` |
| **Fonts** | Register a TTF/OTF and typesetting, screen and PDF all switch to that face at once. The 8 catalog faces are OFL, so redistribution and PDF embedding are legal | `registerFont` · [font catalog](./docs/FONT-CATALOG.md) |
| **Bulk&nbsp;fill** | A form, its field definitions and a roster produce N finished documents plus a per-row validation report | `auto-hwp inspect`/`fill` · [guide](./docs/BULK-GUIDE.md) |

Only **19** of those edit commands are open to the AI, and only what passes schema validation reaches the document — proposals
preview as cards, "reveal target" shows the block before you approve, and each card reverts on its own (an agentic mode adds web
search with cited evidence). The protocol is `@auto-hwp/ai-protocol`; the full spec is [INTENT-SCHEMA](./docs/INTENT-SCHEMA.md).
We are equally explicit about what is missing — there are still **no commands for deleting table rows or inserting/deleting columns**.

## The philosophy behind auto-hwp

The existing way to hand a Korean document to an LLM is **text extraction**. It works — and at that moment the document splits
in two: what the AI read (plain text) and what a human sees (the typeset page) become different representations. The AI cannot
tell where "the blank cell in table 3" is on screen, and nobody can guarantee its edit did not break the layout. For government
forms and applications, where the layout *is* the content, that gap is fatal.

So we decided to own the **engine** — not a parser, not a viewer. Open through save all run on **one document model**.

```
.hwp / .hwpx ──▶ document model ──▶ typeset ──▶ SVG pages (screen · geometry queries)
                      │                      ├▶ PDF (layout-preserving)
                      │                      └▶ doc profile · Markdown (what the AI reads)
                      └── edit commands ──▶ document mutation (with undo) ──▶ HWPX save
```

With one model, **what the AI reads is what gets drawn**. A profile address like `[s0/b3]` is the same coordinate as that block
on screen, so "add a row to the first table" lands on the right block with nothing marked up. And the model emits **validated
edit commands only**, never free-form text — which structurally removes the ways a document could break unpredictably.

That leaves one question: is the typesetting actually the same as Hancom's? Claims do not settle it, so we **locked it in numbers**
— page counts and line-break match rates are checked on every commit, and nothing merges if they regress ([accuracy and
limits](#accuracy-and-limits)).

Finally, what this repository ships is an engine and an SDK, **not a UI**. The demos are a reference implementation, and even the
reference editor owns only the document surface — the right-hand panel is a slot, so put a chat in it, a form, or nothing at all.
The longer version is in [WHY](./docs/WHY.md#english).

## How it differs from the other open-source options

| | **auto-hwp** | rhwp | hwp.js |
|---|---|---|---|
| **License** | Apache-2.0 — free for commercial embedding, no seat or concurrency limits | MIT | Apache-2.0 |
| React-native SDK | `<HwpWorkspace/>` in `@auto-hwp/react` + a headless core | iframe-embedded web component (`@rhwp/editor`) | viewer/parser library (`hwp.js`) |
| Bulk form filling, finished | web + CLI (1 form + an N-row roster → N documents as a zip) | not found | not found |
| Chat-driven ("vibe") editing | 19 typed edit commands · preview cards before apply · per-card revert | not found | not found |
| Automated fidelity gate | page count + line-break match rate checked on every commit ([accuracy](#accuracy-and-limits)) | not found | not found |
| Distribution surface | npm · CLI · MCP server · Claude Code skill · web demo | browser extensions · VS Code extension · npm · web demo | npm |
| Latest npm release | `@auto-hwp/engine` 0.0.4 (2026-07) | `@rhwp/core` 0.8.2 (2026-07) | `hwp.js` 0.0.3 (2020-10) |

<sub>As of 2026-07, from each project's public repository and npm registry metadata only. "Not found" means we could not
find it in public material — not that it is impossible. rhwp is also the upstream auto-hwp bootstraps its `.hwp` parsing
from ([credits](#license--credits)).</sub>

Since 2026-05-18 local-government On-nara systems must also attach documents in an open format (HWPX); central ministries
have been on it since 2022 ([ZDNet, in Korean](https://zdnet.co.kr/view/?no=20260512173412)). auto-hwp opens `.hwp` and
`.hwpx` into one document model and saves as HWPX — `.hwpx` **input** is still alpha.

## Accuracy and limits

| Gate | Hancom render | auto-hwp |
|---|---|---|
| benchmark.hwp (gov form) | 8 pages | 8 pages |
| benchmark1.hwp (application form) | 18 pages | 18 pages |
| line-break position match | — | 98.9%+ |
| 49 real government documents ([sources](./corpus/GOV-SOURCES.md)) | — | full open → render → PDF → text pipeline passes |

`scripts/verify-local.sh` enforces the gate on every commit, and every number plus the exact command that reproduces it is
published on the **[benchmark page](https://autohwp.com/bench)**. Measured at 130 pages, edit → screen
is 136ms on a worker thread (the UI never blocks); undo memory is capped by a 128MiB budget.

**What comes out** — the outputs are **HTML, PDF and HWPX**; nothing is ever written back into `.hwp`. The loop is
`.hwp → (edit) → HTML/PDF/HWPX`, not `.hwp → .hwp`. Verifying what a plain-language instruction actually changed means
everything from open to export has to sit on one document model, and writing that model back into a closed binary is where
that verification holds up worst — so we left it out from the start.

**Known limitations**
- **Equations & charts in PDF**: drawn for real on screen and in HTML, but exported as **placeholder boxes** (you are warned before exporting).
- **Password-protected `.hwp`**: not supported — refused honestly (distribution-DRM decryption IS supported).
- **Output from `.hwp` input is a conversion**: with HWPX input, untouched regions stay byte-identical; a document that came
  from `.hwp` can differ in pagination and table widths. (For lossy `.hwpx` — Hancom's own "save as" collapses line spacing
  and row heights — a **layout-recovery** mode detects it and restores an approximation.)
- The page-count gate is measured on the benchmarks above — not a guarantee for arbitrary documents.

## Documentation

| Doc | Contents |
|---|---|
| [EMBED-GUIDE](./docs/EMBED-GUIDE.en.md) · [SELF-HOST](./docs/SELF-HOST.md) | Per-bundler wasm/worker serving, CSP, fonts, the full panel-slot API · running the engine on your own infrastructure (Docker · Node/Bun) |
| [CLI-GUIDE](./docs/CLI-GUIDE.md) · [MCP-GUIDE](./docs/MCP-GUIDE.md) | Terminal usage · permanent editor attachment |
| [BULK-GUIDE](./docs/BULK-GUIDE.md) · [INTENT-SCHEMA](./docs/INTENT-SCHEMA.md) | Bulk form filling (web · CLI) · the full edit-command spec |
| [LLM-GUIDE](./docs/LLM-GUIDE.md) · [llms.txt](./llms.txt) | What to give an LLM or coding agent first when you hand it this repo |
| [BENCHMARK](./docs/BENCHMARK.md) · [FONT-CATALOG](./docs/FONT-CATALOG.md) | Gate numbers and how to reproduce them · the 8 bundled faces and their licenses |
| [WHY](./docs/WHY.md#english) | Why we built our own engine · the pipeline · design note · crate map · local build |
| [SDK-LAYERS](./docs/SDK-LAYERS.md) · [CONTRIBUTING](./CONTRIBUTING.md) | Layer contracts · verification suite and invariants · running the benchmarks locally and contributing results |

## License · credits

**Apache-2.0** ([LICENSE](./LICENSE)) — embed it in a commercial product with no fees, no seat counts, no concurrency limits.

This project stands on work that came before it.

- **[rhwp](https://github.com/edwardkim/rhwp)** (MIT) — the upstream for binary `.hwp` parsing, and the inspiration that got this engine started. We use it as a parse bootstrap and a layout reference; rendering always happens from our own IR.
- **Nanum Gothic · Nanum Myeongjo** (OFL, NAVER) — the default screen and PDF faces. All 8 catalog faces are OFL, so redistribution and embedding are legal.
- **LibreOffice + H2Orestart** (GPL) — invoked strictly **out-of-process** as a fidelity oracle. No GPL code is linked into
  the binaries or npm packages we distribute.
- **Publicly distributed government forms and format-conformance documents** — the basis of our parser and typesetter regression tests.

Full notices in [NOTICE](./NOTICE); contribution rules and the accuracy gates in [CONTRIBUTING.md](./CONTRIBUTING.md).
