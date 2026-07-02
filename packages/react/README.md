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
  tell the user the last edit was rolled back).
- **`TauriAdapter`** is a dependency-free reference (inject your own `invoke`); wiring the shipping
  desktop app to it is a follow-up.

## Components

| Component | Role |
|-----------|------|
| `HwpWorkspace` | The assembly — toolbar + page view + selection overlay + chat. Start here. |
| `HwpPageView` | Renders every page's SVG with zoom; **forces `sanitizeSvg`**; maps clicks → page px. |
| `SelectionOverlay` | Draws the cell/table/paragraph marking box (no batch-format toolbar in v1). |
| `ChatPanel` | Anchor chips + per-op preview cards (적용/취소) + `onAiRequest` delegation. |

v1 scope is **chat editing only** — the desktop app's WYSIWYG in-place editor is intentionally out.

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
