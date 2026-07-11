// @tf-hwp/engine worker entry (issue 055, FG-14) — runs the WHOLE engine inside a Web Worker so a
// multi-MB parse / re-layout / toHwpx snapshot never blocks the host's main thread.
//
// This file is a self-contained MODULE worker: it imports the same safety wrapper (./index.js) the
// main thread would, so trap classification ({code:"wasm_trap"}), the generation guard and the
// lifetime net behave identically — just one thread over. It is deployed as a STATIC asset next to
// index.js + pkg/ (no bundler magic — the same philosophy as the explicit public wasm URL):
//
//   public/hwp/worker.js            ← this file
//   public/hwp/index.js             ← ../engine/index.js (imported below as ./index.js)
//   public/hwp/pkg/hwp_wasm.js      ← wasm-bindgen glue
//   public/hwp/hwp_wasm_bg.wasm     ← passed in explicitly via the `init` op (never the default path)
//
// PROTOCOL (hand-rolled RPC — no new dependency, see EngineWorkerClient in ./worker-client.js):
//   request  { id, op: "init"|"reset"|"open"|"call"|"free"|"ping", args? }
//   response { id, ok: true, result }               (Uint8Array results are TRANSFERRED, not copied)
//            { id, ok: false, error: { message, code } }
//
// ONE document per worker (the client owns exactly one) — a SUCCESSFUL `open` frees the previous
// handle; a FAILED open keeps it (see the `open` op). A wasm
// TRAP inside an op is caught by the wrapper and serialized as {code:"wasm_trap"}; the instance is
// then poisoned and the CLIENT drives recovery (reset → re-open), exactly like the main-thread lane.
// The worker process itself dying (OOM kill, load failure) is surfaced by the client as
// {code:"worker_dead"} — the 052 recovery treats both as "instance poisoned".
import { HwpDoc, initEngine, isTrapError, resetEngine } from './index.js';

/** The one open document of this worker (see ONE-document contract above). */
let doc = null;

/** Doc methods the client may invoke via the `call` op. A whitelist — NOT a dynamic property walk —
 *  so a hostile/buggy message can never reach `free`/constructor internals or prototype members. */
const METHODS = new Set([
  'pageCount',
  'placedStats',
  'renderPageSvg',
  'hitTest',
  'tableAt',
  'imageAt',
  'imageBbox',
  'tableCellAt',
  'cellTextHit',
  'cellCaretRect',
  'blocksInRect',
  'tableColBoundaries',
  'tableRowBoundaries',
  'pageGeometry',
  'blockRuns',
  'outline',
  'applyIntent',
  'undo',
  'redo',
  'registerFont',
  'exportPdf',
  'exportHtml',
  'toHwpx',
]);

function freeDoc() {
  if (doc) {
    try {
      doc.free();
    } catch {
      /* already dead (trap generation bump) — nothing to release */
    }
    doc = null;
  }
}

/** Serialize an error into a structured-cloneable {message, code}. The wrapper already classifies
 *  traps into {code:"wasm_trap"}; a RAW trap (e.g. thrown by HwpDoc.open, which the wrapper does not
 *  guard) is classified HERE — via the ONE shared `isTrapError` (issue 055 사후: no private pattern
 *  copies) — so the client never has to regex-match across the thread boundary. */
function encodeError(e) {
  const message = e && typeof e === 'object' && 'message' in e ? String(e.message) : String(e);
  let code = e && typeof e === 'object' && typeof e.code === 'string' ? e.code : undefined;
  if (!code && isTrapError(e)) code = 'wasm_trap';
  return { message, code };
}

async function handle(op, args) {
  switch (op) {
    case 'init':
      await initEngine(args?.wasmInput);
      return null;
    case 'reset':
      // The previous instance is poisoned (or being replaced) — every handle in it is dead.
      doc = null;
      await resetEngine(args?.wasmInput);
      return null;
    case 'open': {
      // Parse FIRST; only a SUCCESSFUL parse replaces (and frees) the previous document. CONTRACT
      // (issue 055 사후): "failed open은 이전 문서 생존" — a structured rejection (DocLimit / corrupt
      // container) leaves the prior document open and queryable, mirroring the main thread where the
      // adapter keeps its handle. (A TRAP during parse poisons the whole instance — the previous doc
      // dies with it regardless; the client's reset lane owns that case.)
      const next = HwpDoc.open(args.bytes, args.name ?? undefined);
      freeDoc();
      doc = next;
      return { pages: doc.pageCount() };
    }
    case 'call': {
      if (!doc) {
        const err = new Error('no document open');
        err.code = 'no_document';
        throw err;
      }
      if (!METHODS.has(args.method)) throw new Error(`unknown engine method: ${String(args.method)}`);
      return doc[args.method](...(args.params ?? []));
    }
    case 'free':
      freeDoc();
      return null;
    case 'ping':
      return 'pong';
    default:
      throw new Error(`unknown op: ${String(op)}`);
  }
}

self.onmessage = (ev) => {
  const { id, op, args } = ev.data ?? {};
  Promise.resolve()
    .then(() => handle(op, args))
    .then((result) => {
      // Big byte results (exportPdf/toHwpx) are TRANSFERRED — the worker-side copy is throwaway
      // (wasm-bindgen already copied out of linear memory), so no double copy crosses the boundary.
      const transfer = result instanceof Uint8Array ? [result.buffer] : [];
      self.postMessage({ id, ok: true, result }, transfer);
    })
    .catch((e) => {
      self.postMessage({ id, ok: false, error: encodeError(e) });
    });
};
