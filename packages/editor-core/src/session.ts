import type { EngineAdapter } from "./adapter";
import { Emitter } from "./events";
import type { Anchor, DocContext, Intent, OpenResult, OutlineItem, PageGeom, RunSpec } from "./types";

/// DocSession — the document lifecycle facade over an EngineAdapter (SDK-LAYERS L2), DESCENDED from
/// HwpWorkspace's document/undo/font state. It owns: the open-document metadata (`OpenResult`), the
/// undo/redo BATCH stacks (one applied AI proposal = one batch of N ops = one user-facing undo), the
/// registered-font family, and re-querying the page count after edits/font swaps re-paginate.
///
/// It emits two signals the UI subscribes to:
///  - `onDocChange(meta)` — the OpenResult (pages/format/editable) changed (open/apply/undo/font).
///  - `onLayoutInvalidated()` — the rendered pages are stale; the UI should re-fetch page SVGs.
///
/// DOM concerns (blob URLs, @font-face injection, file download, toasts) stay in the UI layer — this
/// core only speaks to the adapter and holds document state.
export class DocSession {
  private meta: OpenResult | null = null;
  private undoBatches: number[] = []; // sizes (ops per applied proposal)
  private redoBatches: number[] = [];
  private fontFamily: string | null = null;

  private docChanged = new Emitter<OpenResult | null>();
  private layoutInvalidated = new Emitter<void>();

  constructor(private adapter: EngineAdapter) {}

  // ── getters ──────────────────────────────────────────────────────────────
  getMeta(): OpenResult | null {
    return this.meta;
  }
  get pages(): number {
    return this.meta?.pages ?? 0;
  }
  get editable(): boolean {
    return this.meta?.editable ?? false;
  }
  get format(): string {
    return this.meta?.format ?? "";
  }
  /** The currently registered font family (drives metrics + PDF), or null before any register. */
  getFontFamily(): string | null {
    return this.fontFamily;
  }
  canUndo(): boolean {
    return this.undoBatches.length > 0;
  }
  canRedo(): boolean {
    return this.redoBatches.length > 0;
  }

  // ── subscriptions ────────────────────────────────────────────────────────
  onDocChange(l: (meta: OpenResult | null) => void): () => void {
    return this.docChanged.on(l);
  }
  onLayoutInvalidated(l: () => void): () => void {
    return this.layoutInvalidated.on(() => l());
  }

  // ── commands ─────────────────────────────────────────────────────────────
  /** Open a document from bytes: opens via the adapter, resets undo/redo + font, and signals. */
  async open(bytes: Uint8Array, name?: string): Promise<OpenResult> {
    const r = await this.adapter.open(bytes, name);
    this.meta = r;
    this.undoBatches = [];
    this.redoBatches = [];
    this.fontFamily = null;
    this.docChanged.emit(r);
    this.layoutInvalidated.emit();
    return r;
  }

  /** Mark the session as having no open document (the host cleared the document). */
  close(): void {
    this.meta = null;
    this.undoBatches = [];
    this.redoBatches = [];
    this.docChanged.emit(null);
  }

  /** Apply a batch of Intents as ONE undo unit. Applies each in order, records the batch size, clears
   *  the redo stack, re-queries the page count (edits re-paginate), and signals. Rethrows on failure so
   *  the UI can surface the error / trap-recovery message. Resolves to how many ops were applied. */
  async applyBatch(intents: Intent[]): Promise<number> {
    let applied = 0;
    try {
      for (const intent of intents) {
        await this.adapter.applyIntent(intent);
        applied++;
      }
      this.undoBatches.push(applied);
      this.redoBatches = [];
      await this.refreshPages();
      this.layoutInvalidated.emit();
    } catch (e) {
      throw e;
    }
    return applied;
  }

  /** Record that ONE engine undo unit was applied OUTSIDE `applyBatch` — used by `FindController` when it
   *  mutates through the adapter's NATIVE replace command (`TauriAdapter` → `replace_text`) instead of the
   *  generic `applyIntent` lane, so the undo bookkeeping stays coherent (issue 045 undo 실측). The engine's
   *  replace-all is ONE `do_ops` = ONE undo unit, so this pushes a batch of size 1; a later `undo()` then
   *  reverts the whole replace with one `adapter.undo()`. Also re-queries the page count + signals a layout
   *  invalidation, exactly like `applyBatch`, so the view re-paginates/repaints and any open find bar knows
   *  its matches went stale (refreshToken bump). */
  async recordExternalEdit(): Promise<void> {
    this.undoBatches.push(1);
    this.redoBatches = [];
    await this.refreshPages();
    this.layoutInvalidated.emit();
  }

  /** Undo the last applied batch (N adapter.undo() calls). Resolves `false` (no-op) when the stack is
   *  empty, `true` when a batch was undone. */
  async undo(): Promise<boolean> {
    const n = this.undoBatches.pop();
    if (!n) return false;
    for (let i = 0; i < n; i++) await this.adapter.undo().catch(() => false);
    this.redoBatches.push(n);
    await this.refreshPages();
    this.layoutInvalidated.emit();
    return true;
  }

  /** Redo the last undone batch. Resolves `false` (no-op) when the stack is empty, `true` otherwise. */
  async redo(): Promise<boolean> {
    const n = this.redoBatches.pop();
    if (!n) return false;
    for (let i = 0; i < n; i++) await this.adapter.redo().catch(() => false);
    this.undoBatches.push(n);
    await this.refreshPages();
    this.layoutInvalidated.emit();
    return true;
  }

  /** Register a font into the engine (metrics + PDF). Registering re-layouts (issue 022): re-query the
   *  page count + signal a layout invalidation. The UI additionally builds the screen @font-face. */
  async registerFont(family: string, bytes: Uint8Array): Promise<void> {
    await this.adapter.registerFont(family, bytes);
    this.fontFamily = family;
    await this.refreshPages();
    this.layoutInvalidated.emit();
  }

  // ── read-only geometry / runs (issue 027 — optional adapter methods) ──────────────────────────────
  /** Column-boundary x's (own-render px) of the table at `(section, block)` on `page` for the resize
   *  handles, or `null` (table off-page / backend can't answer). Read-only — no undo unit. */
  async colBoundaries(page: number, section: number, block: number): Promise<number[] | null> {
    return (await this.adapter.tableColBoundaries?.(page, section, block)) ?? null;
  }

  /** Row-boundary y's (own-render px) of the table at `(section, block)` on `page` for the row-height
   *  drag handles (issue 031), or `null` (table off-page / backend can't answer). A SPLIT table returns
   *  the per-page FRAGMENT's boundaries (023). Read-only — no undo unit. */
  async rowBoundaries(page: number, section: number, block: number): Promise<number[] | null> {
    return (await this.adapter.tableRowBoundaries?.(page, section, block)) ?? null;
  }

  /** Page geometry (own-render px) for the ruler, or `null` (out of range / backend can't answer). */
  async pageGeom(page: number): Promise<PageGeom | null> {
    return (await this.adapter.pageGeometry?.(page)) ?? null;
  }

  /** The CURRENT styled runs of the `(row, col)` cell of the table at `(section, block)`, or of the
   *  paragraph at `(section, block)` when `row`/`col` are omitted — read by the text-edit popover to
   *  PRESERVE run styling (issue 027 §함정). `[]` when the backend can't answer / the target is empty. */
  async runsAt(section: number, block: number, row?: number, col?: number): Promise<RunSpec[]> {
    return (await this.adapter.blockRuns?.(section, block, row, col)) ?? [];
  }

  /** The document outline (issue 046) — the top-level headings for the left nav panel, or `[]` when the
   *  document has no detected heading / the backend can't answer (the UI then falls back to a page list).
   *  Read-only — no undo unit. */
  async outline(): Promise<OutlineItem[]> {
    return (await this.adapter.outline?.()) ?? [];
  }

  /** Build the read-only DocContext handed to the host AI callback (meta + the marked anchors). */
  docContext(anchors: Anchor[]): DocContext {
    return {
      format: this.meta?.format ?? "",
      editable: this.meta?.editable ?? false,
      sections: this.meta?.sections ?? 0,
      pages: this.meta?.pages ?? 0,
      anchors,
    };
  }

  // Re-query the live page count and fold it into `meta` (keeps a transient error from wiping the count).
  private async refreshPages(): Promise<void> {
    try {
      const pages = await this.adapter.pageCount();
      if (this.meta) {
        this.meta = { ...this.meta, pages };
        this.docChanged.emit(this.meta);
      }
    } catch {
      /* keep the previous count on a transient error */
    }
  }
}
