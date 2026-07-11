# @tf-hwp/react

React components for [tf-hwp](../../README.md): **open a `.hwp`/`.hwpx`, render every page to SVG, mark
cells/tables, chat-edit through your own server-side AI, and download HTML / PDF** — in one
`<HwpWorkspace/>` line, 100% client-side.

```tsx
import { HwpWorkspace, WasmAdapter } from "@tf-hwp/react";
import "@tf-hwp/react/styles.css";

const adapter = new WasmAdapter();

<HwpWorkspace
  adapter={adapter}
  document={{ bytes, name: "plan.hwpx" }}
  onAiRequest={serverSideAi}   // YOUR server returns Intents (R6 — no LLM in this package)
/>
```

- **Render / geometry / export** run in the browser via [`@tf-hwp/engine`](../engine) (wasm).
- **AI is delegated to the host** (`onAiRequest`) — this package holds **no LLM client and no API key**.
- **Every SVG is sanitized** before it touches the DOM (R7). There is no prop that injects raw SVG.
- **Fonts are injected, never bundled** (R8) — supply a TTF/OTF for PDF export.

## Install

```bash
npm i @tf-hwp/react @tf-hwp/engine react react-dom
```

`react` / `react-dom` are peer deps. `@tf-hwp/engine` ships the wasm; your bundler (Vite/webpack) must
serve its co-located `hwp_wasm_bg.wasm` (both resolve `new URL(..., import.meta.url)` out of the box).

## Headless core — this is a thin binding (issue 026)

All the editing *logic* — document lifecycle, undo, the OS-style selection model (click/⌘-toggle/marquee,
cell vs table vs block), Intent apply — lives in the framework-agnostic **[`@tf-hwp/editor-core`](../editor-core)**
(L2). `@tf-hwp/react` is a thin binding: `useHwpEditor(adapter)` mirrors the core's events into React
state, and the components render it. Nothing here is required to use tf-hwp.

- **Custom UI, still React:** call `useHwpEditor(adapter)` and draw your own toolbar/overlay/chat over
  `core.selection` / `core.session` / `core.edit`. `EngineAdapter`, `EditorCore`, `SelectionModel`,
  `DocSession`, `EditController` and all model/geometry/edit types are re-exported from `@tf-hwp/react`
  (or import them from `@tf-hwp/editor-core` directly).
- **No React at all:** drive `@tf-hwp/editor-core` directly — see its
  [`examples/vanilla.ts`](../editor-core/examples/vanilla.ts) (open → select → apply → undo → export,
  zero DOM).
- **LLM protocol:** the doc-context/prompt/whitelist live in **[`@tf-hwp/ai-protocol`](../ai-protocol)**
  (vendor-neutral, isomorphic); your server proxy and your client import the same module.

## Architecture — the `EngineAdapter` seam

The components speak to one interface, so the same UI runs against the wasm engine (web) or the desktop
app's Tauri commands (reference):

```ts
interface EngineAdapter {
  open(bytes, name?): Promise<OpenResult>;
  pageCount(): Promise<number>;
  pageSvg(page): Promise<string>;          // UNTRUSTED — the component sanitizes before injecting
  hitTest(page, x, y): Promise<BlockHit | null>;   // page-local px
  tableAt(page, x, y): Promise<TableBox | null>;   // page-local px
  applyIntent(intent): Promise<Outcome>;
  undo(): Promise<boolean>; redo(): Promise<boolean>;
  registerFont(family, bytes): Promise<void>;  hasFont(): boolean;
  exportPdf(): Promise<Uint8Array>;  exportHtml(): Promise<string>;  toHwpx(): Promise<Uint8Array>;
  dispose(): void;
}
```

- **`WasmAdapter`** wraps `@tf-hwp/engine`, incl. **wasm-trap recovery** (a Rust panic poisons the wasm
  instance — the adapter `resetEngine()`s + re-opens the document, then surfaces the trap so the UI can
  tell the user the last edit was rolled back). **Worker mode** (issue 055, FG-14):
  `new WasmAdapter(wasmUrl, { worker: { url: workerUrl } })` runs the WHOLE engine in a Web Worker —
  parse/re-layout/export/`toHwpx` leave the main thread; the adapter surface is unchanged. Deploy
  `@tf-hwp/engine`'s `worker.js` + `index.js` + `pkg/hwp_wasm.js` as static assets (relative paths
  kept — see the engine README) and pass that `worker.js` URL. The worker DYING is treated exactly
  like a trap (respawn + snapshot-first recovery); `dispose()` terminates the worker (this is also
  how a host cancels a long parse).
- **`TauriAdapter`** is a dependency-free reference (inject your own `invoke`); wiring the shipping
  desktop app to it is a follow-up.

## Components

| Component | Role |
|-----------|------|
| `HwpWorkspace` | The assembly — toolbar + page view + selection overlay + chat. Start here. |
| `HwpPageView` | Renders every page's SVG with zoom; **forces `sanitizeSvg`**; maps clicks → page px. |
| `SelectionOverlay` | Draws the cell/table/paragraph marking box (no batch-format toolbar in v1). |
| `ChatPanel` | Anchor chips + per-op preview cards (적용/취소) + `onAiRequest` delegation. |

### Manual editing (issue 027) — opt-in

Set `enableEditing` on `HwpWorkspace` to turn on the manual editing chrome (열너비 드래그 · 표 추가 ·
상단 룰러 · 더블클릭 텍스트 수정 · 선택 서식 툴바). Off by default — the workspace is chat-only unless
you ask for it, so existing hosts are unaffected.

```tsx
<HwpWorkspace adapter={adapter} document={doc} onAiRequest={onAiRequest} enableEditing />
```

Each feature is also an **individually importable** component driving a single
[editor-core](../editor-core) command — you can compose them WITHOUT `HwpWorkspace`:

| Component | editor-core command | Intent (schema v0) |
|-----------|---------------------|--------------------|
| `ColumnResizeOverlay` | `core.edit.setColumnWidths` | `SetTableColWidths` (px→ratio via `boundariesToRatios`) |
| `TableInsertButton` | `core.edit.insertTable` | `ApplyContent` (table block) |
| `Ruler` | `core.edit.setPageMargins` | `SetPageMargins` (mm — **document-wide**, confirm first) |
| `CellTextPopover` | `core.edit.editCellText` / `editParagraphText` | `SetTableCellRuns` / `SetParagraphRuns` (run styling preserved) |
| `FormatToolbar` | `core.edit.formatCellRange` / `shadeCellRange` | `SetCellRangeFmt` / `SetCellRangeShade` |

All px↔mm↔ratio conversion is the single `@tf-hwp/editor-core` `units` module (`pxToMm`/`mmToPx`/
`boundariesToRatios`/`resizeBoundary`); a text edit preserves the cell's run styling via `inheritRuns`.

```tsx
// Assemble the column-resize handles over YOUR OWN page surface, no HwpWorkspace:
import { ColumnResizeOverlay } from "@tf-hwp/react";
import { createEditorCore, boundariesToRatios } from "@tf-hwp/editor-core";

const core = createEditorCore(adapter);
const boundaries = await core.session.colBoundaries(page, section, block); // own-render px
<ColumnResizeOverlay
  boundaries={boundaries!}
  top={tableBox.y}
  height={tableBox.h}
  scale={renderedPx / viewBoxPx}
  onCommit={(next) => core.edit.setColumnWidths(section, block, boundariesToRatios(next))}
/>;
```

The desktop app's WYSIWYG contentEditable editor is intentionally out — the v1 text editor is a simple
textarea popover (IME-safe: no commit mid-composition).

## Server-side AI proxy (R6)

The package never calls an LLM. `onAiRequest(instruction, anchors, docContext)` is your bridge: POST to
**your** server, run the model there (your key), and return the [Intent](../../docs/INTENT-SCHEMA.md)
array to preview → apply.

```ts
// client
const onAiRequest: OnAiRequest = async (instruction, anchors, docContext) => {
  const res = await fetch("/api/hwp-edit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ instruction, anchors, docContext }),
  });
  if (!res.ok) throw new Error(`AI 서버 오류 ${res.status}`);
  return (await res.json()).intents; // Intent[] (schema v0)
};
```

```ts
// server (Express / Next route handler — YOUR API key lives here, never in the browser)
app.post("/api/hwp-edit", async (req, res) => {
  const { instruction, anchors, docContext } = req.body;
  const intents = await callYourModel({ instruction, anchors, docContext, apiKey: process.env.ANTHROPIC_API_KEY });
  res.json({ intents }); // e.g. [{ intent: "SetTableCell", section: 0, index: 1, row: 0, col: 0, text: "…" }]
});
```

Anchors carry **structure indices** (section/block/row/col) and the marked text — never pixels — so the
model edits exactly the marked spot. Returning `[]` means "no change".

## PDF export — inject a font (R8)

Hancom/함초롬 faces are not redistributable, so no font is bundled. Supply one via
`requestFont` (called when PDF is clicked and none is registered):

```tsx
<HwpWorkspace
  adapter={adapter}
  document={doc}
  onAiRequest={onAiRequest}
  requestFont={async () => {
    const bytes = new Uint8Array(await (await fetch("/fonts/NotoSansKR-Regular.ttf")).arrayBuffer());
    return { family: "Noto Sans KR", bytes }; // OFL — safe to self-serve. Single-face TTF/OTF (not TTC).
  }}
/>
```

Without a font (and no `requestFont`), the PDF button shows guidance instead of emitting empty glyphs.
The demo (`demo/`) offers a local `.ttf` picker + a Noto fetch fallback.

## Security (R7)

`adapter.pageSvg` returns a **document-derived** string. `HwpPageView` always runs it through
`sanitizeSvg` (strips `<script>`, `on*`, `javascript:`/`vbscript:` URLs, `<foreignObject>`, SMIL
`<animate>`/`<set>`, `data:image/svg+xml`) before the single `dangerouslySetInnerHTML`. No prop or API
lets an SVG string bypass that gate. Add a CSP as the second layer. See `src/__tests__/*.test.ts(x)`.

## Develop

```bash
npm run build       # ESM bundle (dist/index.js) + styles.css + .d.ts
npm run typecheck   # tsc --noEmit
npm test            # vitest (sanitize + mock flow)
npm run demo        # Vite dev server for demo/
```
