import { HwpDoc, initEngine, resetEngine } from "@tf-hwp/engine";
import type { EngineAdapter } from "./EngineAdapter";
import type { BlockHit, CaretRect, CellHit, FindMatch, FindOptions, FindReplaceOptions, HitResult, ImageBox, Intent, OpenResult, Outcome, OutlineItem, PageGeom, ReplaceResult, RunSpec, TableBox } from "./types";

type WasmInput = string | URL | Request | BufferSource | WebAssembly.Module;

/** Any error carrying a machine-readable engine `code` (@tf-hwp/engine EngineError). */
export interface CodedError extends Error {
  code?: string;
}

function isTrap(e: unknown): boolean {
  return !!e && typeof e === "object" && (e as CodedError).code === "wasm_trap";
}

/// WasmAdapter — the browser backend: wraps @tf-hwp/engine so the components run 100% client-side.
///
/// It owns the two things the raw engine wrapper leaves to the host (per @tf-hwp/engine README):
///  1. WASM TRAP RECOVERY. A Rust panic on wasm is a TRAP that poisons the whole instance. This adapter
///     holds the original bytes + name; on a `{code:"wasm_trap"}` it `resetEngine()`s and re-`open()`s
///     the document (so subsequent reads/render work again), then re-throws the trap so the workspace
///     can tell the user the last edit was rolled back ("reopen this file" UX). Unsaved state is lost.
///  2. FONT TRACKING. `hasFont()` reflects whether a face was injected, so the PDF button can guide the
///     user before `exportPdf()` throws `{code:"font_missing"}`.
export class WasmAdapter implements EngineAdapter {
  private doc: HwpDoc | null = null;
  private bytes: Uint8Array | null = null;
  private name: string | undefined;
  private fontRegistered = false;
  private wasmInput?: WasmInput;
  private ready: Promise<unknown> | null = null;

  /** `wasmInput` is forwarded to initEngine/resetEngine (a wasm URL/Response/bytes). Omit to let the
   *  engine resolve its co-located `hwp_wasm_bg.wasm` (works under Vite/webpack). */
  constructor(wasmInput?: WasmInput) {
    this.wasmInput = wasmInput;
  }

  private async ensureInit(): Promise<void> {
    if (!this.ready) this.ready = initEngine(this.wasmInput);
    await this.ready;
  }

  /** Run a synchronous engine call; on a wasm trap, reset + reopen so the instance survives, then
   *  rethrow the trap (state is lost — the caller re-renders/toasts). Ordinary engine errors pass
   *  through untouched. */
  private async guard<T>(fn: (doc: HwpDoc) => T): Promise<T> {
    if (!this.doc) throw Object.assign(new Error("no document open"), { code: "no_document" });
    try {
      return fn(this.doc);
    } catch (e) {
      if (isTrap(e)) {
        await this.recover();
        throw e;
      }
      throw e;
    }
  }

  /** Re-instantiate the wasm module and re-open the last document (its handles were poisoned). */
  private async recover(): Promise<void> {
    if (!this.bytes) return;
    this.ready = resetEngine(this.wasmInput);
    await this.ready;
    this.doc = HwpDoc.open(this.bytes, this.name);
    this.fontRegistered = false; // a fresh instance has no injected face
  }

  async open(bytes: Uint8Array, name?: string): Promise<OpenResult> {
    await this.ensureInit();
    if (this.doc) this.dispose();
    this.bytes = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    this.name = name;
    this.fontRegistered = false;
    this.doc = HwpDoc.open(this.bytes, name);
    const pages = this.doc.pageCount();
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
    return this.guard((d) => d.hitTest(page, x, y) as BlockHit | null);
  }

  tableAt(page: number, x: number, y: number): Promise<TableBox | null> {
    return this.guard((d) => d.tableAt(page, x, y) as TableBox | null);
  }

  tableCellAt(page: number, x: number, y: number): Promise<CellHit | null> {
    return this.guard((d) => d.tableCellAt(page, x, y) as CellHit | null);
  }

  /** Image click-select (issue 049) — the engine `imageAt` binding (delegates to hwp-session's
   *  `image_at_placed`, the SAME geometry the desktop `image_at` command reads). Returns the topmost
   *  image's own box + `(section, block)` anchor, or `null` off any image (018 null policy). */
  imageAt(page: number, x: number, y: number): Promise<ImageBox | null> {
    return this.guard((d) => d.imageAt(page, x, y) as ImageBox | null);
  }

  /** Image box by anchor (issue 049) — the engine `imageBbox` binding (delegates to `image_bbox_placed`).
   *  Re-queried after a move/resize commit to re-place the overlay + apply-verify; `null` when that image
   *  isn't on the queried page. */
  imageBbox(page: number, section: number, block: number): Promise<ImageBox | null> {
    return this.guard((d) => d.imageBbox(page, section, block) as ImageBox | null);
  }

  blocksInRect(page: number, x0: number, y0: number, x1: number, y1: number): Promise<BlockHit[]> {
    return this.guard((d) => d.blocksInRect(page, x0, y0, x1, y1) as BlockHit[]);
  }

  tableColBoundaries(page: number, section: number, block: number): Promise<number[] | null> {
    return this.guard((d) => d.tableColBoundaries(page, section, block));
  }

  tableRowBoundaries(page: number, section: number, block: number): Promise<number[] | null> {
    return this.guard((d) => d.tableRowBoundaries(page, section, block));
  }

  pageGeometry(page: number): Promise<PageGeom | null> {
    return this.guard((d) => d.pageGeometry(page) as PageGeom | null);
  }

  blockRuns(section: number, block: number, row?: number, col?: number): Promise<RunSpec[]> {
    return this.guard((d) => d.blockRuns(section, block, row ?? null, col ?? null) as RunSpec[]);
  }

  /** Document outline (issue 046) — the engine `outline()` binding (delegates to hwp-session's outline,
   *  the SAME heading source the desktop `doc_outline` command uses). Returns an EMPTY ARRAY when the
   *  document has no detected heading (never null — 018), so the panel's page-list fallback is a UI
   *  decision, not a null check. */
  outline(): Promise<OutlineItem[]> {
    return this.guard((d) => d.outline() as OutlineItem[]);
  }

  /** WYSIWYG GLYPH caret (engine half) — the rhwp glyph-box `HitTest` intent via the applyIntent JSON
   *  seam (issue 041: crates untouched — this is pure JSON wiring). Returns the char-precise `HitResult`,
   *  or `null` off any glyph. `hit.node` is null for cell text / an unanchored binary-.hwp paragraph
   *  (docs/CARET-GAP.md). `caretMiss` normalizes the `needs_rhwp` capability gate (a lean
   *  `--no-default-features` wasm build) to `null` so the caller never sees a throw for "no caret path". */
  hitTestText(page: number, x: number, y: number): Promise<HitResult | null> {
    return this.caretMiss(() =>
      this.guard((d) => {
        const out = d.applyIntent({ intent: "HitTest", page, x, y }) as { hit?: HitResult | null };
        return out.hit ?? null;
      }),
    );
  }

  /** WYSIWYG GLYPH caret (geometry half) — the `CaretRect` intent via applyIntent JSON. Returns the caret
   *  rect (own-render PAGE px), or `null` when the paragraph isn't on `page`. A past-end `offset` is
   *  CLAMPED by the engine (returns a rect, never null). `needs_rhwp` → null (capability gate). */
  caretRect(page: number, node: number, offset: number): Promise<CaretRect | null> {
    return this.caretMiss(() =>
      this.guard((d) => {
        const out = d.applyIntent({ intent: "CaretRect", page, node, offset }) as { caret?: CaretRect | null };
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
    return this.guard((d) => {
      const out = d.applyIntent({ intent: "Find", query, case_sensitive: !!opts.caseSensitive, whole_word: !!opts.wholeWord }) as { matches?: FindMatch[] };
      return out.matches ?? [];
    });
  }

  /** Replace (issue 045) — the `Replace` Intent via applyIntent JSON, ONE undo unit. The `{kind:"replaced"}`
   *  outcome gives the count + live page count. Run formatting is preserved by the op-bus (it rebuilds runs
   *  across the replaced range — never a plain-text collapse). */
  replace(query: string, replacement: string, opts: FindReplaceOptions): Promise<ReplaceResult> {
    return this.guard((d) => {
      const out = d.applyIntent({
        intent: "Replace",
        query,
        replacement,
        case_sensitive: !!opts.caseSensitive,
        whole_word: !!opts.wholeWord,
        all: !!opts.all,
      }) as { replaced?: number; pages?: number };
      return { replaced: out.replaced ?? 0, pages: out.pages ?? 0 };
    });
  }

  applyIntent(intent: Intent): Promise<Outcome> {
    return this.guard((d) => d.applyIntent(intent) as Outcome);
  }

  undo(): Promise<boolean> {
    return this.guard((d) => d.undo());
  }

  redo(): Promise<boolean> {
    return this.guard((d) => d.redo());
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
    try {
      this.doc?.free();
    } catch {
      /* already freed / instance gone */
    }
    this.doc = null;
  }
}
