# @tf-hwp/editor-core

Headless, **framework-agnostic** editor core for [tf-hwp](../../README.md) — the L2 of the
[SDK layers](../../docs/SDK-LAYERS.md). It owns the editor's *state and commands* (document lifecycle,
selection, edit/apply, undo, font) and **nothing about the UI**: zero React, zero DOM, unit-testable in
plain node. Bring your own rendering (or none). This is the TipTap/ProseMirror "headless" pattern for
HWP/HWPX.

```ts
import { createEditorCore } from "@tf-hwp/editor-core";

const core = createEditorCore(adapter); // adapter = WasmAdapter (web) / TauriAdapter (app) / your own
core.selection.onChange((sels) => console.log(sels.length, "selected"));

await core.session.open(bytes, "plan.hwpx");
await core.selection.pointerDown({ page: 0, x: 100, y: 100, mod: false }); // page-local px
await core.selection.pointerUp();
const intents = await myServerAi("이 칸을 채워줘", core.selection.getAnchors(), core.edit.docContext());
await core.edit.apply(intents); // one undo batch; consumed selection cleared
await core.session.undo();
```

## What's inside (and what is NOT)

| Piece | Role |
|-------|------|
| `DocSession` | open / page count / **undo·redo batches** / register font / `docContext(anchors)`. Emits `onDocChange` + `onLayoutInvalidated`. |
| `SelectionModel` | OS-style selection (issues 021 + 023): click = replace, ⌘/Ctrl-click = toggle, empty-space drag = marquee, ⌘-marquee = union, cell > table > block anchoring. Emits `onChange` + `onMarqueeChange`. |
| `EditController` | assemble the read-only `DocContext`, `preview(intents)` cards, `apply(intents)` as one undo batch. |
| `EngineAdapter` | the backend seam (open/pageSvg/geometry/applyIntent/undo/export/registerFont). |

**Not here** (SDK-LAYERS "하지 않는 것"): React/DOM (that's `@tf-hwp/react`), the LLM/keys (that's your
server + `@tf-hwp/ai-protocol`), the wasm engine (that's `@tf-hwp/engine`). The client-px → page-px
coordinate conversion stays in the UI layer; `SelectionModel` receives **page-local px only**
(`pointerDown({page,x,y,mod})`), so it is testable without a layout engine.

## Coordinate contract

`SelectionModel` inputs are already own-render **PAGE px** (= HWPUNIT/75). A `PointerInput` may carry an
optional raw `client` point used ONLY to measure the zoom-independent 4px drag threshold; omit it in
node tests and the threshold falls back to page px.

## Using it without React

See [`examples/vanilla.ts`](./examples/vanilla.ts) — a complete open → select cell → apply AI intent →
undo → export flow driven directly against the core with a mock adapter, and no framework at all.
`examples/vanilla.test.ts` runs it in node (the "custom freedom" proof).

## Develop

```bash
npm run build       # tsc → dist (JS + .d.ts)
npm run typecheck   # tsc --noEmit
npm test            # vitest (node env — NO jsdom): selection scenarios + session + vanilla example
```
