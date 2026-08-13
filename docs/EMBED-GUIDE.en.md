# auto-hwp Web Embedding Guide (any host · npm packages)

> Korean original: [`EMBED-GUIDE.md`](EMBED-GUIDE.md). This is a translation of the **critical path** —
> install, load the engine, mount the workspace, CSP, AI proxy, fonts, verification. Sections that are
> purely repo-internal (Next.js quirks of the reference app) are summarized rather than translated.
>
> Audience: you want to open, render and edit Korean HWP/HWPX documents **inside your own web app**,
> on any stack (Vite/CRA/SvelteKit/static S3+CloudFront/Next). Everything runs in the browser: no
> server, no upload, no bundled fonts, no LLM keys in this package.
>
> Working examples verified in this repo:
> - [`examples/vite-embed`](../examples/vite-embed) — a minimal Vite app that installs the **published
>   packages** and renders `<HwpWorkspace/>`, plus a Playwright smoke (upload → 8-page render → cell
>   marking → mock edit → undo).
> - [`examples/ai-proxy-express`](../examples/ai-proxy-express) — a thin AI proxy (Express) for hosts
>   with no Next.js route handlers.

---

## 1. Install — four packages

```bash
npm i @auto-hwp/react @auto-hwp/engine @auto-hwp/editor-core @auto-hwp/ai-protocol
```

| Package | Layer | What it is |
|---|---|---|
| `@auto-hwp/engine` | L1 (wasm) | Parse · typeset (px) · render (SVG string) · apply Intents · undo · export. Zero fonts, zero LLM, zero keys. |
| `@auto-hwp/editor-core` | L2 (headless) | DocSession · SelectionModel · EditController. No React, no DOM. |
| `@auto-hwp/ai-protocol` | L2' (isomorphic) | EditRequest/Response · `buildDocContext` (prompt fencing) · validators. No fetch, no keys — shared by server and client. |
| `@auto-hwp/react` | L3 (UI) | `<HwpWorkspace/>` + overlays. Every piece is replaceable. `peerDependencies`: react/react-dom ≥18. |

`@auto-hwp/react` depends on `@auto-hwp/engine` and `@auto-hwp/editor-core` by real version (`^0.0.5`),
so a plain registry install resolves. `@auto-hwp/ai-protocol` is installed separately because your
server proxy imports the same module.

---

## 2. Loading the wasm / worker — CDN by default, self-hosting as the override

> The public stable release `0.0.5` includes the **CDN default, `onProgress`, and `prefetch()`** described
> here. `examples/vite-embed` deliberately keeps exercising the explicit self-hosted asset path too.

### 2.1 Default — copy nothing

Give `WasmAdapter` no URL and the engine fetches the wasm (and the worker script) from jsDelivr,
**pinned to the version of the engine package you installed**:

```
https://cdn.jsdelivr.net/npm/@auto-hwp/engine@<installed version>/pkg/hwp_wasm_bg.wasm
https://cdn.jsdelivr.net/npm/@auto-hwp/engine@<installed version>/worker.js
```

```tsx
const adapter = new WasmAdapter();                            // in-thread engine + CDN wasm
const adapter = new WasmAdapter(undefined, { worker: {} });   // worker engine + CDN worker.js/wasm
```

- **Never `@latest`.** The wasm-bindgen glue (JS) and the wasm binary are compiled together as **one
  artifact**. A mismatched pair either fails to link or — worse — links and then rejects newer Intents
  as `unknown variant`. So the pin is always *the version of the JS doing the loading*
  (`ENGINE_VERSION` in `packages/engine/cdn.js`; the publish hook hard-fails when it drifts from
  `package.json`).
- A **cross-origin worker script** cannot be passed to `new Worker(url)` (same-origin policy), so the
  client wraps it in a same-origin **blob shim** that `import`s the CDN module. Under a strict CSP you
  therefore need `worker-src blob:` (§4).
- Air-gapped / CDN-blocked deployments: go to §2.2. **The CDN is a default, not a requirement.**

Historical transfer baseline measured on 2026-07-30 for `@auto-hwp/engine@0.0.2`; the current feature
contract below targets stable `0.0.5`:

| | |
|---|---|
| jsDelivr `content-type` / CORS | `application/wasm` / `access-control-allow-origin: *`, `expose-headers: *` |
| Transfer size (brotli) | **2,962,776 B** (≈2.96 MB) |
| Uncompressed size | **7,718,539 B** (≈7.72 MB) |
| Self-hosted on GitHub Pages (gzip) | 3,145,131 B (Vite build report: gzip 3,151,674 B) |

### 2.2 Override — self-host the static files

When you cannot use a CDN (intranet, CSP, procurement) or want to pin the bytes yourself, pass explicit
URLs. Only then do you need to copy these files out of `node_modules/@auto-hwp/engine`, **keeping
the relative layout** (`examples/vite-embed/scripts/copy-assets.mjs` is exactly that script):

```
public/hwp/hwp_wasm_bg.wasm      ← node_modules/@auto-hwp/engine/pkg/hwp_wasm_bg.wasm  (fetched at runtime)
public/hwp/worker.js             ← node_modules/@auto-hwp/engine/worker.js             (module worker entry)
public/hwp/index.js              ← node_modules/@auto-hwp/engine/index.js              (imported by worker.js)
public/hwp/cdn.js                ← node_modules/@auto-hwp/engine/cdn.js                (current stable — imported by index.js)
public/hwp/pkg/hwp_wasm.js       ← node_modules/@auto-hwp/engine/pkg/hwp_wasm.js       (wasm-bindgen glue)
```

> ⚠️ **`cdn.js` is required by the current stable release**: `index.js` imports `./cdn.js`, so leaving it
> out kills the worker with a module-load 404. Keep the relative layout of all five files intact.

```tsx
const adapter = new WasmAdapter(
  new URL("/hwp/hwp_wasm_bg.wasm", window.location.origin),
  { worker: { url: new URL("/hwp/worker.js", window.location.origin) } },
);
```

> The relative import chain `worker.js → ./index.js → ./pkg/hwp_wasm.js` must survive the copy — keep
> the directory structure. On Vite, add `optimizeDeps.exclude: ["@auto-hwp/engine"]` so the worker and
> the glue are not pre-bundled by esbuild (they are loaded as static assets at runtime).
>
> **Harmless duplicate in Vite production builds:** `vite build` also emits the glue's built-in wasm
> reference (`new URL('..._bg.wasm', import.meta.url)`) as an asset (`dist/assets/hwp_wasm_bg-*.wasm`).
> At runtime only the URL you passed is fetched, so the copy is never loaded. Delete
> `dist/assets/*.wasm` after the build if you care about deploy size.

Prefer letting the bundler emit it? One line on Vite:

```ts
import wasmUrl from "@auto-hwp/engine/pkg/hwp_wasm_bg.wasm?url";
const adapter = new WasmAdapter(wasmUrl);   // worker mode still needs worker.js served statically
```

### 2.3 Progress + prefetch (stable 0.0.5)

The wasm is ~7.7 MB uncompressed (~3.0 MB over the wire), so the first load is visible. Two hooks:

```tsx
const adapter = new WasmAdapter(undefined, {
  onProgress: (p) => setPct(p.ratio == null ? null : Math.round(p.ratio * 100)),
});

// Warm it on the landing page while the user is still deciding — zero wait when they pick a file
useEffect(() => { requestIdleCallback(() => void adapter.prefetch()); }, [adapter]);
```

- `onProgress` measures the **download only** (there is no measurement point inside wasm compilation).
  A tick is `{loaded, total, ratio, done, estimated, url}`.
- ⚠️ **What `estimated` means.** When the response is brotli/gzip encoded, `Content-Length` counts
  **compressed** bytes while `response.body` yields **decompressed** ones — dividing them would report
  200%. So for encoded transfers the denominator is the published size (`WASM_BYTES`), `estimated` is
  `true`, and the ratio is never allowed to reach 1 before the stream actually ends. If you self-host a
  custom build, pass `expectedBytes` to supply the real denominator.
- `prefetch()` swallows failures and returns `false` — a warm-up must never break your app; the real
  error surfaces on the actual `open()`.
- Worker mode fires the same callback (progress is measured inside the worker and relayed as an
  id-less `{progress}` message).

### 2.4 Not supported yet (backlog)

- **Cloudflare Workers / edge runtimes** need initialization from a **bundled `WebAssembly.Module`**
  instead of `fetch` + `instantiateStreaming`. Today you wire that manually with
  `initEngineSync(module)`; a dedicated entry point (`@auto-hwp/engine/edge`) is future work — out of
  scope for the CDN-default change.
- The CDN default is **browser-only**. In Node, pass bytes or a compiled module instead of a URL.

---

## 3. Mount — `<HwpWorkspace/>`

```tsx
import { HwpWorkspace, WasmAdapter } from "@auto-hwp/react";
import "@auto-hwp/react/styles.css";               // side-effect CSS — import it once, manually

const adapter = new WasmAdapter();                  // 0.0.3+: CDN default (§2.1)

<HwpWorkspace
  adapter={adapter}
  document={{ bytes, name: "plan.hwpx" }}   // Uint8Array from an upload/drop
  onAiRequest={serverSideAi}                // your server returns Intents (§5)
  defaultFont={{ family: "Nanum Gothic", bytes: fontBytes }}  // fonts are injected, never bundled (§6)
  fontUrlBase="/fonts"
  enableEditing                             // opt-in manual editing chrome (ruler/column widths/format bar)
  sidePanel={(api) => <MyPanel {...api} />} // the right panel is YOURS (§3.1); omit for no panel
/>
```

Full wiring (file open, probe adapter, font fetch, mock AI) lives in
[`examples/vite-embed/src/App.tsx`](../examples/vite-embed/src/App.tsx).

### 3.1 `sidePanel` — the panel is composed by the host

`HwpWorkspace` owns **only the document surface**: pages, selection, overlays, manual editing. **There
is no chat view inside it.** The panel is a slot: you put a chat, a form, an inspector — or nothing.
The slot function receives a `WorkspaceSidePanel` object carrying the entire editing surface
(`canEdit`, `anchors`, `docContext`, `apply`, `jumpToPage`, `revealTarget`, `previewCards`, `revert`,
`undoDepth`, `designSelection`, `applyDesign`, `textEditing`, …), so you never reach inside the
workspace. Definition: `WorkspaceSidePanel` in
[`packages/react/src/components/HwpWorkspace.tsx`](../packages/react/src/components/HwpWorkspace.tsx).

Want our reference panel but a different placement?

```tsx
import { workspacePanel } from "@auto-hwp/react";

<HwpWorkspace {...props} sidePanel={workspacePanel({ onAiRequest, presentation: "bottom" })} />
// presentation: "rail" | "bottom" | "modal" | "unstyled"
```

Render `WorkspacePanel` directly to control `tab`/`onTabChange` and `open`/`onOpenChange` from your own
state; wrap arbitrary children in `WorkspacePanelFrame` to borrow only the layout. Because `sidePanel`
is an ordinary render prop, a React portal mounts the same API **outside** the workspace (a product
shell, a global modal root).

⚠️ Our reference panel is a **demo affordance, not a product contract** — the copy is Korean and the
card layout/interaction model are ours. Real products should draw their own panel against
`WorkspaceSidePanel` and take only the editing surface from this package. (SDK i18n — injectable
message catalogs — is tracked as issue 077.)

### `styles.css` is a manual import

`@auto-hwp/react` is not CSS-in-JS. `import "@auto-hwp/react/styles.css"` **once** or pages, overlays
and toolbars are unstyled. Classes are namespaced (`hw-*`), so they neither collide with your styles
nor resist overriding.

### `"use client"` and SSR

The components deliberately **do not** carry a `"use client"` directive (vendor-neutral — not every
bundler is RSC). Under React Server Components frameworks (Next App Router), put `"use client"` at the
top of *your* wrapper, or load it with `dynamic(() => import("./Workspace"), { ssr: false })`. The
engine uses `window`/`Worker`/`WebAssembly`, so **SSR must be off** in every framework.

---

## 4. CSP headers

```
script-src 'self' 'wasm-unsafe-eval';   # WebAssembly.instantiate ('unsafe-eval' for very old browsers)
worker-src 'self' blob:;                # module worker (the CDN default uses a blob shim → blob: required)
font-src   'self' data:;                # injected font @font-face
img-src    'self' data: blob:;          # image insert/preview
connect-src 'self' <your AI proxy origin>;
```

Using the CDN default (§2.1) adds two more — not needed when self-hosting (§2.2):

```
script-src  ... https://cdn.jsdelivr.net;   # index.js / pkg/hwp_wasm.js imported by the worker
connect-src ... https://cdn.jsdelivr.net;   # the wasm fetch
```

Rendered SVG is **untrusted, document-derived** output. `HwpPageView` always runs it through
`sanitizeSvg` before insertion (strips `<script>`, `on*`, `javascript:`). If you render it yourself,
call `sanitizeSvg` — always.

---

## 5. AI proxy (keys are server-only)

`@auto-hwp/react` holds no LLM and no keys. `onAiRequest(instruction, anchors, ctx)` delegates to
**your** server, which assembles prompt/fencing/validation with `@auto-hwp/ai-protocol` (the same
module on both sides, so the contract cannot drift). A thin server template for static/non-Next hosts:
[`examples/ai-proxy-express`](../examples/ai-proxy-express). Swapping vendors is the one
`import("@anthropic-ai/sdk")` line; with no key it falls back to a deterministic **mock** that still
completes the whole flow.

```ts
const onAiRequest = async (instruction, anchors, ctx) => {
  const res = await fetch("/api/hwp-edit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ instruction, anchors, docContext: buildDocContext(ctx, anchors) }),
  });
  return (await res.json()).intents ?? [];
};
```

---

## 6. Fonts — injected, never bundled

`@auto-hwp/engine` bundles **zero** fonts. Hand it one face with `defaultFont={{ family, bytes }}` and
the same bytes drive ① typesetting metrics ② the PDF embed ③ the on-screen `@font-face`. Exporting a
PDF with no font injected throws `{code:"font_missing"}` (never a silently blank glyph).

Serve **redistributable (OFL) fonts only** — Hancom/Hamchorom families have no redistribution license
(see [`docs/LICENSE-POLICY.md`](LICENSE-POLICY.md)).

On-demand catalog: pass `fontCatalog={FONT_CATALOG}` + `fontUrlBase` and serve the catalog files (8 OFL
families — Pretendard, Noto Sans/Serif KR, …; `scripts/fetch-fonts.mjs` downloads them). The workspace
then fetches → `registerFont` → injects `@font-face` automatically whenever the ribbon font picker or
the AI names a catalog family, and that family really lands on screen **and** in the PDF. Document-only
Korean family names still render through an OFL substitute.

---

## 7. Next.js note

The reference app pins `next` to **15.5.x**: the workaround that prevents duplicate wasm emission lives
in a `webpack()` hook (`parser.url = false` on `hwp_wasm.js`), and Next 16's Turbopack ignores that
hook. Non-Next hosts (Vite etc.) never hit this — the assets are static files there. Details:
[`INTEGRATION-HANDOVER.md §3`](INTEGRATION-HANDOVER.md).

---

## 8. Verifying the embed (as run in this repo)

The examples install the **registry** packages by default — the same path an outside user takes. Add
`REPO_DEV=1` to overlay the repo's local builds (`packages/*` are packed and installed with
`--no-save`, so `package.json` keeps its registry declaration and `npm install` restores it).

```bash
cd examples/vite-embed
npm install              # registry @auto-hwp/* ^0.0.5 (fresh-clone path)
npm run dev              # predev copies wasm/worker/fonts into public/ (self-hosted path)
npm run test:e2e         # Playwright: upload → 8-page SVG → cell marking → mock edit → undo

REPO_DEV=1 npm run dev   # try unpublished changes in the example
npm run use-local        # force the local tarballs without REPO_DEV
```
