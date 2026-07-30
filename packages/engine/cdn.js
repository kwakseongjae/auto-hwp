// @auto-hwp/engine — WHERE the wasm/worker assets come from by default (W6.1, Monaco 패턴).
//
// Until 0.0.2 an embedder had to copy FOUR files (wasm + worker.js + index.js + pkg/hwp_wasm.js) into
// its own static root and hand the URLs to the adapter. That is still supported — it is now the
// OVERRIDE, not the entry price. With no explicit URL the loader falls back to jsDelivr, pinned to
// THIS package's own version:
//
//   https://cdn.jsdelivr.net/npm/@auto-hwp/engine@<ENGINE_VERSION>/pkg/hwp_wasm_bg.wasm
//
// ⚠️ NEVER `@latest`. The wasm-bindgen glue (pkg/hwp_wasm.js) and the wasm binary are ONE artifact
// compiled together: a mismatched pair fails to link, or — worse — links and rejects new Intents as
// "unknown variant" (the repo's 스테일 wasm 함정, institutionalized). Pinning to the version of the
// JS that is doing the loading is the whole point; a floating tag would guarantee the mismatch.
//
// This module is deliberately DEPENDENCY-FREE and does NOT import the wasm-bindgen glue, so
// worker-client.js (main thread) can read the default worker URL without pulling ~360 KB of glue into
// the main bundle.

/** The version this build of the JS ships with — the CDN pin. Kept in lockstep with package.json by
 *  `scripts/build-wasm.mjs` (the prepack hook), which fails the pack when the two disagree. */
export const ENGINE_VERSION = '0.0.4';

/** UNCOMPRESSED size of `pkg/hwp_wasm_bg.wasm` as published in ENGINE_VERSION (measured: jsDelivr
 *  0.0.2 with `Accept-Encoding: identity` → 7,718,539 B; brotli over the wire → 2,962,776 B).
 *  Used ONLY as the progress denominator when the transfer is content-encoded — a compressed response
 *  reports the COMPRESSED byte count in `Content-Length` while `response.body` yields DECOMPRESSED
 *  bytes, so the header cannot be the denominator (progress is then flagged `estimated`).
 *  `scripts/build-wasm.mjs` warns when the local artifact drifts from this number. */
export const WASM_BYTES = 7718539;

const CDN_ORIGIN = 'https://cdn.jsdelivr.net';

/** Base URL of the published package on jsDelivr, pinned to `version` (default: this build's). */
export function cdnBase(version = ENGINE_VERSION) {
  return `${CDN_ORIGIN}/npm/@auto-hwp/engine@${version}`;
}

/** Default wasm URL: this package's OWN version on jsDelivr. Override by passing a URL to
 *  `initEngine()` / `new WasmAdapter(url)` (self-hosting), or by importing the asset through your
 *  bundler: `import wasmUrl from "@auto-hwp/engine/pkg/hwp_wasm_bg.wasm?url"` (Vite). */
export function defaultWasmUrl(version) {
  return `${cdnBase(version)}/pkg/hwp_wasm_bg.wasm`;
}

/** Default MODULE-worker URL (same pin). Cross-origin worker scripts cannot be passed to `new Worker`
 *  directly — worker-client.js wraps this in a same-origin blob shim that `import`s it. */
export function defaultWorkerUrl(version) {
  return `${cdnBase(version)}/worker.js`;
}

/** True when `href` resolves to the page's own origin (or there is no browser origin at all, e.g. in
 *  Node/jsdom tests — nothing to violate there). */
export function isSameOriginUrl(href) {
  if (typeof location === 'undefined' || !location?.href) return true;
  try {
    return new URL(String(href), location.href).origin === location.origin;
  } catch {
    return true; // unparseable → let the platform decide rather than guessing
  }
}

function codedError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/** A URL-ish wasm input (or nothing) — the only shape whose download we can measure. Bytes and a
 *  compiled `WebAssembly.Module` are already in memory; a caller-supplied `Response`/`Request` is the
 *  caller's own transfer. */
function isUrlish(input) {
  return input == null || typeof input === 'string' || (typeof URL !== 'undefined' && input instanceof URL);
}

// A content-encoded response reports the COMPRESSED length in Content-Length while `body` yields
// DECOMPRESSED bytes — the two cannot be divided. (jsDelivr answers `access-control-expose-headers: *`
// so this header IS readable cross-origin; a host that hides it just lands on the estimate lane.)
function isEncoded(value) {
  return !!value && value.toLowerCase() !== 'identity';
}

// A static host that answers missing assets with its SPA index.html is the classic embed footgun: the
// bytes then fail to COMPILE with an opaque error. Fail early and name the cause instead.
function assertWasmContentType(res, url) {
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  if (!ct) return; // no claim — let the compiler judge the bytes
  if (/wasm|octet-stream|binary/.test(ct)) return;
  throw codedError(
    `engine wasm URL served "${ct}" (expected application/wasm) — ${url}\n` +
      'The asset is probably missing and your host answered with an HTML fallback page.',
    'wasm_fetch',
  );
}

/** Fetch a wasm URL while reporting download progress, and hand back a Response the wasm-bindgen glue
 *  can still `instantiateStreaming` (the body is piped, not buffered, whenever TransformStream exists).
 *  The Content-Type is normalized to `application/wasm` so an `application/octet-stream` host keeps the
 *  streaming path instead of falling back to the slower arrayBuffer lane. */
export async function fetchWasmResponse(url, onProgress, expectedBytes) {
  const res = await fetch(url);
  if (!res.ok) {
    throw codedError(`engine wasm fetch failed: ${res.status} ${res.statusText || ''} — ${url}`.trim(), 'wasm_fetch');
  }
  assertWasmContentType(res, url);

  const encoded = isEncoded(res.headers.get('content-encoding'));
  const declared = Number(res.headers.get('content-length') || 0);
  let total = 0;
  let estimated = false;
  if (expectedBytes > 0) {
    total = expectedBytes;
  } else if (declared > 0 && !encoded) {
    total = declared; // identity transfer — the header IS the byte count we will read
  } else {
    total = WASM_BYTES; // compressed (or hidden) — the published size is the honest denominator
    estimated = true;
  }

  const emit = (loaded, done) => {
    // An estimated denominator must never claim 100% before the stream actually ends.
    const raw = total > 0 ? loaded / total : null;
    const ratio = done ? 1 : raw == null ? null : Math.min(raw, estimated ? 0.999 : 1);
    try {
      onProgress({ loaded, total: total || null, ratio, done, estimated, url: String(url) });
    } catch {
      /* a broken progress observer must never fail the load */
    }
  };

  const headers = new Headers();
  headers.set('Content-Type', 'application/wasm');

  emit(0, false);
  if (!res.body) {
    // No streaming body (older Safari / some polyfills) — one shot, one progress event.
    const buf = new Uint8Array(await res.arrayBuffer());
    emit(buf.byteLength, true);
    return new Response(buf, { headers });
  }

  let loaded = 0;
  if (typeof TransformStream === 'function') {
    const counter = new TransformStream({
      transform(chunk, controller) {
        loaded += chunk.byteLength ?? chunk.length ?? 0;
        emit(loaded, false);
        controller.enqueue(chunk);
      },
      flush() {
        emit(loaded, true);
      },
    });
    return new Response(res.body.pipeThrough(counter), { headers });
  }

  // No TransformStream: read to memory (progress still exact, streaming compilation is lost).
  const reader = res.body.getReader();
  const chunks = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    emit(loaded, false);
  }
  const bytes = new Uint8Array(loaded);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  emit(loaded, true);
  return new Response(bytes, { headers });
}

/** Turn the caller's `input` into something `pkg/hwp_wasm.js`'s init accepts, applying the CDN default
 *  and (when `onProgress` is wired) the measured-download lane. Returns the URL string unchanged when
 *  nobody is watching progress, so the glue keeps its own fetch + instantiateStreaming +
 *  application/octet-stream fallback exactly as before. */
export function resolveWasmInput(input, options = {}) {
  const { onProgress, expectedBytes } = options;
  if (!isUrlish(input)) {
    // Bytes / compiled Module / caller-owned Response — nothing to download.
    if (onProgress) {
      try {
        onProgress({ loaded: 0, total: null, ratio: 1, done: true, estimated: false, url: null });
      } catch {
        /* observer error */
      }
    }
    return input;
  }
  const url = input == null ? defaultWasmUrl() : String(input);
  if (!onProgress || typeof fetch !== 'function') return url;
  return fetchWasmResponse(url, onProgress, expectedBytes);
}

export default {
  ENGINE_VERSION,
  WASM_BYTES,
  cdnBase,
  defaultWasmUrl,
  defaultWorkerUrl,
  isSameOriginUrl,
  fetchWasmResponse,
  resolveWasmInput,
};
