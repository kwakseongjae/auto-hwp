import type { EngineAdapter } from "./adapter";
import { Emitter } from "./events";
import type { Anchor, BlockHit, Box, CellAddr, CellHit, PointerInput, Selection, SelMarquee, TableBox, TableGrid } from "./types";
import { coreMessagesKoKR, type AnchorMessages, type CoreMessages } from "./messages";

/** The descending CellPath of a hit (issue 064 Tier-2): the engine's `cell.path`, or a synthesized
 *  length-1 `[{block, row, col}]` for a backend/mock that predates it (so a non-nested cell is unchanged). */
export function cellPathOf(cell: CellHit): CellAddr[] {
  return cell.path && cell.path.length > 0 ? cell.path : [{ block: cell.block, row: cell.row, col: cell.col }];
}

/** Whether two CellPaths address a cell of the SAME table (issue 064 Tier-2): equal ancestor chain +
 *  equal table block (the leaf `(row, col)` may differ). For length-1 paths this is "same top-level table
 *  block" — exactly the pre-Tier-2 `(section, block)` drill match. */
export function sameTable(a: CellAddr[], b: CellAddr[]): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  for (let i = 0; i < a.length - 1; i++) {
    if (a[i].block !== b[i].block || a[i].row !== b[i].row || a[i].col !== b[i].col) return false;
  }
  return a[a.length - 1].block === b[b.length - 1].block;
}

/// SelectionModel — the OS-style selection engine (issues 021 + 023), DESCENDED from @auto-hwp/react's
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
  // A NESTED cell (issue 064 Tier-2): fold the descending path so distinct nesting levels are DISTINCT
  // selections. A length-1 (or absent) path adds nothing → identical key to before (back-compat).
  const p = a.path && a.path.length > 1 ? ":" + a.path.map((s) => `${s.block}.${s.row}.${s.col}`).join(">") : "";
  return `${a.section}:${a.block}:${r}:${c}${p}`;
}

/** Cell chip label = a short text snippet + a 1-based "N행 M열" (issue 023). Empty cell → "표 N행 M열".
 *  The snippet is trimmed/whitespace-collapsed and elided to ~12 chars. */
export function cellLabel(cell: CellHit, messages: AnchorMessages = coreMessagesKoKR.anchor): string {
  const snip = cell.text.trim().replace(/\s+/g, " ").slice(0, 12);
  const where = messages.cellWhere(cell.row + 1, cell.col + 1);
  return snip ? messages.cellSnippet(snip, where) : messages.cellEmpty(where);
}

/** 정밀 선택(이슈 2) — the human label of a rectangular cell RANGE anchor. `rows`/`cols` are MODEL-GLOBAL
 *  0-based inclusive bounds; `tableCols` is the table's column count. A range that spans EVERY column is a
 *  whole-ROW selection ("표 8행 전체" / "표 6~8행 전체"); anything narrower names both axes
 *  ("표 2~4행 1~3열"). Pure — the React layer never re-derives chip text. */
export function rangeLabel(
  rows: [number, number],
  cols: [number, number],
  tableCols: number,
  messages: AnchorMessages = coreMessagesKoKR.anchor,
): string {
  const r = messages.rowsWhere(rows[0] + 1, rows[1] + 1);
  const wholeRow = tableCols > 0 && cols[0] === 0 && cols[1] >= tableCols - 1;
  return wholeRow ? messages.rangeWholeRows(r) : messages.rangeCells(r, messages.colsWhere(cols[0] + 1, cols[1] + 1));
}

/** 정밀 선택(이슈 2) — the anchor `text` of a cell RANGE: the covered cells of `grid`, one line per row,
 *  cells joined by " | ". Only ACTIVE cells inside the range appear (a merged/covered slot is simply
 *  absent, exactly like the doc-context grid). Elided to `maxLen` so a wide range can't blow the request
 *  budget. Returns "" when no grid is available (the anchor then rides text-less, as a table anchor does). */
export function rangeText(grid: TableGrid | null | undefined, rows: [number, number], cols: [number, number], maxLen = 1200): string {
  if (!grid) return "";
  const lines: string[] = [];
  for (let r = rows[0]; r <= rows[1]; r++) {
    const line = grid.cells
      .filter((c) => c.row === r && c.col >= cols[0] && c.col <= cols[1])
      .sort((a, b) => a.col - b.col)
      // 빈 셀은 지우지 않고 `_빈칸_` 로 남긴다 — doc-context 그리드와 같은 관례라, 좁은 앵커만 보내도
      // 모델이 "여기가 채워야 할 값칸"임을 안다(라벨칸 오타겟 방지, 066 규율).
      .map((c) => c.text.replace(/\s*\n\s*/g, " / ").trim() || "_빈칸_")
      .join(" | ");
    if (line) lines.push(line);
  }
  const out = lines.join("\n");
  return out.length > maxLen ? `${out.slice(0, maxLen)}…` : out;
}

/** Derive a Selection from a resolved click hit. Priority: CELL > table > block band (issue 023 — a
 *  click inside a table anchors the exact cell; a cell miss on a border/merged boundary falls back to
 *  the whole-table anchor, never an error). Coordinates are STRUCTURE indices, never px — a cell
 *  anchor's `rows`/`cols` are the MODEL-GLOBAL cell address `[r,r]`/`[c,c]` (CellHit.row is already
 *  global on a split fragment; NEVER re-add first_row). Returns null when the point resolved to nothing. */
export function deriveSel(page: number, table: TableBox | null, cell: CellHit | null, hit: BlockHit | null, messages: AnchorMessages = coreMessagesKoKR.anchor): Selection | null {
  if (cell) {
    const label = cellLabel(cell, messages);
    // Carry the descending CellPath (issue 064 Tier-2) so a NESTED cell anchor is a distinct selection
    // (selKey) AND the commit can walk to the LEAF cell. `undefined` for a length-1 (non-nested) path
    // keeps the anchor byte-compatible with the pre-Tier-2 shape.
    const path = cell.path && cell.path.length > 1 ? cell.path : undefined;
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
        path,
      },
    };
  }
  if (table) {
    const label = messages.tableAt(page + 1);
    return {
      mark: { page, box: { x: table.x, y: table.y, w: table.w, h: table.h }, label, kind: "table" },
      anchor: { kind: "table", section: table.section, block: table.block, label, page },
    };
  }
  if (hit) {
    const snip = hit.text.trim().replace(/\s+/g, " ").slice(0, 14);
    const kind = hit.kind === "table" ? "table" : hit.kind === "image" ? "image" : "paragraph";
    const label = kind === "paragraph" ? (snip ? messages.snippet(snip) : messages.paragraphAt(page + 1)) : messages.blockAt(kind, page + 1);
    return {
      mark: { page, box: { x: hit.x, y: hit.y, w: hit.w, h: hit.h }, label, kind },
      anchor: { kind: kind === "image" ? "paragraph" : (kind as Anchor["kind"]), section: hit.section, block: hit.block, label, page, text: hit.text },
    };
  }
  return null;
}

/** Convert a marquee BlockHit to a Selection, EXCLUDING unsupported kinds (images can't be anchored —
 *  issue §함정). Returns null for an excluded hit so the caller can count what was dropped. */
export function blockHitToSel(hit: BlockHit, page: number, messages: AnchorMessages = coreMessagesKoKR.anchor): Selection | null {
  if (hit.kind === "image") return null; // not an editable anchor target
  const snip = hit.text.trim().replace(/\s+/g, " ").slice(0, 14);
  const kind = hit.kind === "table" ? "table" : "paragraph";
  const label = kind === "paragraph" ? (snip ? messages.snippet(snip) : messages.paragraphAt(page + 1)) : messages.tableAt(page + 1);
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
  /// MULTI-PAGE marquee: the latest per-page sub-rects the UI computed for the current drag rect (each an
  /// own-render PAGE-px box on its page, START page included). `finishMarquee` queries `blocksInRect` once
  /// per slice and unions the hits. `undefined` = the single-page path (`pointerMove`) — finishMarquee then
  /// falls back to the start-page rect from `startX/Y`..`curX/Y`.
  slices?: { page: number; box: Box }[];
};

export class SelectionModel {
  /** issue 077 — the injected string catalog for anchor/mark labels. Defaults to Korean; the React
   *  binding assigns the host-merged catalog through EditorCore.setMessages(). */
  messages: CoreMessages = coreMessagesKoKR;
  private sels: Selection[] = [];
  private marquee: SelMarquee | null = null;
  private drag: Drag | null = null;
  private dragSeq = 0;
  // Worker hit-tests can finish out of order. `pointerUp()` captures its own Drag synchronously, then
  // settles clicks/marquees on this chain so an older slow click can never overwrite a newer fast click.
  // (The React shell must still CALL pointerUp at physical release time; deferring the call would let a
  // later pointerDown replace `this.drag` before it is captured.)
  private pointerUpChain: Promise<void> = Promise.resolve();
  /// Figma-style progressive drill state (issue 06x + 064 Tier-2): the CELL the user has DRILLED into (via
  /// a double-click / `drillInto`), as its `section` + descending `CellPath` (a STACK of `CellAddr` —
  /// length 1 for a top-level cell, ≥2 for a nested one). While set, a plain click on a cell of the SAME
  /// table (same ancestor chain + table block — `sameTable`) selects that CELL (stay drilled) instead of
  /// the whole table; a click on ANY other target (a different table/nesting level, a paragraph, empty
  /// space) resets it to `null`. `null` = not drilled → a table click marks the whole (innermost) table.
  private drill: { section: number; path: CellAddr[] } | null = null;

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
    this.rangeOrigin = null;
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

  /** pointermove for a MULTI-PAGE marquee: the UI supplies the per-page sub-rects it computed by
   *  intersecting the client-space drag rectangle with each page's client rect (the DOM math stays in the
   *  React layer — the core is DOM-free). A move that strays onto other pages is therefore NOT dropped
   *  (superseding `pointerMove`'s single-page clip): every intersected page rides in `slices`.
   *
   *  `client` is the CURRENT raw screen point (the drag threshold is measured zoom-independently against
   *  the press's client point). `slices` is every page the drag rect currently crosses, each with its OWN
   *  own-render PAGE-px box (START page included). Runs the SAME threshold + empty-origin gating as
   *  `pointerMove`, then publishes a marquee carrying all slices and records them for `finishMarquee`. */
  pointerMoveMultipage(client: { x: number; y: number }, slices: { page: number; box: Box }[]): void {
    const d = this.drag;
    if (!d) return;
    if (!d.marqueeing) {
      const moved = Math.hypot(client.x - d.startClientX, client.y - d.startClientY) > DRAG_THRESHOLD_PX;
      if (!moved) return;
      if (d.empty !== true) return; // only empty-space drags marquee (null = still resolving → wait)
      if (!this.adapter.blocksInRect) return; // backend can't answer a rect query → no marquee
      d.marqueeing = true;
    }
    d.slices = slices;
    // The START page's slice drives the back-compat `page`/`box`; every slice rides in `boxes` so each
    // page's overlay can draw its own portion. An empty `slices` (rect off every page) clears to a 0-box.
    const startSlice = slices.find((s) => s.page === d.page);
    const box = startSlice ? startSlice.box : { x: 0, y: 0, w: 0, h: 0 };
    this.setMarquee({ page: d.page, box, boxes: slices });
  }

  /** pointerup: capture this exact gesture immediately, then finish it in physical release order.
   *  `input` also closes the fast-drag gap: if pointermove happened before the async empty probe returned,
   *  release can still promote an empty-origin gesture to a marquee after resolving its origin. */
  async pointerUp(input?: PointerInput): Promise<void> {
    const d = this.drag;
    this.drag = null;
    if (this.marquee) this.setMarquee(null);
    if (!d) return;
    if (input) {
      d.curX = input.x;
      d.curY = input.y;
    }
    const settle = async () => {
      if (!d.marqueeing && input && this.adapter.blocksInRect) {
        const cx = input.client?.x ?? input.x;
        const cy = input.client?.y ?? input.y;
        const moved = Math.hypot(cx - d.startClientX, cy - d.startClientY) > DRAG_THRESHOLD_PX;
        if (moved) {
          const r = d.resolved ?? (await this.resolveHit(d.page, d.startX, d.startY));
          d.resolved = r;
          const strictInside =
            !!r.hit && d.startX >= r.hit.x && d.startX <= r.hit.x + r.hit.w && d.startY >= r.hit.y && d.startY <= r.hit.y + r.hit.h;
          d.marqueeing = !r.table && !strictInside;
        }
      }
      if (d.marqueeing) await this.finishMarquee(d);
      else await this.finishClick(d);
    };
    const queued = this.pointerUpChain.then(settle);
    // Keep the ordering lane alive even if a future finish path starts throwing instead of emitting.
    this.pointerUpChain = queued.catch((e) => this.errors.emit(e));
    await queued;
  }

  private async finishMarquee(d: Drag): Promise<void> {
    if (!this.adapter.blocksInRect) return;
    // The per-page sub-rects to query: the UI-supplied `slices` (multi-page) or, on the single-page
    // `pointerMove` path, the start-page rect derived from the drag origin/cursor. Each is queried
    // independently and the hits are UNIONED across pages; `blockHitToSel(h, page)` stamps the RIGHT page.
    const slices: { page: number; box: Box }[] =
      d.slices && d.slices.length > 0
        ? d.slices
        : [{ page: d.page, box: { x: Math.min(d.startX, d.curX), y: Math.min(d.startY, d.curY), w: Math.abs(d.curX - d.startX), h: Math.abs(d.curY - d.startY) } }];
    try {
      const sels: Selection[] = [];
      const seen = new Set<string>(); // dedup across pages (e.g. a split table hit on two page slices)
      let excluded = 0;
      for (const sl of slices) {
        const b = sl.box;
        const hits = await this.adapter.blocksInRect(sl.page, b.x, b.y, b.x + b.w, b.y + b.h);
        for (const h of hits) {
          const s = blockHitToSel(h, sl.page, this.messages.anchor);
          if (!s) {
            excluded++;
            continue;
          }
          const k = selKey(s.anchor);
          if (seen.has(k)) continue;
          seen.add(k);
          sels.push(s);
        }
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
        // (then the exact CELL, drill persists). "Same table" now compares the clicked cell's descending
        // CellPath (issue 064 Tier-2) so nested levels don't collide with the outer table's (section,
        // block). A table hit is always a selection (never a deselect).
        const clickPath = r.cell ? cellPathOf(r.cell) : null;
        const drilled =
          !!this.drill && !!clickPath && this.drill.section === r.table.section && sameTable(clickPath, this.drill.path);
        if (drilled && clickPath) {
          sel = deriveSel(d.page, r.table, r.cell, null, this.messages.anchor); // stay drilled → the clicked cell
          this.drill = { section: r.table.section, path: clickPath }; // move within the drilled table
        } else {
          sel = deriveSel(d.page, r.table, null, null, this.messages.anchor); // fresh table click → the whole table
          this.drill = null; // a fresh table selection is level-0 (never inherits a stale drill)
        }
      } else {
        // Non-table hit (paragraph / empty). DESELECT on empty space: `block_at` ignores x and falls back
        // to the vertically-nearest band, so `r.hit` is non-null even in a gap — re-apply the SAME strict-
        // containment test `pointerDown` uses (selection.ts:268) so a true empty-space click clears instead
        // of grabbing the nearest paragraph. (`r.cell` is always null here per resolveHit's contract.)
        const strictInside =
          !!r.hit && d.startX >= r.hit.x && d.startX <= r.hit.x + r.hit.w && d.startY >= r.hit.y && d.startY <= r.hit.y + r.hit.h;
        sel = strictInside ? deriveSel(d.page, null, r.cell, r.hit, this.messages.anchor) : null;
        this.drill = null; // leaving a table (paragraph / empty click) resets the drill
      }
      if (!sel) {
        if (!d.meta) this.setSelection([]); // a plain click on nothing clears (deselect)
        this.results.emit({ source: "click", selected: 0, excluded: 0 });
        return;
      }
      this.setSelection(mergeSelection(this.sels, [sel], d.meta ? "toggle" : "replace"));
      // 정밀 선택(이슈 2): a LONE-cell click becomes the shift-extend origin; anything else clears it.
      this.setRangeOrigin(d.page, this.sels.length === 1 ? this.sels[0] : null);
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
      // DESCEND to the cell under the point — its descending CellPath (issue 064 Tier-2) becomes the drill
      // stack. Because `resolveHit`/`tableCellAt` resolve the INNERMOST (nested) cell (topmost provenance
      // wins), a double-click over a nested grid drills straight to the nested LEAF; a subsequent
      // double-click on that same cell opens the editor (the React layer's `currentCell` compare).
      this.drill = { section: table.section, path: cell ? cellPathOf(cell) : [] };
      const sel = deriveSel(page, table, cell, null, this.messages.anchor);
      if (!sel) return null;
      this.setSelection(mergeSelection(this.sels, [sel], "replace"));
      this.setRangeOrigin(page, sel); // 정밀 선택(이슈 2): the drilled cell is the shift-extend origin
      this.results.emit({ source: "click", selected: 1, excluded: 0 });
      return sel;
    } catch (e) {
      this.errors.emit(e);
      return null;
    }
  }

  // ── 정밀 선택: 행 / 셀 범위 (이슈 2) ───────────────────────────────────────
  /// WHY: before this, the ONLY anchors a table could produce were "표 전체"(click) and ONE cell(drill) —
  /// `kind:"range"` existed in the Anchor type and in ai-protocol's `ANCHOR_KINDS` but NOTHING ever produced
  /// one (grep: zero producers). A user who wanted "이 행만 고쳐줘" had to hand the model the whole table.
  /// These two commands are the missing producers. They are pure ADDRESS commands (no new schema, no new
  /// Intent): a range anchor is `kind:"range"` + MODEL-GLOBAL inclusive `rows`/`cols` — exactly the shape
  /// `validateRequest`/`sanitizeAnchors` already accept (invariant 7 untouched: additive, nothing new).

  /** The cell a RANGE extends from (shift-click 원점). Set by every LONE-cell selection; cleared by a
   *  non-cell selection. Kept in the model (not the UI) so both shells extend identically. */
  private rangeOrigin: { section: number; block: number; page: number; row: number; col: number; box: Box } | null = null;

  /** Remember/forget the shift-extend origin. `null` = the current selection is not a lone cell. */
  private setRangeOrigin(page: number, sel: Selection | null): void {
    const a = sel?.anchor;
    if (a && a.kind === "cell" && a.rows && a.cols) {
      this.rangeOrigin = { section: a.section, block: a.block, page, row: a.rows[0], col: a.cols[0], box: sel!.mark.box };
    } else {
      this.rangeOrigin = null;
    }
  }

  /** The shift-extend origin (test/inspection seam). */
  getRangeOrigin(): { section: number; block: number; page: number; row: number; col: number } | null {
    const o = this.rangeOrigin;
    return o ? { section: o.section, block: o.block, page: o.page, row: o.row, col: o.col } : null;
  }

  /// Resolve a table's ON-PAGE fragment geometry: its column boundaries, its row boundaries, and the
  /// fragment's `first_row` + column count (from `tableAt`, probed at a cell centre so a mis-hit on a
  /// border can't decide it). Returns null when the backend can't answer (TauriAdapter parity: the caller
  /// then simply does nothing rather than inventing a box).
  private async fragmentGeometry(
    page: number,
    section: number,
    block: number,
  ): Promise<{ rowsB: number[]; colsB: number[]; firstRow: number; cols: number } | null> {
    if (!this.adapter.tableRowBoundaries || !this.adapter.tableColBoundaries) return null;
    const [rowsB, colsB] = await Promise.all([
      this.adapter.tableRowBoundaries(page, section, block),
      this.adapter.tableColBoundaries(page, section, block),
    ]);
    if (!rowsB || rowsB.length < 2 || !colsB || colsB.length < 2) return null;
    // `first_row` (split tables carry a per-fragment offset) comes from the placed TableBox. Probe cell
    // centres until one resolves to THIS table — a nested grid under the first probe must not decide it.
    let firstRow = 0;
    let cols = colsB.length - 1;
    for (let r = 0; r + 1 < rowsB.length; r++) {
      const y = (rowsB[r] + rowsB[r + 1]) / 2;
      const x = (colsB[0] + colsB[1]) / 2;
      const tb = await this.adapter.tableAt(page, x, y);
      if (tb && tb.section === section && tb.block === block) {
        firstRow = tb.first_row;
        cols = tb.cols || cols;
        break;
      }
    }
    return { rowsB, colsB, firstRow, cols };
  }

  /// cellBoxAt — 고스트 프리뷰(이슈 3)의 기하 절반: MODEL 주소 `(section, block, row, col)` → 그 페이지
  /// 조각에서의 셀 박스(own-render PAGE px). 엔진에 "주소로 셀 박스" 질의가 없으므로 행/열 경계 +
  /// `first_row` 로 조립한다(병합 셀은 그 원점 칸 크기로 근사 — 프리뷰 용도에선 정직한 근사).
  /// 그 행이 이 페이지 조각에 없으면 null → 호출자가 다음 페이지를 본다(분할표).
  async cellBoxAt(page: number, section: number, block: number, row: number, col: number): Promise<Box | null> {
    try {
      const geo = await this.fragmentGeometry(page, section, block);
      if (!geo) return null;
      const { rowsB, colsB, firstRow } = geo;
      const i = row - firstRow;
      if (i < 0 || i + 1 >= rowsB.length) return null;
      if (col < 0 || col + 1 >= colsB.length) return null;
      return { x: colsB[col], y: rowsB[i], w: colsB[col + 1] - colsB[col], h: rowsB[i + 1] - rowsB[i] };
    } catch (e) {
      this.errors.emit(e);
      return null;
    }
  }

  /// selectRows — mark WHOLE ROW(S) of a table as ONE `range` anchor (이슈 2). `row` is the MODEL-GLOBAL row
  /// index (the same space `SetTableCell.row` writes); `extend` grows the span from the current range/cell
  /// origin (shift-click on a row head) instead of replacing it. The mark box spans the full table width of
  /// the ON-PAGE fragment, so a split table marks only the rows visible on that page while the ANCHOR still
  /// names the global rows. Resolves the new Selection, or null when the geometry/backend can't answer.
  async selectRows(page: number, section: number, block: number, row: number, extend = false): Promise<Selection | null> {
    try {
      const geo = await this.fragmentGeometry(page, section, block);
      if (!geo) return null;
      const { rowsB, colsB, firstRow, cols } = geo;
      const lastGlobal = firstRow + rowsB.length - 2;
      const clamp = (r: number) => Math.min(Math.max(r, firstRow), lastGlobal);
      const target = clamp(row);
      // Extend from the previous ROW range (or lone-cell origin) when the user shift-clicks a second head.
      const prev = this.sels[this.sels.length - 1]?.anchor;
      const prevRow =
        extend && prev && (prev.kind === "range" || prev.kind === "cell") && prev.section === section && prev.block === block && prev.rows
          ? prev.rows[0]
          : null;
      const from = prevRow === null ? target : clamp(prevRow);
      const rows: [number, number] = [Math.min(from, target), Math.max(from, target)];
      const colRange: [number, number] = [0, Math.max(0, cols - 1)];
      const y0 = rowsB[rows[0] - firstRow];
      const y1 = rowsB[rows[1] - firstRow + 1];
      const box: Box = { x: colsB[0], y: y0, w: colsB[colsB.length - 1] - colsB[0], h: y1 - y0 };
      const label = rangeLabel(rows, colRange, cols, this.messages.anchor);
      const grid = this.adapter.tableGrid ? await this.adapter.tableGrid(section, block).catch(() => null) : null;
      const text = rangeText(grid, rows, colRange);
      const sel: Selection = {
        mark: { page, box, label, kind: "range" },
        anchor: { kind: "range", section, block, rows, cols: colRange, label, page, ...(text ? { text } : {}) },
      };
      this.drag = null;
      if (this.marquee) this.setMarquee(null);
      this.drill = null; // a row selection is its own level — a later plain click re-marks the table
      this.rangeOrigin = null;
      this.setSelection([sel]);
      this.results.emit({ source: "click", selected: 1, excluded: 0 });
      return sel;
    } catch (e) {
      this.errors.emit(e);
      return null;
    }
  }

  /// extendToCell — SHIFT-click inside a drilled table: grow the selection from the remembered origin cell
  /// to the clicked cell as ONE rectangular `range` anchor (이슈 2 — 셀 범위). With no origin (or a click in
  /// a DIFFERENT table) it degrades to a plain single-cell selection, never an error. The mark box is the
  /// union of the two cell rects — exactly the range rectangle for an unmerged grid.
  async extendToCell(page: number, x: number, y: number): Promise<Selection | null> {
    try {
      if (!this.adapter.tableCellAt) return null;
      const cell = await this.adapter.tableCellAt(page, x, y);
      if (!cell) return null;
      const o = this.rangeOrigin;
      if (!o || o.section !== cell.section || o.block !== cell.block || o.page !== page) {
        const sel = deriveSel(page, null, cell, null, this.messages.anchor);
        if (!sel) return null;
        this.setSelection(mergeSelection(this.sels, [sel], "replace"));
        this.setRangeOrigin(page, sel);
        this.results.emit({ source: "click", selected: 1, excluded: 0 });
        return sel;
      }
      const rows: [number, number] = [Math.min(o.row, cell.row), Math.max(o.row, cell.row)];
      const cols: [number, number] = [Math.min(o.col, cell.col), Math.max(o.col, cell.col)];
      const x0 = Math.min(o.box.x, cell.x);
      const y0 = Math.min(o.box.y, cell.y);
      const box: Box = {
        x: x0,
        y: y0,
        w: Math.max(o.box.x + o.box.w, cell.x + cell.w) - x0,
        h: Math.max(o.box.y + o.box.h, cell.y + cell.h) - y0,
      };
      const label = rangeLabel(rows, cols, cell.cols, this.messages.anchor);
      const grid = this.adapter.tableGrid ? await this.adapter.tableGrid(cell.section, cell.block).catch(() => null) : null;
      const text = rangeText(grid, rows, cols);
      const sel: Selection = {
        mark: { page, box, label, kind: "range" },
        anchor: { kind: "range", section: cell.section, block: cell.block, rows, cols, label, page, ...(text ? { text } : {}) },
      };
      this.drag = null;
      if (this.marquee) this.setMarquee(null);
      this.setSelection([sel]); // the range REPLACES the anchor cell (origin is kept for further extends)
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
  currentCell(): { section: number; block: number; row: number; col: number; path?: CellAddr[] } | null {
    if (this.sels.length !== 1) return null;
    const a = this.sels[0].anchor;
    if (a.kind !== "cell" || !a.rows || !a.cols) return null;
    // `path` is present only for a NESTED cell (issue 064 Tier-2); it is `undefined` for a plain
    // top-level cell, so `toEqual({section,block,row,col})` (which ignores undefined) is unaffected.
    return { section: a.section, block: a.block, row: a.rows[0], col: a.cols[0], path: a.path };
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
    const sel = deriveSel(page, null, cell, null, this.messages.anchor);
    if (!sel) return false;
    this.drag = null;
    if (this.marquee) this.setMarquee(null);
    this.setSelection([sel]);
    this.setRangeOrigin(page, sel); // 정밀 선택(이슈 2): keyboard nav also re-seeds the shift-extend origin
    return true;
  }
}
