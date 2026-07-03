// @tf-hwp/engine — browser loader + safety wrapper around the wasm-bindgen bindings (issue 015).
//
// This wrapper adds THREE things the raw wasm-bindgen output lacks, per the issue's design:
//   1. wasm PANIC RECOVERY (R4 web variant): a Rust panic on wasm is a TRAP that poisons the whole
//      instance. Every call is try/caught; a WebAssembly.RuntimeError marks all live handles dead and
//      surfaces a `{code:"wasm_trap"}` error. The host recovers by `resetEngine()` + re-`open()`ing
//      the document (the page never dies — only the document state is lost).
//   2. LIFETIME SAFETY NET (R13): a FinalizationRegistry frees the wasm allocation if the host forgets
//      `.free()`. Explicit `free()` on document swap is still the contract.
//   3. SANITIZE (R7): `renderPageSvg` is UNTRUSTED, document-derived output — `sanitizeSvg()` (and the
//      convenience `renderPageSvgSanitized`) strip <script>/on*/<foreignObject> before you ever put it
//      in the DOM. Full hardening is issue 016; this is the minimum "never innerHTML raw" guard.

import init, { initSync, HwpDoc as RawHwpDoc } from './pkg/hwp_wasm.js';

let _initPromise = null;
// Bumped on every (re)instantiation. Handles capture the generation they were born in; a call from a
// stale generation (i.e. after a trap + resetEngine) is refused instead of touching freed memory.
let _generation = 0;

/** Instantiate the wasm module once. `input` is an optional wasm URL/Response/bytes (defaults to the
 *  co-located hwp_wasm_bg.wasm). Idempotent — repeated calls return the same promise. */
export function initEngine(input) {
  if (!_initPromise) {
    _initPromise = init(input).then((m) => {
      _generation++;
      return m;
    });
  }
  return _initPromise;
}

/** Re-instantiate the module AFTER a wasm trap (panic). Every previously-opened HwpDoc becomes dead;
 *  the host must re-`open()` its documents. Returns the init promise for the fresh instance. */
export function resetEngine(input) {
  _initPromise = init(input).then((m) => {
    _generation++;
    return m;
  });
  return _initPromise;
}

/** Synchronous init from an already-fetched WebAssembly.Module or bytes (advanced/bundler use). */
export function initEngineSync(moduleOrBytes) {
  const m = initSync(moduleOrBytes);
  _generation++;
  return m;
}

const FINALIZER =
  typeof FinalizationRegistry !== 'undefined'
    ? new FinalizationRegistry((raw) => {
        try {
          raw.free();
        } catch {
          /* already freed or instance gone */
        }
      })
    : null;

function isTrap(e) {
  return (
    (typeof WebAssembly !== 'undefined' && e instanceof WebAssembly.RuntimeError) ||
    /unreachable|RuntimeError|table index is out of bounds|memory access out of bounds/i.test(
      String((e && e.message) || e)
    )
  );
}

/** Strip active content from an untrusted SVG string (R7). Uses DOMParser in the browser; falls back
 *  to a conservative regex strip off-DOM (e.g. Node). NOT a full sanitizer — see issue 016. */
export function sanitizeSvg(svg) {
  if (typeof DOMParser !== 'undefined') {
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
    if (doc.querySelector('parsererror')) return ''; // refuse malformed markup rather than inject it
    doc.querySelectorAll('script, foreignObject').forEach((n) => n.remove());
    doc.querySelectorAll('*').forEach((el) => {
      for (const attr of Array.from(el.attributes)) {
        const name = attr.name.toLowerCase();
        const val = String(attr.value);
        // Drop event handlers and any javascript: URL sinks (href/xlink:href).
        if (name.startsWith('on') || /^\s*javascript:/i.test(val)) el.removeAttribute(attr.name);
      }
    });
    return new XMLSerializer().serializeToString(doc.documentElement);
  }
  // Off-DOM fallback (best-effort): remove <script>…</script>, on*="…" handlers, and javascript: URLs.
  return String(svg)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|xlink:href)\s*=\s*("javascript:[^"]*"|'javascript:[^']*')/gi, '');
}

/** A safe handle to one open document. All methods are trap-guarded; geometry/intent methods return
 *  parsed objects (the wasm layer returns JSON strings). */
export class HwpDoc {
  #raw;
  #gen;
  #dead = false;

  constructor(raw) {
    this.#raw = raw;
    this.#gen = _generation;
    if (FINALIZER) FINALIZER.register(this, raw, this);
  }

  /** Open a `.hwp` or `.hwpx` from bytes. Requires `await initEngine()` first. `name` seeds the title. */
  static open(bytes, name) {
    const raw = RawHwpDoc.open(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), name ?? null);
    return new HwpDoc(raw);
  }

  #call(fn) {
    if (this.#dead) throw deadError();
    if (this.#gen !== _generation) {
      this.#dead = true;
      throw deadError();
    }
    try {
      return fn(this.#raw);
    } catch (e) {
      if (isTrap(e)) {
        this.#dead = true;
        const err = new Error(
          'wasm trap — the engine instance is poisoned. Call resetEngine() then re-open your document.'
        );
        err.code = 'wasm_trap';
        err.cause = e;
        throw err;
      }
      throw e; // structured {code, message} engine errors pass through untouched
    }
  }

  pageCount() {
    return this.#call((r) => r.pageCount());
  }
  /** Layout-cache diagnostics (issue 025): `{placeBuilds, placeHits, revision, fonts}`. `placeBuilds`
   *  is the number of real re-typesets — after opening + N geometry queries with no edit it reads 1. */
  placedStats() {
    return this.#call((r) => JSON.parse(r.placedStats()));
  }
  /** UNTRUSTED SVG string — do NOT innerHTML raw; prefer renderPageSvgSanitized or sanitizeSvg. */
  renderPageSvg(n) {
    return this.#call((r) => r.renderPageSvg(n));
  }
  renderPageSvgSanitized(n) {
    return sanitizeSvg(this.renderPageSvg(n));
  }
  /** Structural block under (x,y) in own-render px, or `null` on a miss. */
  hitTest(page, x, y) {
    return this.#call((r) => {
      const s = r.hitTest(page, x, y); // Option<String> → JS string | null/undefined on a miss
      return s == null ? null : JSON.parse(s);
    });
  }
  /** Placed table box under (x,y) in own-render px, or `null` on a miss. */
  tableAt(page, x, y) {
    return this.#call((r) => {
      const s = r.tableAt(page, x, y); // Option<String> → JS string | null/undefined on a miss
      return s == null ? null : JSON.parse(s);
    });
  }
  /** Table CELL under (x,y) in own-render px for cell-level marking (issue 023), or `null` on a miss.
   *  `row`/`col` are MODEL-GLOBAL (already global on a split-table fragment — no first_row re-add). */
  tableCellAt(page, x, y) {
    return this.#call((r) => {
      const s = r.tableCellAt(page, x, y); // Option<String> → JS string | null/undefined on a miss
      return s == null ? null : JSON.parse(s);
    });
  }
  /** Marquee select: every top-level block whose band intersects the own-render px rect
   *  `(x0,y0)-(x1,y1)` (corners in any order). Returns a `BlockHit[]` — an EMPTY ARRAY on a miss. */
  blocksInRect(page, x0, y0, x1, y1) {
    return this.#call((r) => JSON.parse(r.blocksInRect(page, x0, y0, x1, y1))); // wasm returns "[]" on a miss
  }
  /** Column-boundary x-positions (own-render px) of the table at `(section, block)` on `page` — a
   *  `number[]` of `cols + 1` absolute px for the column-resize handles (issue 027), or `null` when the
   *  table isn't on the page. */
  tableColBoundaries(page, section, block) {
    return this.#call((r) => {
      const s = r.tableColBoundaries(page, section, block); // Option<String> → string | null/undefined on a miss
      return s == null ? null : JSON.parse(s);
    });
  }
  /** Row-boundary y-positions (own-render px) of the table at `(section, block)` on `page` — a
   *  `number[]` of `rows + 1` absolute px for the ROW-height resize handles (issue 031), or `null` when
   *  the table isn't on the page. A SPLIT table returns the per-page FRAGMENT's boundaries (023 규칙). */
  tableRowBoundaries(page, section, block) {
    return this.#call((r) => {
      const s = r.tableRowBoundaries(page, section, block); // Option<String> → string | null/undefined on a miss
      return s == null ? null : JSON.parse(s);
    });
  }
  /** Page geometry (own-render px) `{w,h,ml,mt,mr,mb}` of `page` for the ruler (issue 027), or `null`
   *  when the page is out of range. */
  pageGeometry(page) {
    return this.#call((r) => {
      const s = r.pageGeometry(page); // Option<String> → string | null/undefined on a miss
      return s == null ? null : JSON.parse(s);
    });
  }
  /** The CURRENT styled runs of the `(row, col)` cell of the table at `(section, block)`, or of the
   *  paragraph at `(section, block)` when `row`/`col` are omitted — a `RunSpec[]` the text-edit popover
   *  reads to PRESERVE run styling on a plain-text edit (issue 027). Multi-paragraph cells join with a
   *  `{ text:"\n" }` run. Empty array when the target has no runs. */
  blockRuns(section, block, row, col) {
    return this.#call((r) => JSON.parse(r.blockRuns(section, block, row ?? null, col ?? null)));
  }
  /** Apply an Intent (schema v0). Accepts an object or a JSON string; returns the parsed Outcome. */
  applyIntent(intent) {
    const s = typeof intent === 'string' ? intent : JSON.stringify(intent);
    return this.#call((r) => JSON.parse(r.applyIntent(s)));
  }
  undo() {
    return this.#call((r) => r.undo());
  }
  redo() {
    return this.#call((r) => r.redo());
  }
  /** Inject a single-face TTF/OTF font used for BOTH layout metrics AND the PDF embed (issue 022).
   *  ⚠️ RE-LAYOUTS the document: `renderPageSvg` and `pageCount()` can change — re-query + re-render
   *  after calling. Throws `{code:"ttc_unsupported"}` for a TTC collection. */
  registerFont(family, bytes) {
    return this.#call((r) => r.registerFont(family, bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)));
  }
  exportPdf() {
    return this.#call((r) => r.exportPdf());
  }
  exportHtml() {
    return this.#call((r) => r.exportHtml());
  }
  toHwpx() {
    return this.#call((r) => r.toHwpx());
  }
  /** Free the wasm allocation. Call on document swap (R13). Idempotent. */
  free() {
    if (this.#dead) return;
    if (FINALIZER) FINALIZER.unregister(this);
    try {
      this.#raw.free();
    } catch {
      /* instance gone */
    }
    this.#dead = true;
  }
}

function deadError() {
  const err = new Error(
    'HwpDoc is dead (freed or invalidated by a wasm trap). Call resetEngine() + HwpDoc.open() again.'
  );
  err.code = 'dead_handle';
  return err;
}

export default { initEngine, resetEngine, initEngineSync, HwpDoc, sanitizeSvg };
