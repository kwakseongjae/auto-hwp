<p align="center"><img src="./assets/brand/autohwp-banner.png" alt="auto-hwp (오토한글) — an engine that works on Korean HWP documents directly" width="100%"></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@auto-hwp/react"><img src="https://img.shields.io/npm/v/@auto-hwp/react?logo=npm&label=%40auto-hwp%2Freact" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/@auto-hwp/react"><img src="https://img.shields.io/npm/dm/@auto-hwp/react?label=downloads%2Fmonth" alt="downloads per month"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/github/license/kwakseongjae/auto-hwp" alt="license"></a>
</p>

# auto-hwp (오토한글)

**An engine that works on Korean HWP/HWPX documents directly.** Open a file, render it faithfully,
change its structure, export to PDF/HTML/HWPX. Screen, AI and terminal all run on the **same engine**.
The engine itself has no server — it runs on the user's machine via WebAssembly, MCP and a CLI.
Only the live demo's optional AI editing calls a model provider through a separate proxy.

What this repo ships is an **engine and an SDK**. The demos below are a reference implementation
built on it, not the UI you are supposed to adopt — **you assemble the UI.**

[한국어](./README.md) · [Live demo](https://kwakseongjae.github.io/auto-hwp/) ·
[Benchmark](https://kwakseongjae.github.io/auto-hwp/bench/) · [Embed](./docs/EMBED-GUIDE.md) ·
[CLI](./docs/CLI-GUIDE.md) · [MCP](./docs/MCP-GUIDE.md) ·
[Bulk form filling](./docs/BULK-GUIDE.md) · [Contributing](./CONTRIBUTING.md)

<p align="center"><img src="./docs/assets/edit-loop.gif" alt="The live demo opening a sample document, marking a table, editing it in plain language, applying the proposal and heading to PDF export" width="960"></p>
<p align="center"><sub>The actual live demo (2026-07) — open a sample → mark a table → edit by talking → review the
proposal card → apply → up to the PDF export. The wait on the model's response is fast-forwarded.</sub></p>

## Wire it up in 60 seconds

```bash
npm i @auto-hwp/react                 # pulls in the engine (@auto-hwp/engine) + headless core
mkdir -p public/hwp && cp node_modules/@auto-hwp/engine/pkg/hwp_wasm_bg.wasm public/hwp/
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
  return res.json();                  // an array of validated edit commands (Intents)
};

export function Editor() {
  const adapter = useMemo(() => new WasmAdapter('/hwp/hwp_wasm_bg.wasm'), []);
  const [doc, setDoc] = useState<{ bytes: Uint8Array; name: string } | null>(null);

  return (
    <>
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
    </>
  );
}
```

That is the whole thing — open, typeset, render, manual editing and HTML/PDF/HWPX export all live
inside that component. Drop `sidePanel` and you get a bare editor with no panel (`onAiRequest` is
then never called). For the engine without React see [below](#npm-packages--engine-only); the full
per-bundler recipe (wasm serving, worker, CSP, fonts, AI proxy) is in
[`docs/EMBED-GUIDE.md`](./docs/EMBED-GUIDE.md).

## How it differs from the other open-source options

| | **auto-hwp** | rhwp | hwp.js |
|---|---|---|---|
| **License** | Apache-2.0 — free for commercial embedding, no seat or concurrency limits | MIT | Apache-2.0 |
| React-native SDK | `<HwpWorkspace/>` in `@auto-hwp/react` + a headless core (`@auto-hwp/editor-core`) | iframe-embedded web component (`@rhwp/editor`) | viewer/parser library (`hwp.js`) |
| Bulk form filling, finished | web + CLI (1 form + an N-row roster → N documents as a zip) | not found | not found |
| Chat-driven ("vibe") editing | 19 typed edit commands · preview cards before apply · per-card revert | not found | not found |
| Automated fidelity gate | page count + line-break match rate checked on every commit ([accuracy](#accuracy-and-limits)) | not found | not found |
| Distribution surface | npm · CLI · MCP server · Claude Code skill · web demo | browser extensions (Chrome/Edge/Firefox) · VS Code extension · npm · web demo | npm |
| Latest npm release | `@auto-hwp/engine` 0.0.3 (2026-07) | `@rhwp/core` 0.8.2 (2026-07) | `hwp.js` 0.0.3 (2020-10) |

<sub>As of 2026-07, from each project's public repository and npm registry metadata only. "Not found"
means we could not find it in public material — not that it is impossible. rhwp is also the upstream
auto-hwp bootstraps its `.hwp` parsing from ([NOTICE](./NOTICE)).</sub>

**Why now** — since 2026-05-18 local-government On-nara systems must also attach documents in an open
format (HWPX); central ministries have been on it since 2022
([ZDNet, in Korean](https://zdnet.co.kr/view/?no=20260512173412)). auto-hwp opens `.hwp` and `.hwpx`
into the same document model and saves as HWPX, and the window the AI reads (the doc profile) comes
out of the same engine that draws the page — though `.hwpx` **input** is still alpha (see
[Accuracy and limits](#accuracy-and-limits)).

## Try it on the web, no install

| Demo | What it does | Link |
|---|---|---|
| **Document editing** | Open a Korean document, edit it on screen, save as HTML/PDF/HWPX | [open](https://kwakseongjae.github.io/auto-hwp/) |
| **Bulk form filling** | 1 form + an N-row roster → N finished documents as a zip (rule-based, works with no AI) | [open](https://kwakseongjae.github.io/auto-hwp/bulk) · [guide](./docs/BULK-GUIDE.md) |

<p align="center"><img src="./docs/assets/bulk-studio-home.png" alt="Bulk form filling screen that turns one template and a roster into multiple HWPX documents" width="100%"></p>

The original file and all open/render/manual-edit/export operations stay in the browser (the file is
not uploaded). If you opt into **AI editing** in the live demo, your instruction plus the document
profile, body excerpt, table contents and selected context are sent through a Cloudflare Worker to
OpenRouter (GLM 5.2). The demo asks for consent before the first request and never uploads the whole file.
The demo currently accepts `.hwp` only — `.hwpx` input is in alpha.

## Why we built our own engine

The existing way to feed a Korean document to an LLM is **text extraction**. It works — and at that
moment the document splits in two: **what the AI read** (plain text) and **what a human sees** (the
typeset page) are different representations. So the AI cannot tell where "the blank cell in table 3"
is on screen, and nobody can guarantee its edit didn't break the layout. For government forms and
applications — where the layout *is* the content — that gap is fatal.

So we own the **engine**, not a parser and not a viewer. Open through save all run on **one document
model**:

```
.hwp / .hwpx ──▶ document model ──▶ typeset ──▶ SVG pages (screen · geometry queries)
                      │                      ├▶ PDF (layout-preserving)
                      │                      └▶ doc profile · Markdown (what the AI reads)
                      └── edit commands ──▶ document mutation (with undo) ──▶ HWPX save
```

Three things follow. ① **What the AI reads = what gets drawn** — a profile address like `[s0/b3]` is
the same coordinate as that block on screen, so "add a row to the first table" lands on the right
block with nothing marked. ② **Edits are whitelisted commands only** — the model emits validated edit
commands, never free-form patches. ③ **Results are verified in numbers** — page count and line-break
match rates are locked as CI gates (see [Accuracy](#accuracy-and-limits)).

## What the engine can do

| Capability | What you get | Engine API · CLI |
|---|---|---|
| **Open** | `.hwp` (HWP5) / `.hwpx` auto-detected → an editable document model. Distribution-DRM documents decrypted | `HwpDoc.open` · `auto-hwp info` |
| **Typeset** | Korean typesetting rules reimplemented (kinsoku, width/letter spacing, old Hangul), including pagination and row-level table splitting | `pageCount` · `auto-hwp layout-check` |
| **Render** | One SVG string per page. Where and how to draw it is up to the host | `renderPageSvgSanitized` · `auto-hwp own-render` |
| **Geometry queries** | Point → block/table/cell/glyph hit-testing, table column & row boundaries, caret rects, blocks in a rect | `hitTest` · `tableCellAt` · `caretRectCell` · `blocksInRect` |
| **Structured editing** | Fill cells/paragraphs, insert table/paragraph/chart/image, append rows, move/delete blocks, find & replace, char format, column widths, page margins — all typed edit commands (Intents), one undo unit each | `applyIntent` · `undo`/`redo` |
| **Document profile** | Title, outline, table inventory and body excerpt extracted deterministically (zero LLM calls) — the canonical AI context | `docProfile` · `auto-hwp ai-context` |
| **Table grid** | A table exposed as a grid of rows, columns, merges and text — the basis of form filling | `tableGrid` |
| **Export** | PDF (layout-preserving, Korean font embedded) · HTML (semantic reflow) · HWPX (untouched regions byte-identical) | `exportPdf`·`exportHtml`·`toHwpx` · `auto-hwp export-pdf`/`export-html` |
| **Font injection** | Register TTF/OTF bytes and typesetting, screen and PDF **all** switch to that face | `registerFont` |
| **Bulk form filling** | Form + field definitions + roster → N finished documents + a per-row validation report | `auto-hwp inspect`/`fill` · [guide](./docs/BULK-GUIDE.md) |

What is missing is explicit too — there are **no** commands for deleting table rows or
inserting/deleting columns (we leave that honestly empty).
The full command spec is [`docs/INTENT-SCHEMA.md`](./docs/INTENT-SCHEMA.md).

## Four ways to use it

| Way | When | Start |
|---|---|---|
| **npm embed** | Open, render and edit documents inside your own web app | `npm i @auto-hwp/engine` → [embed guide](./docs/EMBED-GUIDE.md) |
| **CLI** | Terminal, scripts, batch conversion, bulk form filling | `cargo install --git https://github.com/kwakseongjae/auto-hwp auto-hwp-cli --features rhwp,shaper,pdf` → [CLI guide](./docs/CLI-GUIDE.md) |
| **MCP server** | Permanently attached to Claude Code/Desktop or Cursor | `cargo install --git https://github.com/kwakseongjae/auto-hwp hwp-mcp --features rhwp` → [MCP guide](./docs/MCP-GUIDE.md) |
| **Claude Code skill** | "convert this hwp to pdf" in any session | `cp -r skills/hwp ~/.claude/skills/` → [skill definition](./skills/hwp/SKILL.md) |

CLI, MCP and the skill all run locally — documents never leave the machine.

## npm packages — engine only

| Package | Layer | Role |
|---|---|---|
| **`@auto-hwp/engine`** | L1 | **the engine (wasm)** — open · typeset · SVG/HTML/PDF/HWPX · edits · undo. No UI code |
| `@auto-hwp/editor-core` | L2 | headless editor state (selection/edit/session) — DOM-minimal, framework-free |
| `@auto-hwp/ai-protocol` | L2′ | AI editing protocol (prompt/context/validation) — no network calls, no keys |
| `@auto-hwp/react` | L3 | **optional**: reference editor `<HwpWorkspace/>` + React bindings |

No React, no reference editor required. The engine hands you SVG strings and bytes:

```js
import { initEngine, HwpDoc } from '@auto-hwp/engine';

await initEngine();                          // instantiate the wasm module once
const bytes = new Uint8Array(await file.arrayBuffer());
const doc = HwpDoc.open(bytes, file.name);   // .hwp / .hwpx auto-detected

// render — one SVG string per page; where and how to draw is yours
for (let p = 0; p < doc.pageCount(); p++) {
  container.insertAdjacentHTML('beforeend', doc.renderPageSvgSanitized(p));
}

// edit — edit commands (Intent) as JSON. Schema: docs/INTENT-SCHEMA.md
doc.applyIntent({ intent: 'SetTableCell', section: 0, index: 1, row: 0, col: 0, text: 'value' });
doc.undo();

// export
const html = doc.exportHtml();               // semantic-reflow HTML
const pdf  = doc.exportPdf();                // layout-preserving PDF (Uint8Array)
const hwpx = doc.toHwpx();                   // untouched regions stay byte-identical (Uint8Array)

doc.free();
```

Including the geometry queries, **34 methods** are documented as the
[`EngineAdapter` contract](./packages/editor-core/src/adapter.ts) — enough to build a
**fully custom editor** with click-selection, dragging and carets on top of the engine.
If you want a middle layer, use `@auto-hwp/editor-core` (selection model + edit controller,
framework-free). The full embed recipe (static wasm serving, CSP, fonts, AI proxy) is in
[`docs/EMBED-GUIDE.md`](./docs/EMBED-GUIDE.md), with a working example in
[`examples/vite-embed`](./examples/vite-embed).

## You assemble the UI

<p align="center"><img src="./docs/assets/composable-editor-shells.png" alt="One document engine composed with a right rail, bottom drawer, modal, or headless canvas" width="100%"></p>
<p align="center"><sub>One document engine, any product shell — use the defaults or bring only the layers you need.</sub></p>

Even the reference editor `<HwpWorkspace/>` owns only the **document surface** — pages, selection,
overlays, manual editing. The right-hand panel is a slot. Put a chat in it, a form, an inspector,
or nothing at all; that is the host's call.

```tsx
import { HwpWorkspace, WasmAdapter } from '@auto-hwp/react';
import '@auto-hwp/react/styles.css';

<HwpWorkspace
  adapter={adapter}                 // WasmAdapter (web) or your own adapter
  document={{ bytes, name }}
  enableEditing
  onAiRequest={myLlmBridge}         // the LLM runs on YOUR server (BYOK)
  sidePanel={(api) => <MyPanel {...api} />}   // the UI is yours
/>
```

You don't have to design one from scratch. `workspacePanel()` is our default UI — vibe editing plus a
design inspector — and you only pick the placement: `"rail"` (default), `"bottom"`, `"modal"` or
`"unstyled"`.

```tsx
import { workspacePanel } from '@auto-hwp/react';

<HwpWorkspace
  {...props}
  sidePanel={workspacePanel({ onAiRequest: myLlmBridge, presentation: 'bottom' })}
/>
```

To compose more freely, put your own form inside `WorkspacePanelFrame`, or return a React portal from
the slot to mount the panel on any DOM node outside the workspace. `WorkspacePanel`'s `tab` and `open`
work controlled or uncontrolled, so you can wire them to your router or shortcut state. Omit
`sidePanel` and you get a bare editor with no panel. In short: **engine → headless editor-core →
document surface → optional default shell**, taken only as deep as you need.

Everything the slot hands the host
([`WorkspaceSidePanel`](./packages/react/src/components/HwpWorkspace.tsx)):

| Value | What it is |
|---|---|
| `canEdit` | A document is open and editable (false → disable composing) |
| `anchors` | The positions the user has marked — the **same** `[s/b]` addresses the doc context uses |
| `modLabel` | Platform modifier caption (`⌘` / `Ctrl`) |
| `removeAnchor(i)` | Drop one marked position |
| `clearAnchors()` | Clear the whole selection |
| `docContext` | Document context for the AI bridge (doc profile + marked positions + table grids) |
| `apply(intents)` | Apply validated edit commands; resolves with how many landed |
| `jumpToPage(p)` | Scroll to a page (0-based) |
| `revealTarget(s, b)` | Scroll to a block and flash it (the "reveal target" affordance) |
| `focusToken` | Bumps when the host should focus its composer |
| `previewCards(intents)` | Enrich proposals for preview (e.g. a delete card showing the original text) |
| `revert()` | Revert the last applied batch as one unit |
| `undoDepth()` | Current undo-stack depth |
| `designSelection` | Kind, text, page, X/Y/W/H and character format of the current single selection |
| `applyDesign(patch)` | Apply only the format delta to the selection |
| `designFonts` | The font list a host inspector may offer |
| `textEditing` | The engine caret currently owns text input |

If you *do* want our reference panel, `workspacePanel({ onAiRequest })` mounts it in one line
([`packages/react/src/chatSlot.tsx`](./packages/react/src/chatSlot.tsx)) — but its Korean copy and
card layout are **a demo affordance, not a product contract**. Real products should render their own
panel.

## Editing with AI (edit commands)

Click a cell, paragraph or table to mark a position — or **just talk**. On open, the engine extracts
a **document profile** (title, structure counts, outline, table inventory, body excerpt) with zero
LLM calls and attaches it to every request, so "add a row to the first table" targets the right block
with nothing marked.

- The model may only emit **edit commands (Intent) as JSON** — of the engine's 41 Intents (open,
  query, edit and export combined), **19** edit commands are open to the AI (fill cells/paragraphs,
  insert table/paragraph/chart/image, append rows, move/delete blocks, find & replace, char format,
  column widths, page margins). Only what passes schema validation and unknown-field rejection
  reaches the document.
- Proposals preview as cards; **"reveal target"** shows you which block will change before you
  approve, and each card can be reverted on its own.
- LLM calls always happen on **your server** (BYOK — no package in this repo ever sees an API key).
- Agentic mode: web search → cited evidence → streamed edit proposals.

The protocol itself lives in `@auto-hwp/ai-protocol`, so you can wire the same contract up without
our chat UI.

## Accuracy and limits

| Benchmark | Hancom render | auto-hwp | Verdict |
|---|---|---|---|
| benchmark.hwp (gov form, 8pp) | 8 pages | 8 pages | match |
| benchmark1.hwp (application form, 18pp) | 18 pages | 18 pages | match |
| line-break position match | — | 98.9%+ | gate |

`scripts/verify-local.sh` enforces the gate on every commit. The public
[benchmark page](https://kwakseongjae.github.io/auto-hwp/bench/) lists every gate number and the
exact command that reproduces each of them. Beyond the gate, **49 real government
documents** (startup-program forms, notices, press releases — [sources](./corpus/GOV-SOURCES.md))
pass the full open → render → PDF → text pipeline. Measured at 130 pages, edit → screen is 136ms on a
worker thread (the UI never blocks), and undo memory is capped by a size-aware budget (128MiB). For
lossy `.hwpx` files (Hancom's own "save as" collapses line spacing and row heights) there is a
**layout-recovery** mode that detects the degradation and restores an approximation of the original.

**Known limitations (honest disclosure)**
- **Equations & charts in PDF**: rendered for real on screen and in HTML, but the PDF backend cannot
  vectorize them yet — they export as **placeholder boxes** (you are warned before exporting).
- **Password-protected `.hwp`**: not supported — refused honestly.
  (Distribution-DRM documents ARE decrypted.)
- **No binary `.hwp` re-save**: the save format is HWPX. Editing a `.hwp` also produces HWPX. With
  HWPX input, untouched regions stay byte-identical; with `.hwp` input the output is a **conversion**,
  so pagination and table widths can differ from the original.
- The page-count gate is measured on the benchmarks above — it is not a guarantee of an exact match
  on arbitrary documents.

## Fonts (all OFL — redistribution and PDF embedding are legal)

The default is Nanum Gothic / Nanum Myeongjo (serif vs. sans auto-distinguished). Pick one of the
8 catalog faces from the ribbon — **Pretendard, Noto Sans/Serif KR, IBM Plex Sans KR, Gowun
Dodum/Batang** and others — and it is loaded automatically and applied **for real on screen and in
the PDF**. Commercial faces such as Hancom's Hamchorom family are not bundled for licensing reasons
and are rendered with an OFL substitute (upload your own and it will be used).
→ [docs/FONT-CATALOG.md](./docs/FONT-CATALOG.md)

## For contributors — design note · crates · local build

The original plan was "HWP → XML (structure) + CSS (design) → the LLM picks which side to edit".
During implementation this pivoted to a **format-neutral IR (SemanticDoc) + typed Intent edits**
([`docs/PIVOT-DESIGN.md`](./docs/PIVOT-DESIGN.md) — a historical document):

- the render truth is **SemanticDoc → typeset → SVG** (comparable pixel-for-pixel with Hancom)
- the edit truth is **Intent JSON → Op → IR mutation** (schema-locked LLM output — more verifiable
  than free-form XML/CSS patches, with exact undo)
- the XML+CSS view survives as the optional [`hwp-jsx`](./crates/hwp-jsx) codec (JSX/CSS projection,
  round-trip-verified); HTML export descends from it

**Rust crates**: `hwp-model` (IR) · `hwp-hwpx` (HWPX codec) · `hwp-rhwp` (.hwp parse bootstrap,
[rhwp](https://github.com/kwakseongjae/rhwp) MIT) · `hwp-typeset` (kinsoku · width/letter spacing ·
old Hangul) · `hwp-render` (PaintOp→SVG) · `hwp-export` (PDF/HTML) · `hwp-ops` (op-bus · undo) ·
`hwp-mcp` (Intent schema) · `hwp-session` (geometry) · `hwp-wasm` (bindings) · `hwp-crypto`
(distribution-copy decryption) · `auto-hwp-cli` (CLI)

**Local build** (only if you are changing the engine — to just try it, the
[live demo](https://kwakseongjae.github.io/auto-hwp/) is enough):

```bash
git clone --recurse-submodules https://github.com/kwakseongjae/auto-hwp
cd auto-hwp

# build the engine wasm (Rust + wasm-bindgen — see CONTRIBUTING.md)
cargo build -p hwp-wasm --profile wasm-size --target wasm32-unknown-unknown
wasm-bindgen --target web --out-dir packages/engine/pkg target/wasm32-unknown-unknown/wasm-size/hwp_wasm.wasm

# demo app
cd apps/hwp-lab && npm install && npm run dev   # http://localhost:3000
```

To enable AI editing locally, put `OPENROUTER_API_KEY` in `apps/hwp-lab/.env.local` — the key lives
only in the server route and never reaches the client bundle. The verification suite, invariants and
contribution rules are in [CONTRIBUTING.md](./CONTRIBUTING.md) and [AGENTS.md](./AGENTS.md).

## License

Apache-2.0 ([LICENSE](./LICENSE)).
Third-party notices in [NOTICE](./NOTICE) — rhwp (MIT), Nanum fonts (OFL), and how the GPL oracle is
kept out-of-process.
