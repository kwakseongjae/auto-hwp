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

/** A keyboard cell-navigation direction (issue 036). Spreadsheet/Figma arrow-key semantics. */
export type CellDir = "up" | "down" | "left" | "right";

/** How far PAST the current cell's box edge `moveCell` probes for the neighbour, in own-render PAGE px.
 *  A few px reliably clears the ~1px cell border and lands inside the (much wider) neighbour cell. */
const CELL_PROBE_PX = 3;

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
  /// Figma-style progressive drill state (issue 06x): the table the user has DRILLED into (via a
  /// double-click / `drillInto`). While set, a plain click INSIDE the same `(section, block)` selects the
  /// exact CELL (stay drilled) instead of the whole table; a click on ANY other target (a different table,
  /// a paragraph, an image, empty space) resets it to `null`, so the next click on a table re-selects the
  /// WHOLE table (drill level-0). `null` = not drilled → a table click marks the whole table.
  private drill: { section: number; block: number } | null = null;

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

  /** Clear the whole selection + any in-progress marquee (Esc / document open / applied edit). Also
   *  resets the Figma drill (issue 06x) so the next table click marks the whole table (drill level-0). */
  clear(): void {
    this.drag = null;
    this.drill = null;
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
      // Figma progressive drill (issue 06x) ∩ empty-space deselect (QA #2), merged:
      let sel: Selection | null;
      if (r.table) {
        // A table hit marks the WHOLE table unless the user has already DRILLED into this same table
        // (then the exact CELL, drill persists). A table hit is always a selection (never a deselect).
        const drilled = !!this.drill && this.drill.section === r.table.section && this.drill.block === r.table.block;
        if (drilled) {
          sel = deriveSel(d.page, r.table, r.cell, null); // stay drilled → the clicked cell
        } else {
          sel = deriveSel(d.page, r.table, null, null); // fresh table click → the whole table
          this.drill = null; // a fresh table selection is level-0 (never inherits a stale drill)
        }
      } else {
        // Non-table hit (paragraph / empty). DESELECT on empty space: `block_at` ignores x and falls back
        // to the vertically-nearest band, so `r.hit` is non-null even in a gap — re-apply the SAME strict-
        // containment test `pointerDown` uses (selection.ts:268) so a true empty-space click clears instead
        // of grabbing the nearest paragraph. (`r.cell` is always null here per resolveHit's contract.)
        const strictInside =
          !!r.hit && d.startX >= r.hit.x && d.startX <= r.hit.x + r.hit.w && d.startY >= r.hit.y && d.startY <= r.hit.y + r.hit.h;
        sel = strictInside ? deriveSel(d.page, null, r.cell, r.hit) : null;
        this.drill = null; // leaving a table (paragraph / empty click) resets the drill
      }
      if (!sel) {
        if (!d.meta) this.setSelection([]); // a plain click on nothing clears (deselect)
        this.results.emit({ source: "click", selected: 0, excluded: 0 });
        return;
      }
      this.setSelection(mergeSelection(this.sels, [sel], d.meta ? "toggle" : "replace"));
      this.results.emit({ source: "click", selected: 1, excluded: 0 });
    } catch (e) {
      this.errors.emit(e);
    }
  }

  /// drillInto — Figma DRILL-IN (issue 06x): the double-click / Enter path that descends from a whole-table
  /// selection into the exact CELL under `(x, y)`. Marks `(section, block)` as drilled so subsequent plain
  /// clicks inside the SAME table keep selecting cells (see `finishClick`), replaces the selection with the
  /// cell mark/anchor, and returns it. Resolves `null` when the point is NOT over a table (the caller then
  /// handles a paragraph double-click by opening its editor directly).
  async drillInto(page: number, x: number, y: number): Promise<Selection | null> {
    try {
      const { table, cell } = await this.resolveHit(page, x, y);
      if (!table) return null; // not a table → caller handles paragraph edit
      this.drill = { section: table.section, block: table.block };
      const sel = deriveSel(page, table, cell, null);
      if (!sel) return null;
      this.setSelection(mergeSelection(this.sels, [sel], "replace"));
      this.results.emit({ source: "click", selected: 1, excluded: 0 });
      return sel;
    } catch (e) {
      this.errors.emit(e);
      return null;
    }
  }

  /// currentCell — the address of the CURRENTLY-selected lone cell (issue 06x), or `null` when the selection
  /// is not exactly ONE cell anchor. The React layer uses it to decide "a double-click on the ALREADY-drilled
  /// cell opens the editor" vs "drill into a fresh cell": if this equals the clicked cell → open the editor.
  currentCell(): { section: number; block: number; row: number; col: number } | null {
    if (this.sels.length !== 1) return null;
    const a = this.sels[0].anchor;
    if (a.kind !== "cell" || !a.rows || !a.cols) return null;
    return { section: a.section, block: a.block, row: a.rows[0], col: a.cols[0] };
  }

  /** Remove the i-th selection item (anchor chip ✕). */
  removeAt(i: number): void {
    this.setSelection(this.sels.filter((_, k) => k !== i));
  }

  // ── keyboard cell navigation (issue 036) ──────────────────────────────────
  /** The single "active" CELL to navigate from = the LAST cell selection (spreadsheet: arrow keys move the
   *  one active cell). Non-cell selections are ignored. `null` when nothing cell-like is selected. */
  activeCell(): Selection | null {
    for (let i = this.sels.length - 1; i >= 0; i--) {
      if (this.sels[i].anchor.kind === "cell") return this.sels[i];
    }
    return null;
  }

  /// moveCell — keyboard cell navigation (issue 036). Move the active CELL selection ONE cell in `dir`,
  /// REPLACING the selection with the new cell (Figma/spreadsheet). There is no engine "cell box by
  /// address" query (and the engine is frozen), so we RE-PROBE `tableCellAt` a few px PAST the current
  /// cell's box edge — the adapter's own geometry decides the neighbour. Resolves `true` if the selection
  /// moved, `false` when it CLAMPED (a table/document boundary → stay put) or there is no active cell.
  ///
  /// MERGED-CELL RULE (measured against hwp-typeset place.rs — PlacedCell.w/h span the WHOLE merge:
  /// `cw = col_x[col+col_span] - col_x[col]`, and the cell address is the merge's TOP-LEFT origin). Because
  /// the mark box already spans the whole merged rectangle, probing PAST `box.x+box.w` / `box.y+box.h`
  /// lands in the cell AFTER the span — i.e. "다음 좌표 = span 끝+1" — with no col_span/row_span needed
  /// (CellHit does not even carry the span). Clamping is implicit: a probe off the table → `tableCellAt`
  /// null → no move.
  ///
  /// SPLIT TABLE (전역 row): a vertical probe that falls off the on-page fragment top/bottom re-tries on the
  /// ADJACENT page's fragment of the SAME `(section, block)` (issue 023 — the row is already model-global,
  /// so the next fragment's top row is exactly `row+1`). Needs `tableRowBoundaries`; a backend that omits it
  /// simply clamps at the page break (graceful, TauriAdapter parity).
  async moveCell(dir: CellDir): Promise<boolean> {
    const active = this.activeCell();
    if (!active || !this.adapter.tableCellAt) return false;
    const { page, box } = active.mark;
    const { section, block } = active.anchor;
    const r = active.anchor.rows?.[0] ?? 0;
    const c = active.anchor.cols?.[0] ?? 0;
    try {
      // 1) Same-page neighbour: probe just past the current cell's box edge in `dir`.
      let px: number;
      let py: number;
      switch (dir) {
        case "right": px = box.x + box.w + CELL_PROBE_PX; py = box.y + box.h / 2; break;
        case "left": px = box.x - CELL_PROBE_PX; py = box.y + box.h / 2; break;
        case "down": px = box.x + box.w / 2; py = box.y + box.h + CELL_PROBE_PX; break;
        case "up": px = box.x + box.w / 2; py = box.y - CELL_PROBE_PX; break;
      }
      const near = await this.adapter.tableCellAt(page, px, py);
      // Accept only a DIFFERENT cell of the SAME table (never re-select the current/merged-origin cell, and
      // never jump into a neighbouring/nested table — that clamps at this table's own boundary).
      if (near && near.section === section && near.block === block && !(near.row === r && near.col === c)) {
        return this.applyCellMove(page, near);
      }
      // 2) Vertical fall-through across a SPLIT-table page break (전역 row → next/prev fragment).
      if ((dir === "up" || dir === "down") && this.adapter.tableRowBoundaries) {
        const target = dir === "down" ? page + 1 : page - 1;
        if (target < 0) return false;
        let count = Infinity;
        try {
          count = await this.adapter.pageCount();
        } catch {
          /* fall through — the rowBoundaries null-guard below still protects an out-of-range query */
        }
        if (target >= count) return false;
        const rowB = await this.adapter.tableRowBoundaries(target, section, block);
        if (rowB && rowB.length >= 2) {
          const cx = box.x + box.w / 2; // columns align across fragments → the same absolute x holds
          const cy = dir === "down" ? rowB[0] + CELL_PROBE_PX : rowB[rowB.length - 1] - CELL_PROBE_PX;
          const cross = await this.adapter.tableCellAt(target, cx, cy);
          if (cross && cross.section === section && cross.block === block) return this.applyCellMove(target, cross);
        }
      }
    } catch (e) {
      this.errors.emit(e);
    }
    return false; // clamp: at a table/document boundary → stay put
  }

  // Replace the selection with the moved-to cell (deriveSel gives the same cell mark/anchor/label as a
  // click), clearing any drag/marquee. Returns true (the caller reports "moved").
  private applyCellMove(page: number, cell: CellHit): boolean {
    const sel = deriveSel(page, null, cell, null);
    if (!sel) return false;
    this.drag = null;
    if (this.marquee) this.setMarquee(null);
    this.setSelection([sel]);
    return true;
  }
}
