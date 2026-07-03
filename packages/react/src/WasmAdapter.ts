import { HwpDoc, initEngine, resetEngine } from "@tf-hwp/engine";
import type { EngineAdapter } from "./EngineAdapter";
import type { BlockHit, CellHit, Intent, OpenResult, Outcome, TableBox } from "./types";

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

  blocksInRect(page: number, x0: number, y0: number, x1: number, y1: number): Promise<BlockHit[]> {
    return this.guard((d) => d.blocksInRect(page, x0, y0, x1, y1) as BlockHit[]);
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
