# @tf-hwp/engine

The tf-hwp document engine compiled to WebAssembly — **open `.hwp`/`.hwpx` in the browser, render
every page to SVG, edit via Intent JSON, and export HTML / PDF / HWPX**, entirely client-side. No
LLM, no filesystem, no bundled fonts.

- **Edit lane** = `hwp-mcp` (Intent JSON schema v0): `applyIntent` / `undo` / `redo`, `toHwpx`.
- **Render / geometry / export lane** = `hwp-session`: `renderPageSvg`, `hitTest`, `tableAt`,
  `exportHtml`, `exportPdf`.
- The AI stays on the host **server** (R6): run your model server-side and apply the resulting Intent
  JSON here. This package never sees an API key.

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
| `registerFont(family, bytes)` | `void` | required before `exportPdf` (R8). |
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
const pdf = doc.exportPdf();
```

`exportPdf()` throws `{code:"font_missing"}` if no font was registered (never silently emits empty
glyphs).

> **Known limitation (this build):** the underlying PDF backend (`hwp-export` → krilla) still discovers
> its embedded face from `std::fs` paths, which do not exist on wasm — so today the exported PDF has
> **faithful geometry but stub-box glyphs** on wasm. Threading the injected bytes into krilla needs a
> `font bytes` parameter on `hwp-export::pdf::export_pdf` (out of this package's "pure consumer" scope).
> `registerFont` already stores the bytes for the day that parameter lands.

## Bundle size

`pkg/hwp_wasm_bg.wasm` is ~11 MiB raw / ~3.5 MiB gzipped (no fonts). The bulk is the HWP5 (`.hwp`)
binary parser (rhwp) + the krilla PDF stack. An HWPX-only build (drop the crate's default `hwp5`
feature) is ~4.6 MiB raw / ~1.4 MiB gzipped. Run `wasm-opt -Oz` (binaryen) on the artifact to shrink
further; it was not available in the build environment.
