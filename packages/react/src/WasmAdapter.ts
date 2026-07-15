import { HwpDoc, initEngine, resetEngine } from "@tf-hwp/engine";
import { EngineWorkerClient } from "@tf-hwp/engine/worker-client";
import type { EngineAdapter } from "./EngineAdapter";
import type { BlockHit, CaretRect, CellAddr, CellCaretRect, CellHit, CellTextHit, FindMatch, FindOptions, FindReplaceOptions, HitResult, ImageBox, Intent, OpenResult, Outcome, OutlineItem, PageGeom, ReplaceResult, RunSpec, TableBox, TableGrid } from "./types";

type WasmInput = string | URL | Request | BufferSource | WebAssembly.Module;

/** Any error carrying a machine-readable engine `code` (@tf-hwp/engine EngineError). */
export interface CodedError extends Error {
  code?: string;
}

/** issue 055 — "the engine instance is poisoned" signals: a wasm TRAP (in-thread or inside the
 *  worker) or the WORKER ITSELF dying (OOM kill / load failure). Both mean every live handle is dead
 *  and the document must be re-opened — the 052 snapshot-first recovery treats them identically.
 *  (`worker_terminated` — an INTENTIONAL dispose/cancel — is deliberately NOT here.) */
function isPoisoned(e: unknown): boolean {
  const code = (e as CodedError)?.code;
  return code === "wasm_trap" || code === "worker_dead";
}

/** issue 052 — a host-supplied autosave snapshot for trap recovery: serialized HWPX bytes of the last
 *  autosaved edit state (NOT the original file). `label` is informational (e.g. "rev 7, 3s ago"). */
export interface RecoverySnapshot {
  bytes: Uint8Array;
  label?: string;
}

/** issue 052 — resolves the LATEST recovery snapshot, or null when none exists. Called on every trap
 *  recovery (never cached) so the adapter always restores the freshest autosaved state. */
export type RecoverySnapshotSource = () => RecoverySnapshot | null | Promise<RecoverySnapshot | null>;

/** issue 052 — how a trap recovery re-opened the document: from the autosave `snapshot` (edits up to the
 *  last idle save survive) or from the `original` bytes (all edits lost). `reason` is the honest cause
 *  when a snapshot existed but could not be opened (the host toasts it — no false "복구됨"). */
export interface RecoveryInfo {
  source: "snapshot" | "original";
  label?: string;
  reason?: string;
}

/** issue 055 (FG-14) — run the engine inside a Web Worker instead of the main thread. `url` is the
 *  deployed @tf-hwp/engine/worker.js MODULE-worker script (served as a static asset next to index.js +
 *  pkg/, like the explicit wasm URL — no bundler magic); `factory` overrides worker creation (tests /
 *  bundler-specific recipes). When set, open/parse/re-layout/export/toHwpx all run off-thread — the
 *  Promise surface of this adapter is unchanged, so consumers need no code change. */
export interface WasmAdapterWorkerOptions {
  url?: string | URL;
  factory?: () => Worker;
}

export interface WasmAdapterOptions {
  /** Omit for the classic in-thread engine (default; e.g. jsdom tests). */
  worker?: WasmAdapterWorkerOptions;
}

type MaybePromise<T> = T | Promise<T>;

/** The document surface WasmAdapter drives — satisfied by BOTH the in-thread `HwpDoc` (sync returns)
 *  and the worker RPC proxy (Promise returns). `guard` awaits either. */
interface EngineDoc {
  pageCount(): MaybePromise<number>;
  renderPageSvg(page: number): MaybePromise<string>;
  hitTest(page: number, x: number, y: number): MaybePromise<unknown>;
  tableAt(page: number, x: number, y: number): MaybePromise<unknown>;
  tableCellAt(page: number, x: number, y: number): MaybePromise<unknown>;
  cellTextHit(page: number, x: number, y: number): MaybePromise<unknown>;
  cellCaretRect(section: number, block: number, row: number, col: number, para: number, offset: number): MaybePromise<unknown>;
  imageAt(page: number, x: number, y: number): MaybePromise<unknown>;
  imageBbox(page: number, section: number, block: number): MaybePromise<unknown>;
  blocksInRect(page: number, x0: number, y0: number, x1: number, y1: number): MaybePromise<unknown>;
  tableColBoundaries(page: number, section: number, block: number): MaybePromise<number[] | null>;
  tableRowBoundaries(page: number, section: number, block: number): MaybePromise<number[] | null>;
  pageGeometry(page: number): MaybePromise<unknown>;
  blockRuns(section: number, block: number, row?: number | null, col?: number | null): MaybePromise<unknown>;
  blockRunsPath(section: number, path: CellAddr[]): MaybePromise<unknown>;
  tableGrid(section: number, block: number): MaybePromise<unknown>;
  outline(): MaybePromise<unknown>;
  applyIntent(intent: object | string): MaybePromise<unknown>;
  undo(): MaybePromise<boolean>;
  redo(): MaybePromise<boolean>;
  registerFont(family: string, bytes: Uint8Array): MaybePromise<void>;
  exportPdf(): MaybePromise<Uint8Array>;
  exportHtml(): MaybePromise<string>;
  toHwpx(): MaybePromise<Uint8Array>;
  free(): void;
}

/// WasmAdapter — the browser backend: wraps @tf-hwp/engine so the components run 100% client-side.
///
/// It owns the two things the raw engine wrapper leaves to the host (per @tf-hwp/engine README):
///  1. WASM TRAP RECOVERY. A Rust panic on wasm is a TRAP that poisons the whole instance. This adapter
///     holds the original bytes + name; on a `{code:"wasm_trap"}` it resets the engine and re-`open()`s
///     the document (so subsequent reads/render work again), then re-throws the trap so the workspace
///     can tell the user the last edit was rolled back ("reopen this file" UX). issue 052: when the host
///     wired a `RecoverySnapshotSource` (autosave), recovery re-opens the LATEST SNAPSHOT first — edits
///     up to the last idle save survive; only on snapshot failure does it fall back to the original
///     bytes (and `onRecovered` carries the honest reason).
///  2. FONT TRACKING. `hasFont()` reflects whether a face was injected, so the PDF button can guide the
///     user before `exportPdf()` throws `{code:"font_missing"}`.
///
/// issue 055 (FG-14): pass `{ worker: { url } }` to run the ENGINE IN A WEB WORKER — parse, re-layout,
/// geometry, export and the 052 toHwpx snapshots all leave the main thread (the UI never freezes on a
/// multi-MB document). The adapter surface is identical; recovery gains one signal: the WORKER DYING
/// (`{code:"worker_dead"}`) is treated exactly like a trap — respawn + snapshot-first re-open.
export class WasmAdapter implements EngineAdapter {
  private doc: EngineDoc | null = null;
  private bytes: Uint8Array | null = null;
  private name: string | undefined;
  private fontRegistered = false;
  private wasmInput?: WasmInput;
  private ready: Promise<unknown> | null = null;
  private recoverySource: RecoverySnapshotSource | null = null;
  /** issue 055 — the worker RPC bridge; null = classic in-thread engine. */
  private client: EngineWorkerClient | null = null;
  /** issue 055 사후 — the IN-FLIGHT recovery, shared by every concurrent failure (single flight). */
  private recovering: Promise<void> | null = null;

  /** issue 052 — autosave trigger: called after every successful CONTENT mutation through this adapter
   *  (`applyIntent`, an effective `undo`/`redo`, an effective `replace`). Read-only queries, `open`, and
   *  `registerFont` never fire it, so a freshly-opened/un-edited document is never snapshotted (no
   *  spurious recovery banner). Host-assigned; exceptions in the callback are swallowed (a broken
   *  observer must not fail the edit itself). */
  onMutation: (() => void) | null = null;

  /** issue 052 — trap-recovery report: which bytes the document was re-opened from (see RecoveryInfo).
   *  Host-assigned; called AFTER the document is live again, right before the trap is rethrown. */
  onRecovered: ((info: RecoveryInfo) => void) | null = null;

  /** `wasmInput` is forwarded to initEngine/resetEngine (a wasm URL/Response/bytes). Omit to let the
   *  engine resolve its co-located `hwp_wasm_bg.wasm` (works under Vite/webpack). With `options.worker`
   *  the input crosses into the worker (URL objects become href strings; `Request` is unsupported). */
  constructor(wasmInput?: WasmInput, options?: WasmAdapterOptions) {
    this.wasmInput = wasmInput;
    if (options?.worker) {
      this.client = new EngineWorkerClient({ url: options.worker.url, factory: options.worker.factory });
    }
  }

  private async ensureInit(): Promise<void> {
    if (this.client) {
      // The client owns idempotency AND respawn-after-death — never cache its promise here.
      await this.client.init(this.wasmInput as never);
      return;
    }
    if (!this.ready) this.ready = initEngine(this.wasmInput);
    await this.ready;
  }

  /** Reset the poisoned engine: in-thread → `resetEngine`; worker → in-worker reset or a full respawn
   *  when the worker itself died. Either way every previously-open handle is dead afterwards. */
  private resetBackend(): Promise<unknown> {
    if (this.client) return this.client.reset(this.wasmInput as never);
    return resetEngine(this.wasmInput);
  }

  /** Open bytes on the live backend and return the document handle (worker → RPC proxy). */
  private async openDoc(bytes: Uint8Array, name?: string): Promise<EngineDoc> {
    if (this.client) {
      await this.client.open(bytes, name);
      return this.makeWorkerDoc(this.client);
    }
    return HwpDoc.open(bytes, name);
  }

  /** The worker-side document as an EngineDoc: every method is one whitelisted RPC (see worker.js). */
  private makeWorkerDoc(client: EngineWorkerClient): EngineDoc {
    const call = (method: string) => (...params: unknown[]) => client.call(method, params);
    return {
      pageCount: call("pageCount") as EngineDoc["pageCount"],
      renderPageSvg: call("renderPageSvg") as EngineDoc["renderPageSvg"],
      hitTest: call("hitTest"),
      tableAt: call("tableAt"),
      tableCellAt: call("tableCellAt"),
      cellTextHit: call("cellTextHit"),
      cellCaretRect: call("cellCaretRect"),
      imageAt: call("imageAt"),
      imageBbox: call("imageBbox"),
      blocksInRect: call("blocksInRect"),
      tableColBoundaries: call("tableColBoundaries") as EngineDoc["tableColBoundaries"],
      tableRowBoundaries: call("tableRowBoundaries") as EngineDoc["tableRowBoundaries"],
      pageGeometry: call("pageGeometry"),
      blockRuns: call("blockRuns"),
      blockRunsPath: call("blockRunsPath"),
      tableGrid: call("tableGrid"),
      outline: call("outline"),
      applyIntent: call("applyIntent") as EngineDoc["applyIntent"],
      undo: call("undo") as EngineDoc["undo"],
      redo: call("redo") as EngineDoc["redo"],
      registerFont: call("registerFont") as EngineDoc["registerFont"],
      exportPdf: call("exportPdf") as EngineDoc["exportPdf"],
      exportHtml: call("exportHtml") as EngineDoc["exportHtml"],
      toHwpx: call("toHwpx") as EngineDoc["toHwpx"],
      free: () => client.free(),
    };
  }

  /** Run an engine call (sync in-thread, or an RPC Promise in worker mode — hence the AWAIT: a sync
   *  `return fn(...)` would let worker rejections escape this try/catch). On a poisoned instance
   *  (wasm trap, or the worker dying), reset + reopen so the adapter survives, then rethrow (state is
   *  lost — the caller re-renders/toasts). Ordinary engine errors pass through untouched. */
  private async guard<T>(fn: (doc: EngineDoc) => T | Promise<T>): Promise<T> {
    if (!this.doc) throw Object.assign(new Error("no document open"), { code: "no_document" });
    try {
      return await fn(this.doc);
    } catch (e) {
      if (isPoisoned(e)) {
        await this.recover();
        throw e;
      }
      throw e;
    }
  }

  /** issue 052 — wire the autosave snapshot lane into trap recovery. Pass `null` to unwire. The source
   *  is queried on EVERY recovery (latest snapshot wins); it may be sync or async. */
  setRecoverySource(source: RecoverySnapshotSource | null): void {
    this.recoverySource = source;
  }

  // Notify the host about a completed recovery; a throwing host callback must not break recovery.
  private notifyRecovered(info: RecoveryInfo): void {
    try {
      this.onRecovered?.(info);
    } catch {
      /* host observer error — recovery already succeeded */
    }
  }

  // Notify the autosave observer after a successful mutation; a throwing observer must not fail the edit.
  private notifyMutation(): void {
    try {
      this.onMutation?.();
    } catch {
      /* host observer error — the edit itself succeeded */
    }
  }

  /** Re-instantiate the engine and re-open the last document (its handles were poisoned).
   *  issue 055 사후 — SINGLE FLIGHT: when the worker dies, EVERY in-flight call rejects at once and each
   *  lands here; letting N recoveries run concurrently interleaves reset/open (the freshly-opened doc is
   *  invalidated by the next reset → permanent dead handles) and fires onRecovered N times. So the first
   *  failure starts ONE recovery and the rest await that same promise. */
  private recover(): Promise<void> {
    if (!this.recovering) {
      this.recovering = this.doRecover().finally(() => {
        this.recovering = null;
      });
    }
    return this.recovering;
  }

  /** issue 052: SNAPSHOT-FIRST — when a RecoverySnapshotSource is wired and yields bytes, re-open those
   *  (the last autosaved edit state) instead of the original file; the snapshot then BECOMES the current
   *  document bytes (a second trap recovers from it too). A failing snapshot open poisons the fresh
   *  instance again, so the engine is reset ONCE MORE before the honest original-bytes fallback.
   *  issue 055: the same lane serves WORKER DEATH — resetBackend respawns a fresh worker first. */
  private async doRecover(): Promise<void> {
    if (!this.bytes) return;
    this.ready = this.resetBackend();
    await this.ready;
    this.fontRegistered = false; // a fresh instance has no injected face
    let snapshot: RecoverySnapshot | null = null;
    let reason: string | undefined;
    try {
      snapshot = (await this.recoverySource?.()) ?? null;
    } catch (e) {
      snapshot = null;
      reason = `snapshot source failed: ${e}`;
    }
    if (snapshot && snapshot.bytes.length > 0) {
      try {
        this.doc = await this.openDoc(snapshot.bytes, this.name);
        this.bytes = snapshot.bytes;
        this.notifyRecovered({ source: "snapshot", label: snapshot.label });
        return;
      } catch (e) {
        // The snapshot itself failed to open — possibly ANOTHER trap, so reset again before the fallback.
        reason = `snapshot open failed: ${e}`;
        this.ready = this.resetBackend();
        await this.ready;
      }
    }
    this.doc = await this.openDoc(this.bytes, this.name);
    this.notifyRecovered({ source: "original", reason });
  }

  async open(bytes: Uint8Array, name?: string): Promise<OpenResult> {
    await this.ensureInit();
    // In-thread: free the previous handle. Worker: the worker-side `open` op swaps its doc only AFTER a
    // successful parse — do NOT dispose() here (that would tear the worker down just to respawn it).
    if (this.doc && !this.client) this.dispose();
    const nextBytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let doc: EngineDoc;
    try {
      doc = await this.openDoc(nextBytes, name);
    } catch (e) {
      if (this.client && isPoisoned(e)) {
        // issue 055: a trap DURING OPEN (corrupt/hostile file) poisons the instance — the previous
        // worker-side document died with it. Worker mode self-heals: reset in place so the NEXT open
        // works without any host-side engine plumbing (the host cannot reach the worker's engine
        // module the way it could call resetEngine()).
        this.doc = null;
        this.bytes = null;
        this.name = undefined;
        this.fontRegistered = false;
        await this.resetBackend().catch(() => {
          /* respawn failed — the next ensureInit retries */
        });
      }
      // issue 055 사후 — "failed open은 이전 문서 생존": a structured (non-poisoning) rejection such as
      // DocLimit keeps the previous document open in the worker, so the adapter state (doc/bytes/name/
      // font) stays UNTOUCHED here — queries keep answering from the previous document and a later trap
      // recovery re-opens the PREVIOUS bytes, never the failed file's.
      throw e;
    }
    // Commit the adapter state only now — an open that never succeeded must not replace anything.
    this.doc = doc;
    this.bytes = nextBytes;
    this.name = name;
    this.fontRegistered = false;
    const pages = await this.doc.pageCount();
    // @tf-hwp/engine has no standalone "opened" query; synthesize the OpenResult from what we know.
    return { format: name?.toLowerCase().endsWith(".hwp") ? "hwp" : "hwpx", editable: true, sections: 1, pages };
  }

  pageCount(): Promise<number> {
    return this.guard((d) => d.pageCount());
  }

  /** Raw (engine-sanitized) SVG — HwpPageView sanitizes AGAIN through this package's gate (R7). */
  pageSvg(page: number): Promise<string> {
    return this.guard((d) => d.renderPageSvg(page));
  }

  hitTest(page: number, x: number, y: number): Promise<BlockHit | null> {
    return this.guard(async (d) => (await d.hitTest(page, x, y)) as BlockHit | null);
  }

  tableAt(page: number, x: number, y: number): Promise<TableBox | null> {
    return this.guard(async (d) => (await d.tableAt(page, x, y)) as TableBox | null);
  }

  tableCellAt(page: number, x: number, y: number): Promise<CellHit | null> {
    return this.guard(async (d) => (await d.tableCellAt(page, x, y)) as CellHit | null);
  }

  /** Cell-addressed caret, hit half (issue 053) — the engine `cellTextHit` binding (the placed-cache
   *  lane with THIS document's injected fonts, so the caret geometry agrees with the visible SVG even
   *  after registerFont; the Intent lane would measure with default fonts). `null` off any cell text
   *  (018 null policy — never a throw). */
  hitTestCellText(page: number, x: number, y: number): Promise<CellTextHit | null> {
    return this.guard(async (d) => (await d.cellTextHit(page, x, y)) as CellTextHit | null);
  }

  /** Cell-addressed caret, geometry half (issue 053) — the engine `cellCaretRect` binding (same
   *  injected-font placement as `hitTestCellText`, so hit → caret → typing stay on one geometry).
   *  `null` when the address doesn't resolve; a PAST-END offset CLAMPS (a rect, never null). */
  caretRectCell(section: number, block: number, row: number, col: number, para: number, offset: number): Promise<CellCaretRect | null> {
    return this.guard(async (d) => (await d.cellCaretRect(section, block, row, col, para, offset)) as CellCaretRect | null);
  }

  /** Image click-select (issue 049) — the engine `imageAt` binding (delegates to hwp-session's
   *  `image_at_placed`, the SAME geometry the desktop `image_at` command reads). Returns the topmost
   *  image's own box + `(section, block)` anchor, or `null` off any image (018 null policy). */
  imageAt(page: number, x: number, y: number): Promise<ImageBox | null> {
    return this.guard(async (d) => (await d.imageAt(page, x, y)) as ImageBox | null);
  }

  /** Image box by anchor (issue 049) — the engine `imageBbox` binding (delegates to `image_bbox_placed`).
   *  Re-queried after a move/resize commit to re-place the overlay + apply-verify; `null` when that image
   *  isn't on the queried page. */
  imageBbox(page: number, section: number, block: number): Promise<ImageBox | null> {
    return this.guard(async (d) => (await d.imageBbox(page, section, block)) as ImageBox | null);
  }

  blocksInRect(page: number, x0: number, y0: number, x1: number, y1: number): Promise<BlockHit[]> {
    return this.guard(async (d) => (await d.blocksInRect(page, x0, y0, x1, y1)) as BlockHit[]);
  }

  tableColBoundaries(page: number, section: number, block: number): Promise<number[] | null> {
    return this.guard((d) => d.tableColBoundaries(page, section, block));
  }

  tableRowBoundaries(page: number, section: number, block: number): Promise<number[] | null> {
    return this.guard((d) => d.tableRowBoundaries(page, section, block));
  }

  pageGeometry(page: number): Promise<PageGeom | null> {
    return this.guard(async (d) => (await d.pageGeometry(page)) as PageGeom | null);
  }

  blockRuns(section: number, block: number, row?: number, col?: number): Promise<RunSpec[]> {
    return this.guard(async (d) => (await d.blockRuns(section, block, row ?? null, col ?? null)) as RunSpec[]);
  }

  /** Styled runs of a NESTED cell by its descending CellPath (issue 064 Tier-2) — the engine
   *  `blockRunsPath` binding, so the inline editor prefills a nested LEAF cell's runs. */
  blockRunsPath(section: number, path: CellAddr[]): Promise<RunSpec[]> {
    return this.guard(async (d) => (await d.blockRunsPath(section, path)) as RunSpec[]);
  }

  /** Table cell GRID (issue 066) — the engine `tableGrid` binding (a pure MODEL read, so no re-typeset
   *  and it agrees with the edit lane's `(row, col)` on binary .hwp too). Returns the table's grid, or
   *  `null` when the block isn't a table (018 null policy — the chat then attaches no grid). The
   *  vibe-editing doc-context source: the model sees each cell's address + current text so it fills the
   *  table / targets a label's value cell instead of proposing nothing. */
  tableGrid(section: number, block: number): Promise<TableGrid | null> {
    return this.guard(async (d) => (await d.tableGrid(section, block)) as TableGrid | null);
  }

  /** Document outline (issue 046) — the engine `outline()` binding (delegates to hwp-session's outline,
   *  the SAME heading source the desktop `doc_outline` command uses). Returns an EMPTY ARRAY when the
   *  document has no detected heading (never null — 018), so the panel's page-list fallback is a UI
   *  decision, not a null check. */
  outline(): Promise<OutlineItem[]> {
    return this.guard(async (d) => (await d.outline()) as OutlineItem[]);
  }

  /** WYSIWYG GLYPH caret (engine half) — the rhwp glyph-box `HitTest` intent via the applyIntent JSON
   *  seam (issue 041: crates untouched — this is pure JSON wiring). Returns the char-precise `HitResult`,
   *  or `null` off any glyph. `hit.node` is null for cell text / an unanchored binary-.hwp paragraph
   *  (docs/CARET-GAP.md). `caretMiss` normalizes the `needs_rhwp` capability gate (a lean
   *  `--no-default-features` wasm build) to `null` so the caller never sees a throw for "no caret path". */
  hitTestText(page: number, x: number, y: number): Promise<HitResult | null> {
    return this.caretMiss(() =>
      this.guard(async (d) => {
        const out = (await d.applyIntent({ intent: "HitTest", page, x, y })) as { hit?: HitResult | null };
        return out.hit ?? null;
      }),
    );
  }

  /** WYSIWYG GLYPH caret (geometry half) — the `CaretRect` intent via applyIntent JSON. Returns the caret
   *  rect (own-render PAGE px), or `null` when the paragraph isn't on `page`. A past-end `offset` is
   *  CLAMPED by the engine (returns a rect, never null). `needs_rhwp` → null (capability gate). */
  caretRect(page: number, node: number, offset: number): Promise<CaretRect | null> {
    return this.caretMiss(() =>
      this.guard(async (d) => {
        const out = (await d.applyIntent({ intent: "CaretRect", page, node, offset })) as { caret?: CaretRect | null };
        return out.caret ?? null;
      }),
    );
  }

  /** Normalize the `needs_rhwp` capability-gate error to `null` (018: no caret path ⇒ null, not a throw).
   *  Only that ONE coded error is swallowed; traps and every other engine error propagate unchanged. */
  private async caretMiss<T>(run: () => Promise<T>): Promise<T | null> {
    try {
      return await run();
    } catch (e) {
      if ((e as CodedError).code === "needs_rhwp") return null;
      throw e;
    }
  }

  /** Find (issue 045) — the read-only `Find` Intent via applyIntent JSON. The engine's `{kind:"found"}`
   *  outcome carries `matches` in the SAME shape as editor-core's `FindMatch` (node/start/len/section/
   *  block are all single-word keys — no remap). The Intent fields are snake_case (`case_sensitive`/
   *  `whole_word`) because the op-bus Intent enum uses `deny_unknown_fields` with no rename. */
  find(query: string, opts: FindOptions): Promise<FindMatch[]> {
    return this.guard(async (d) => {
      const out = (await d.applyIntent({ intent: "Find", query, case_sensitive: !!opts.caseSensitive, whole_word: !!opts.wholeWord })) as { matches?: FindMatch[] };
      return out.matches ?? [];
    });
  }

  /** Replace (issue 045) — the `Replace` Intent via applyIntent JSON, ONE undo unit. The `{kind:"replaced"}`
   *  outcome gives the count + live page count. Run formatting is preserved by the op-bus (it rebuilds runs
   *  across the replaced range — never a plain-text collapse). */
  async replace(query: string, replacement: string, opts: FindReplaceOptions): Promise<ReplaceResult> {
    const res = await this.guard(async (d) => {
      const out = (await d.applyIntent({
        intent: "Replace",
        query,
        replacement,
        case_sensitive: !!opts.caseSensitive,
        whole_word: !!opts.wholeWord,
        all: !!opts.all,
      })) as { replaced?: number; pages?: number };
      return { replaced: out.replaced ?? 0, pages: out.pages ?? 0 };
    });
    if (res.replaced > 0) this.notifyMutation(); // issue 052: an effective replace is a content mutation
    return res;
  }

  async applyIntent(intent: Intent): Promise<Outcome> {
    const out = await this.guard(async (d) => (await d.applyIntent(intent)) as Outcome);
    this.notifyMutation(); // issue 052: the edit lane — every accepted Intent mutates the document
    return out;
  }

  async undo(): Promise<boolean> {
    const done = await this.guard((d) => d.undo());
    if (done) this.notifyMutation(); // issue 052: an effective undo changes the content too
    return done;
  }

  async redo(): Promise<boolean> {
    const done = await this.guard((d) => d.redo());
    if (done) this.notifyMutation();
    return done;
  }

  async registerFont(family: string, bytes: Uint8Array): Promise<void> {
    await this.guard((d) => d.registerFont(family, bytes));
    this.fontRegistered = true;
  }

  hasFont(): boolean {
    return this.fontRegistered;
  }

  exportPdf(): Promise<Uint8Array> {
    return this.guard((d) => d.exportPdf());
  }

  exportHtml(): Promise<string> {
    return this.guard((d) => d.exportHtml());
  }

  toHwpx(): Promise<Uint8Array> {
    return this.guard((d) => d.toHwpx());
  }

  dispose(): void {
    if (this.client) {
      // Full release (probe adapters, document swap-out): tear the worker down — its wasm instance and
      // linear memory go with it. A later open() respawns via ensureInit (the client keeps url/factory).
      this.client.terminate();
      this.doc = null;
      return;
    }
    try {
      this.doc?.free();
    } catch {
      /* already freed / instance gone */
    }
    this.doc = null;
  }
}
