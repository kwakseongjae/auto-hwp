// Type definitions for @auto-hwp/engine/cdn — the default asset locations (W6.1) + the measured
// download lane (W6.2). See cdn.js for the rationale (never `@latest`).

/** One download-progress tick. `total` is null when no denominator is known; `ratio` is null then too.
 *  `estimated` marks a denominator that is the PUBLISHED wasm size rather than this response's own
 *  Content-Length — the case whenever the transfer is content-encoded (brotli/gzip), because the header
 *  then counts COMPRESSED bytes while the body yields DECOMPRESSED ones. An estimated ratio is capped
 *  below 1 until the stream really ends. */
export interface EngineLoadProgress {
  /** Bytes read from the response body so far (decompressed). */
  loaded: number;
  /** Denominator in the same (decompressed) unit, or null when unknown. */
  total: number | null;
  /** `loaded / total` clamped to [0, 1], or null when unknown. Always 1 on the `done` tick. */
  ratio: number | null;
  /** True on the final tick (the whole body has been read). */
  done: boolean;
  /** True when `total` is the published size rather than this transfer's Content-Length. */
  estimated: boolean;
  /** The wasm URL being fetched; null when the input was bytes/Module (nothing to download). */
  url: string | null;
}

export type EngineProgressHandler = (progress: EngineLoadProgress) => void;

/** Options accepted by `initEngine` / `resetEngine` alongside the wasm input. */
export interface EngineLoadOptions {
  /** Receive download progress. Wiring it makes the loader fetch the wasm itself (still streaming). */
  onProgress?: EngineProgressHandler;
  /** Override the progress denominator (uncompressed bytes) when you self-host a different build. */
  expectedBytes?: number;
}

/** The version this build of the JS ships with — what the CDN default pins to. */
export const ENGINE_VERSION: string;

/** Uncompressed size of the wasm published in ENGINE_VERSION (progress denominator fallback). */
export const WASM_BYTES: number;

/** `https://cdn.jsdelivr.net/npm/@auto-hwp/engine@<version>` (default: this build's version). */
export function cdnBase(version?: string): string;

/** Default wasm URL — this package's own version on jsDelivr. */
export function defaultWasmUrl(version?: string): string;

/** Default MODULE-worker URL — this package's own version on jsDelivr. */
export function defaultWorkerUrl(version?: string): string;

/** Whether `href` resolves to the page's own origin (true when there is no browser origin at all). */
export function isSameOriginUrl(href: string | URL): boolean;

/** Fetch a wasm URL with progress, returning a Response the glue can still instantiateStreaming. */
export function fetchWasmResponse(
  url: string | URL,
  onProgress: EngineProgressHandler,
  expectedBytes?: number,
): Promise<Response>;

/** Apply the CDN default + the progress lane to a caller-supplied wasm input. */
export function resolveWasmInput(
  input?: string | URL | Request | BufferSource | WebAssembly.Module,
  options?: EngineLoadOptions,
): string | Promise<Response> | Request | BufferSource | WebAssembly.Module;

declare const _default: {
  ENGINE_VERSION: typeof ENGINE_VERSION;
  WASM_BYTES: typeof WASM_BYTES;
  cdnBase: typeof cdnBase;
  defaultWasmUrl: typeof defaultWasmUrl;
  defaultWorkerUrl: typeof defaultWorkerUrl;
  isSameOriginUrl: typeof isSameOriginUrl;
  fetchWasmResponse: typeof fetchWasmResponse;
  resolveWasmInput: typeof resolveWasmInput;
};
export default _default;
