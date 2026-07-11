# @tf-hwp/engine

The tf-hwp document engine compiled to WebAssembly — **open `.hwp`/`.hwpx` in the browser, render
every page to SVG, edit via Intent JSON, and export HTML / PDF / HWPX**, entirely client-side. No
LLM, no filesystem, no bundled fonts.

- **Edit lane** = `hwp-mcp` (Intent JSON schema v0): `applyIntent` / `undo` / `redo`, `toHwpx`.
- **Render / geometry / export lane** = `hwp-session`: `renderPageSvg`, `hitTest`, `tableAt`,
  `exportHtml`, `exportPdf`.
- The AI stays on the host **server** (R6): run your model server-side and apply the resulting Intent
  JSON here. This package never sees an API key.

## Where this sits in the SDK (layer map)

This wasm engine is **L1** — the headless engine (parse/layout/render/geometry/Intent/undo/export). It
knows only the document; it has no UI and no selection state. See [`docs/SDK-LAYERS.md`](../../docs/SDK-LAYERS.md).

```
L4 host app (apps/hwp-lab, Tauri, your app) — supplies the LLM proxy (its key) + assembles a UI
L3 @tf-hwp/react        — optional React binding (useHwpEditor + components); all replaceable
L2 @tf-hwp/editor-core  — headless editor (DocSession/SelectionModel/EditController) over an EngineAdapter
L2' @tf-hwp/ai-protocol — vendor-neutral LLM protocol (prompt/context/validate); no fetch, no keys
L1 @tf-hwp/engine (this) / hwp-mcp — headless engine; state is the document only
```

A `WasmAdapter` (in `@tf-hwp/react`) wraps this package to satisfy L2's `EngineAdapter` contract, so the
same editor-core drives the web (wasm) and a desktop app (Tauri) alike.

## Install & quick start

```js
import { initEngine, HwpDoc } from '@tf-hwp/engine';

await initEngine();                      // instantiate the wasm module once
const bytes = new Uint8Array(await file.arrayBuffer());
const doc = HwpDoc.open(bytes, file.name); // .hwp or .hwpx (auto-detected)

const pages = doc.pageCount();
for (let p = 0; p < pages; p++) {
  container.insertAdjacentHTML('beforeend', doc.renderPageSvgSanitized(p)); // sanitized SVG — see R7
}

// edit: fill a table cell (Intent schema v0)
doc.applyIntent({ intent: 'SetTableCell', section: 0, index: 1, row: 0, col: 0, text: '셀 값' });
doc.undo();

const html = doc.exportHtml();
const hwpx = doc.toHwpx();                // Uint8Array — hand to a download

doc.free();                              // free the wasm allocation on swap (R13)
```

## API

| Method | Returns | Notes |
|--------|---------|-------|
| `initEngine(input?)` | `Promise` | Instantiate once (idempotent). |
| `HwpDoc.open(bytes, name?)` | `HwpDoc` | `.hwp` (needs the default rhwp build) or `.hwpx`. |
| `pageCount()` | `number` | Own-render pagination. |
| `renderPageSvg(n)` | `string` | **UNTRUSTED** — see Security. |
| `renderPageSvgSanitized(n)` | `string` | `sanitizeSvg` applied. |
| `hitTest(page, x, y)` | `BlockHit \| null` | own-render **px** coords. |
| `tableAt(page, x, y)` | `TableBox \| null` | own-render **px** coords (marking). |
| `applyIntent(intent)` | `Outcome` | object or JSON string; Intent schema v0. |
| `undo()` / `redo()` | `boolean` | graceful no-op when empty. |
| `registerFont(family, bytes)` | `void` | drives metrics **and** PDF; **re-layouts** (re-query `pageCount`). |
| `exportPdf()` | `Uint8Array` | throws `{code:"font_missing"}` if none. |
| `exportHtml()` | `string` | self-contained HTML. |
| `toHwpx()` | `Uint8Array` | round-trip-safe HWPX. |
| `free()` | `void` | idempotent; frees the wasm handle. |

Coordinates for `hitTest`/`tableAt` are **own-render px** (= HWPUNIT / 96). Edit Intents address the
model in **structure indices** (section/block/row/col), never pixels.

## ⚠️ wasm panic recovery (required reading)

A Rust panic on `wasm32` is a **trap**: it poisons the entire instance. `catch_unwind`-style guards do
not work on wasm, so a malicious/corrupt document that panics the parser kills the wasm instance — but
**not your page**. This wrapper contains it:

- Every call is `try/catch`ed. A `WebAssembly.RuntimeError` throws an `Error` with `code === "wasm_trap"`
  and marks **all** live `HwpDoc` handles dead.
- **Recovery protocol:** on a `wasm_trap`, call `resetEngine()` to re-instantiate the module, then
  re-`open()` your document. Unsaved document state is lost — converge on a "reopen this file" UX.

```js
try {
  doc.applyIntent(intent);
} catch (e) {
  if (e.code === 'wasm_trap') {
    await resetEngine();       // fresh instance
    doc = HwpDoc.open(bytes, name); // re-open; previous handles are dead
  } else {
    throw e;                   // ordinary {code, message} engine error
  }
}
```

A `FinalizationRegistry` frees handles the host forgets to `free()`, but **explicit `free()` on document
swap is the contract** (undo snapshots + original bytes are held per document — R13).

## Run the engine in a Web Worker (issue 055, FG-14)

Parsing / re-layout / `toHwpx` on a multi-MB document blocks the thread they run on. This package
ships a **module-worker entry** (`worker.js`) plus a main-thread RPC client
(`@tf-hwp/engine/worker-client`) so the whole engine can live off the main thread — no
SharedArrayBuffer, no COOP/COEP headers, no bundler magic. Deploy `worker.js`, `index.js` and
`pkg/hwp_wasm.js` as static assets **keeping their relative paths** (the worker imports `./index.js`
which imports `./pkg/hwp_wasm.js`), then:

```js
import { EngineWorkerClient } from '@tf-hwp/engine/worker-client';

const client = new EngineWorkerClient({ url: '/hwp/worker.js' });   // {type:"module"} worker
await client.init('/hwp/hwp_wasm_bg.wasm');                          // instantiate wasm IN the worker
const { pages } = await client.open(bytes, file.name);               // parse off-thread
const svg = await client.call('renderPageSvg', [0]);                 // every HwpDoc method, awaited
```

Error codes across the boundary: `wasm_trap` (instance poisoned inside the worker → `client.reset()`
then re-`open`), `worker_dead` (the worker itself died → the next `init()`/`reset()` respawns),
`worker_terminated` (the host called `terminate()` — an intentional cancel, not a crash). Ordinary
engine errors (`no_document`, `font_missing`, …) pass through unchanged. `@tf-hwp/react`'s
`WasmAdapter` wires all of this (including 052 snapshot-first recovery) behind
`new WasmAdapter(wasmUrl, { worker: { url: workerUrl } })`.

## ⚠️ Security — SVG is untrusted (R7)

`renderPageSvg` returns a document-derived string. **Never** `innerHTML` it raw. Use
`renderPageSvgSanitized(n)` or `sanitizeSvg(svg)` (strips `<script>`, `on*`, `<foreignObject>`,
`javascript:` URLs). This is the minimum guard; full hardening + CSP is a host concern (issue 016).

## Fonts are injected, never bundled (R8)

This package ships **no fonts** (redistributing Hancom/함초롬 faces is not permitted; see
`docs/LICENSE-POLICY.md`). For PDF export you must inject a face first:

```js
const font = new Uint8Array(await (await fetch('/fonts/NotoSansKR-Regular.ttf')).arrayBuffer());
doc.registerFont('Noto Sans KR', font);   // OFL — safe to serve yourself
const pdf = doc.exportPdf();              // real, subsetted Korean glyphs embedded
```

`exportPdf()` throws `{code:"font_missing"}` if no font was registered (never silently emits empty
glyphs).

**Font bytes must be a single-face TTF/OTF** — a TTC (TrueType Collection) is **not** accepted: it
throws `{code:"ttc_unsupported"}` (krilla's `simple-text` backend can't subset a collection, and the
shaper takes face index 0 only). The injected bytes thread all the way through to krilla (issue 018):
the first parseable registered face becomes the PDF body face, so the exported PDF embeds a **real
subset of your Korean glyphs**.

### Registering a font re-layouts the document (issue 022)

`registerFont` now feeds the injected face into the **layout metrics** as well as the PDF embed — the
same bytes shape screen SVG, pagination *and* PDF, so all three agree. Until you register a font,
render/layout use a deterministic per-script **Approx** fallback (no font file needed). Because real
metrics differ from Approx, **registering (or replacing) a font can change the page count and line
breaks**, so:

```js
doc.registerFont('Nanum Gothic', font); // → re-layouts; internal SVG cache invalidated
const pages = doc.pageCount();           // re-query — may differ from before
for (let i = 0; i < pages; i++) render(doc.renderPageSvgSanitized(i)); // re-render every page
```

v1 maps **every** document font name to this one injected face (register the face you want the body
drawn in); document-level per-family mapping is a follow-up.

## Bundle size

`pkg/hwp_wasm_bg.wasm` is ~11 MiB raw / ~3.5 MiB gzipped (no fonts). The bulk is the HWP5 (`.hwp`)
binary parser (rhwp) + the krilla PDF stack. An HWPX-only build (drop the crate's default `hwp5`
feature) is ~4.6 MiB raw / ~1.4 MiB gzipped. Run `wasm-opt -Oz` (binaryen) on the artifact to shrink
further; it was not available in the build environment.
