// Type definitions for @tf-hwp/engine/worker-client (the main-thread RPC bridge to ./worker.js).

/** Wasm input accepted across the worker boundary. `URL` is converted to its href string; a
 *  `Request` cannot cross threads and is rejected with an honest error. */
export type WorkerWasmInput = string | URL | BufferSource | WebAssembly.Module;

export interface EngineWorkerClientOptions {
  /** URL of the deployed MODULE worker script (@tf-hwp/engine/worker.js served as a static asset). */
  url?: string | URL;
  /** Custom Worker supplier (tests / bundler-specific worker recipes). Takes precedence over `url`. */
  factory?: () => Worker;
}

/** Main-thread RPC client for the engine Web Worker (issue 055, FG-14).
 *
 *  Error codes carried by rejections (`(e as {code?: string}).code`):
 *  - `"wasm_trap"`         — the wasm instance INSIDE the worker is poisoned; call `reset()` then re-open.
 *  - `"worker_dead"`       — the worker itself died (load failure / uncaught error); `init()`/`reset()` respawn.
 *  - `"worker_terminated"` — the host called `terminate()` (dispose / cancel); NOT a crash.
 *  - every other engine `{code, message}` (no_document, bad_intent, font_missing, …) passes through as-is. */
export class EngineWorkerClient {
  constructor(opts: EngineWorkerClientOptions);
  /** Whether a worker is currently live (spawned and not dead/terminated). */
  readonly alive: boolean;
  /** Ensure a live worker with an instantiated wasm module (idempotent; respawns after death/terminate). */
  init(wasmInput?: WorkerWasmInput): Promise<void>;
  /** Re-instantiate the wasm module (trap recovery), or respawn + init when the worker is dead. */
  reset(wasmInput?: WorkerWasmInput): Promise<void>;
  /** Open a document from bytes (frees any previous worker-side doc). Bytes are cloned, not transferred. */
  open(bytes: Uint8Array, name?: string): Promise<{ pages: number }>;
  /** Invoke a whitelisted HwpDoc method on the worker-side document. */
  call<T = unknown>(method: string, params?: unknown[]): Promise<T>;
  /** Free the worker-side document (keeps the worker + wasm instance for the next open). */
  free(): void;
  /** Intentional kill: in-flight calls reject `{code:"worker_terminated"}`; later init() respawns. */
  terminate(): void;
}

declare const _default: { EngineWorkerClient: typeof EngineWorkerClient };
export default _default;
