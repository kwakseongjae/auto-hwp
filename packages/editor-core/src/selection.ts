import type { EngineAdapter } from "./adapter";
import { Emitter } from "./events";
import type { Anchor, BlockHit, CellHit, PointerInput, Selection, SelMarquee, TableBox } from "./types";

/// SelectionModel — the OS-style selection engine (issues 021 + 023), DESCENDED from @tf-hwp/react's
/// HwpWorkspace into framework-agnostic core. It owns the selection array (the single source of truth),
/// the pointer drag state machine (click = replace, ⌘/Ctrl-click = toggle, empty-space drag = marquee /
/// rubber-band, ⌘-marquee = union), and cell/table/block anchoring priority. It depends ONLY on the
/// EngineAdapter (page-local px queries) and emits change events — no React, no DOM, unit-testable with
/// pure `pointerDown({page,x,y,mod})` inputs.
///
/// COORDINATE CONTRACT (SDK-LAYERS §함정): inputs are already own-render PAGE px. The client-px → page-px
/// conversion (getBoundingClientRect / viewBox math) stays in the UI layer. `PointerInput.client` (raw
/// screen px, optional) is used ONLY to measure the zoom-independent drag threshold; when omitted, the
/// threshold falls back to page px (so node tests need no client point).

/** Movement past which a press becomes a drag (marquee) rather than a click. Measured in CLIENT px when
 *  a client point is supplied (zoom-independent), else in page px. */
export const DRAG_THRESHOLD_PX = 4;

/** Selection identity for replace/toggle/union dedup. A whole-block selection (paragraph/table from
 *  click or marquee) is identified by `(section, block)`; a CELL anchor (issue 023) additionally by its
 *  `rows`/`cols` so distinct cells of the SAME table are distinct selections (⌘-click toggles the exact
 *  clicked cell). Blocks carry no rows/cols → an empty `::` suffix, so their identity is unchanged. */
export function selKey(a: Anchor): string {
  const r = a.rows ? `${a.rows[0]}-${a.rows[1]}` : "";
  const c = a.cols ? `${a.cols[0]}-${a.cols[1]}` : "";
  return `${a.section}:${a.block}:${r}:${c}`;
}

/** Cell chip label = a short text snippet + a 1-based "N행 M열" (issue 023). Empty cell → "표 N행 M열".
 *  The snippet is trimmed/whitespace-collapsed and elided to ~12 chars. */
export function cellLabel(cell: CellHit): string {
  const snip = cell.text.trim().replace(/\s+/g, " ").slice(0, 12);
  const where = `${cell.row + 1}행 ${cell.col + 1}열`;
  return snip ? `“${snip}” (${where})` : `표 ${where}`;
}

/** Derive a Selection from a resolved click hit. Priority: CELL > table > block band (issue 023 — a
 *  click inside a table anchors the exact cell; a cell miss on a border/merged boundary falls back to
 *  the whole-table anchor, never an error). Coordinates are STRUCTURE indices, never px — a cell
 *  anchor's `rows`/`cols` are the MODEL-GLOBAL cell address `[r,r]`/`[c,c]` (CellHit.row is already
 *  global on a split fragment; NEVER re-add first_row). Returns null when the point resolved to nothing. */
export function deriveSel(page: number, table: TableBox | null, cell: CellHit | null, hit: BlockHit | null): Selection | null {
  if (cell) {
    const label = cellLabel(cell);
    return {
      mark: { page, box: { x: cell.x, y: cell.y, w: cell.w, h: cell.h }, label, kind: "cell" },
      anchor: {
        kind: "cell",
        section: cell.section,
        block: cell.block,
        rows: [cell.row, cell.row],
        cols: [cell.col, cell.col],
        label,
        page,
        text: cell.text,
      },
    };
  }
  if (table) {
    const label = `표 (p.${page + 1})`;
    return {
      mark: { page, box: { x: table.x, y: table.y, w: table.w, h: table.h }, label, kind: "table" },
      anchor: { kind: "table", section: table.section, block: table.block, label, page },
    };
  }
  if (hit) {
    const snip = hit.text.trim().replace(/\s+/g, " ").slice(0, 14);
    const kind = hit.kind === "table" ? "table" : hit.kind === "image" ? "image" : "paragraph";
    const label = kind === "paragraph" ? (snip ? `“${snip}”` : `문단 (p.${page + 1})`) : `${kind} (p.${page + 1})`;
    return {
      mark: { page, box: { x: hit.x, y: hit.y, w: hit.w, h: hit.h }, label, kind },
      anchor: { kind: kind === "image" ? "paragraph" : (kind as Anchor["kind"]), section: hit.section, block: hit.block, label, page, text: hit.text },
    };
  }
  return null;
}

/** Convert a marquee BlockHit to a Selection, EXCLUDING unsupported kinds (images can't be anchored —
 *  issue §함정). Returns null for an excluded hit so the caller can count what was dropped. */
export function blockHitToSel(hit: BlockHit, page: number): Selection | null {
  if (hit.kind === "image") return null; // not an editable anchor target
  const snip = hit.text.trim().replace(/\s+/g, " ").slice(0, 14);
  const kind = hit.kind === "table" ? "table" : "paragraph";
  const label = kind === "paragraph" ? (snip ? `“${snip}”` : `문단 (p.${page + 1})`) : `표 (p.${page + 1})`;
  return {
    mark: { page, box: { x: hit.x, y: hit.y, w: hit.w, h: hit.h }, label, kind },
    anchor: { kind, section: hit.section, block: hit.block, label, page, text: hit.text },
  };
}

/** Fold `incoming` into the current selection: `replace` (dedup incoming, drop the rest), `toggle` (a
 *  single ⌘/Ctrl-click: add if absent, remove if present), `union` (a ⌘/Ctrl-marquee: add all absent). */
export function mergeSelection(prev: Selection[], incoming: Selection[], mode: "replace" | "toggle" | "union"): Selection[] {
  if (mode === "replace") {
    const seen = new Set<string>();
    const out: Selection[] = [];
    for (const s of incoming) {
      const k = selKey(s.anchor);
      if (!seen.has(k)) {
        seen.add(k);
        out.push(s);
      }
    }
    return out;
  }
  if (mode === "toggle") {
    const s = incoming[0];
    if (!s) return prev;
    const k = selKey(s.anchor);
    return prev.some((p) => selKey(p.anchor) === k) ? prev.filter((p) => selKey(p.anchor) !== k) : [...prev, s];
  }
  // union
  const keys = new Set(prev.map((p) => selKey(p.anchor)));
  const add: Selection[] = [];
  for (const s of incoming) {
    const k = selKey(s.anchor);
    if (!keys.has(k)) {
      keys.add(k);
      add.push(s);
    }
  }
  return [...prev, ...add];
}

/** The result of a completed pointer gesture (click/marquee) — counts the UI can turn into a toast. */
export interface SelectResult {
  source: "click" | "marquee";
  selected: number;
  excluded: number;
}

type Resolved = { table: TableBox | null; cell: CellHit | null; hit: BlockHit | null };

// Active pointer-drag bookkeeping. `empty` resolves async (was the press on empty space?); `resolved`
// caches the click hit; `id` guards against a superseding press landing its async resolve late.
type Drag = {
  id: number;
  page: number;
  startX: number;
  startY: number;
  curX: number;
  curY: number;
  startClientX: number;
  startClientY: number;
  meta: boolean;
  empty: boolean | null;
  marqueeing: boolean;
  resolved?: Resolved;
};

export class SelectionModel {
  private sels: Selection[] = [];
  private marquee: SelMarquee | null = null;
  private drag: Drag | null = null;
  private dragSeq = 0;

  private changed = new Emitter<Selection[]>();
  private marqueeChanged = new Emitter<SelMarquee | null>();
  private results = new Emitter<SelectResult>();
  private errors = new Emitter<unknown>();

  constructor(private adapter: EngineAdapter) {}

  // ── getters ──────────────────────────────────────────────────────────────
  getSelection(): Selection[] {
    return this.sels;
  }
  getAnchors(): Anchor[] {
    return this.sels.map((s) => s.anchor);
  }
  getMarks(): Selection["mark"][] {
    return this.sels.map((s) => s.mark);
  }
  getMarquee(): SelMarquee | null {
    return this.marquee;
  }

  // ── subscriptions ────────────────────────────────────────────────────────
  /** Fires with the new selection array whenever it changes. */
  onChange(l: (sels: Selection[]) => void): () => void {
    return this.changed.on(l);
  }
  /** Fires with the marquee rect (or null when cleared) as a drag draws/ends it. */
  onMarqueeChange(l: (m: SelMarquee | null) => void): () => void {
    return this.marqueeChanged.on(l);
  }
  /** Fires when a gesture completes, with selected/excluded counts (the UI formats the toast copy). */
  onResult(l: (r: SelectResult) => void): () => void {
    return this.results.on(l);
  }
  /** Fires when an adapter query throws (e.g. a wasm trap); the UI decides recovery/toast. */
  onError(l: (e: unknown) => void): () => void {
    return this.errors.on(l);
  }

  // ── commands ─────────────────────────────────────────────────────────────
  private setSelection(next: Selection[]): void {
    this.sels = next;
    this.changed.emit(next);
  }
  private setMarquee(m: SelMarquee | null): void {
    this.marquee = m;
    this.marqueeChanged.emit(m);
  }

  /** Clear the whole selection + any in-progress marquee (Esc / document open / applied edit). */
  clear(): void {
    this.drag = null;
    if (this.marquee) this.setMarquee(null);
    this.setSelection([]);
  }

  /** Directly replace the selection with a list of hits (used by e.g. host-driven select-all). */
  select(sels: Selection[]): void {
    this.setSelection(sels);
  }

  // Resolve a page-local point to (table, cell, block-band). Priority for anchoring is cell > table >
  // block (issue 023); we query the cell only when a table was hit AND the backend supports the optional
  // `tableCellAt` (a backend that omits it → whole-table marking, 021 parity).
  private async resolveHit(page: number, x: number, y: number): Promise<Resolved> {
    const table = await this.adapter.tableAt(page, x, y);
    const cell = table && this.adapter.tableCellAt ? await this.adapter.tableCellAt(page, x, y) : null;
    const hit = table ? null : await this.adapter.hitTest(page, x, y);
    return { table, cell, hit };
  }

  /** pointerdown: record the drag origin + resolve (async) whether it landed on EMPTY space, so a drag
   *  from empty starts a marquee while a drag from a block does not. Returns a Promise that resolves once
   *  the async "empty" probe lands (React fires it fire-and-forget; node tests can await it). */
  async pointerDown(input: PointerInput): Promise<void> {
    const id = ++this.dragSeq;
    this.drag = {
      id,
      page: input.page,
      startX: input.x,
      startY: input.y,
      curX: input.x,
      curY: input.y,
      startClientX: input.client?.x ?? input.x,
      startClientY: input.client?.y ?? input.y,
      meta: input.mod,
      empty: null,
      marqueeing: false,
    };
    if (this.marquee) this.setMarquee(null);
    try {
      const { table, cell, hit } = await this.resolveHit(input.page, input.x, input.y);
      // "empty" = not over a table AND not STRICTLY inside a block band (hitTest returns the nearest band
      // even in a gap, so re-check strict containment rather than trust a non-null hit).
      const strictInside = !!hit && input.x >= hit.x && input.x <= hit.x + hit.w && input.y >= hit.y && input.y <= hit.y + hit.h;
      const d = this.drag;
      if (d && d.id === id) {
        d.empty = !table && !strictInside;
        d.resolved = { table, cell, hit };
      }
    } catch (e) {
      this.errors.emit(e);
    }
  }

  /** pointermove: past the threshold, an EMPTY-origin drag becomes a marquee (dashed rect), clipped to
   *  the START page (v1: single-page marquee). Synchronous — only reads already-resolved drag state. */
  pointerMove(input: PointerInput): void {
    const d = this.drag;
    if (!d || input.page !== d.page) return; // ignore moves that stray onto another page (clip to start)
    d.curX = input.x;
    d.curY = input.y;
    if (!d.marqueeing) {
      const cx = input.client?.x ?? input.x;
      const cy = input.client?.y ?? input.y;
      const moved = Math.hypot(cx - d.startClientX, cy - d.startClientY) > DRAG_THRESHOLD_PX;
      if (!moved) return;
      if (d.empty !== true) return; // only empty-space drags marquee (null = still resolving → wait)
      if (!this.adapter.blocksInRect) return; // backend can't answer a rect query → no marquee
      d.marqueeing = true;
    }
    const x = Math.min(d.startX, d.curX);
    const y = Math.min(d.startY, d.curY);
    this.setMarquee({ page: d.page, box: { x, y, w: Math.abs(d.curX - d.startX), h: Math.abs(d.curY - d.startY) } });
  }

  /** pointerup: finish a marquee (query blocksInRect) or a click (resolve → anchor). */
  async pointerUp(_input?: PointerInput): Promise<void> {
    const d = this.drag;
    this.drag = null;
    if (this.marquee) this.setMarquee(null);
    if (!d) return;
    if (d.marqueeing) await this.finishMarquee(d);
    else await this.finishClick(d);
  }

  private async finishMarquee(d: Drag): Promise<void> {
    if (!this.adapter.blocksInRect) return;
    const x0 = Math.min(d.startX, d.curX);
    const y0 = Math.min(d.startY, d.curY);
    const x1 = Math.max(d.startX, d.curX);
    const y1 = Math.max(d.startY, d.curY);
    try {
      const hits = await this.adapter.blocksInRect(d.page, x0, y0, x1, y1);
      const sels: Selection[] = [];
      let excluded = 0;
      for (const h of hits) {
        const s = blockHitToSel(h, d.page);
        if (s) sels.push(s);
        else excluded++;
      }
      if (sels.length === 0 && !d.meta) this.setSelection([]);
      else this.setSelection(mergeSelection(this.sels, sels, d.meta ? "union" : "replace"));
      this.results.emit({ source: "marquee", selected: sels.length, excluded });
    } catch (e) {
      this.errors.emit(e);
    }
  }

  private async finishClick(d: Drag): Promise<void> {
    try {
      // The async resolve didn't land before pointerup (a very fast click) → resolve now.
      const r = d.resolved ?? (await this.resolveHit(d.page, d.startX, d.startY));
      const sel = deriveSel(d.page, r.table, r.cell, r.hit);
      if (!sel) {
        if (!d.meta) this.setSelection([]); // a plain click on nothing clears
        this.results.emit({ source: "click", selected: 0, excluded: 0 });
        return;
      }
      this.setSelection(mergeSelection(this.sels, [sel], d.meta ? "toggle" : "replace"));
      this.results.emit({ source: "click", selected: 1, excluded: 0 });
    } catch (e) {
      this.errors.emit(e);
    }
  }

  /** Remove the i-th selection item (anchor chip ✕). */
  removeAt(i: number): void {
    this.setSelection(this.sels.filter((_, k) => k !== i));
  }
}
