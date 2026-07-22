// @auto-hwp/engine — main-thread RPC client for the worker entry (./worker.js; issue 055, FG-14).
//
// Hand-rolled request/response bridge (no new dependency): each request gets a monotonically
// increasing id; the worker answers {id, ok, result|error}. Errors arrive as {message, code} and are
// re-hydrated into Error objects carrying `.code`, so the SAME branch logic (052 trap recovery,
// engine error codes) works whether the engine runs in-thread or in the worker.
//
// LIFETIMES / DEATH:
//  * a wasm TRAP does NOT kill the worker — it surfaces as {code:"wasm_trap"} and the instance inside
//    the worker is poisoned; recover with `reset()` (in-place re-instantiation, same worker).
//  * the WORKER dying (load failure, uncaught error, OOM kill) rejects every in-flight call with
//    {code:"worker_dead"}; the next `init()`/`reset()` RESPAWNS a fresh worker. The 052 recovery path
//    treats worker death exactly like a trap: reset → re-open from the latest snapshot.
//  * `terminate()` is the INTENTIONAL kill (dispose / user cancel): in-flight calls reject with
//    {code:"worker_terminated"} — callers distinguish a cancel from a crash.

/** Structured-clone-safe wasm input: URL objects are NOT cloneable — send the href string. Bytes and
 *  compiled WebAssembly.Module values clone fine. `Request` (main-thread-only) is rejected honestly. */
function normalizeWasmInput(input) {
  if (input == null) return undefined;
  if (typeof URL !== 'undefined' && input instanceof URL) return input.href;
  if (typeof Request !== 'undefined' && input instanceof Request) {
    throw new Error('EngineWorkerClient: a Request wasmInput cannot cross the worker boundary — pass its URL instead');
  }
  return input;
}

function codedError(message, code) {
  const err = new Error(message);
  if (code) err.code = code;
  return err;
}

export class EngineWorkerClient {
  #worker = null;
  #pending = new Map();
  #seq = 0;
  #url;
  #factory;
  #initPromise = null;

  /** `{ url }` — a MODULE worker script URL (the deployed ./worker.js), or `{ factory }` — a custom
   *  Worker supplier (tests / bundler-specific `new Worker(new URL(...))` recipes). */
  constructor(opts = {}) {
    this.#url = opts.url;
    this.#factory = opts.factory;
    if (!this.#url && !this.#factory) {
      throw new Error('EngineWorkerClient needs { url } or { factory }');
    }
  }

  /** Whether a worker is currently live (spawned and not dead/terminated). */
  get alive() {
    return this.#worker !== null;
  }

  #spawn() {
    const w = this.#factory ? this.#factory() : new Worker(this.#url, { type: 'module', name: 'auto-hwp-engine' });
    w.onmessage = (ev) => {
      const { id, ok, result, error } = ev.data ?? {};
      const p = this.#pending.get(id);
      if (!p) return; // late reply after a kill — already rejected
      this.#pending.delete(id);
      if (ok) p.resolve(result);
      else p.reject(codedError(error?.message ?? 'engine worker error', error?.code));
    };
    // A worker `error` event = the worker itself broke (script load failure / uncaught error) — NOT a
    // wasm trap (those are caught inside worker.js and answered normally). Treat as death.
    w.onerror = (ev) => {
      this.#kill(`engine worker died: ${ev && 'message' in ev && ev.message ? ev.message : 'unknown error'}`, 'worker_dead');
    };
    w.onmessageerror = () => {
      this.#kill('engine worker message could not be deserialized', 'worker_dead');
    };
    this.#worker = w;
  }

  #kill(message, code) {
    const err = codedError(message, code);
    for (const p of this.#pending.values()) p.reject(err);
    this.#pending.clear();
    try {
      this.#worker?.terminate();
    } catch {
      /* already gone */
    }
    this.#worker = null;
    this.#initPromise = null;
  }

  #post(op, args, transfer) {
    if (!this.#worker) {
      return Promise.reject(codedError('engine worker is not running (call init/reset first)', 'worker_dead'));
    }
    const id = ++this.#seq;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      try {
        this.#worker.postMessage({ id, op, args }, transfer ?? []);
      } catch (e) {
        this.#pending.delete(id);
        reject(e);
      }
    });
  }

  /** Ensure a LIVE worker with an instantiated wasm module. Idempotent per worker; respawns after a
   *  death or terminate(). `wasmInput` is a wasm URL/bytes/Module (URL objects become href strings). */
  // A failed init/reset must not be cached (the next call retries) — but only clear OUR OWN promise:
  // a stale rejection racing a newer init()/reset() must not null the newer one.
  #uncacheOnFailure(p) {
    p.catch(() => {
      if (this.#initPromise === p) this.#initPromise = null;
    });
    return p;
  }

  init(wasmInput) {
    if (!this.#worker) this.#spawn();
    if (!this.#initPromise) {
      this.#initPromise = this.#uncacheOnFailure(this.#post('init', { wasmInput: normalizeWasmInput(wasmInput) }));
    }
    return this.#initPromise;
  }

  /** Recover after a wasm trap: re-instantiate the module INSIDE the live worker (every open doc dies),
   *  or — when the worker itself is dead — respawn a fresh worker and init it. */
  reset(wasmInput) {
    if (!this.#worker) {
      this.#spawn();
      this.#initPromise = this.#uncacheOnFailure(this.#post('init', { wasmInput: normalizeWasmInput(wasmInput) }));
    } else {
      this.#initPromise = this.#uncacheOnFailure(this.#post('reset', { wasmInput: normalizeWasmInput(wasmInput) }));
    }
    return this.#initPromise;
  }

  /** Open a document from bytes (frees any previous worker-side doc). Resolves `{ pages }`.
   *  The bytes are structured-CLONED (not transferred) — the caller keeps its copy (052 recovery
   *  holds the original bytes main-side). */
  open(bytes, name) {
    return this.#post('open', { bytes, name });
  }

  /** Invoke a whitelisted HwpDoc method on the worker-side document. */
  call(method, params) {
    return this.#post('call', { method, params });
  }

  /** Free the worker-side document (keeps the worker + instantiated wasm for the next open). */
  free() {
    if (!this.#worker) return;
    this.#post('free').catch(() => {
      /* dying worker — terminate/death paths already handle cleanup */
    });
  }

  /** Intentional kill (dispose / user cancel): in-flight calls reject {code:"worker_terminated"};
   *  a later init()/reset() respawns. */
  terminate() {
    if (!this.#worker) return;
    this.#kill('engine worker terminated by the host', 'worker_terminated');
  }
}

export default { EngineWorkerClient };
