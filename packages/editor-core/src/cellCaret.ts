// Cell-addressed glyph caret (issue 053 — CARET-GAP §5 P1, the 042 승계) — pure model helpers + the
// headless controller. DOM-free; the React layer draws the caret from `onChange` via a ref (render-0).
//
// ## Address space — the EDITOR ("\n"-split) space, end to end
// The engine's `HitTestCell`/`CaretRectCell` address a caret as `(section, block, row, col, para,
// offset)`, where `para` counts the cell text's "\n"-separated segments — the SAME space `blockRuns`
// reads (paragraphs joined by bare "\n" runs) and `SetTableCellRuns` writes (every "\n" splits a
// paragraph). So the joined-text global offset used to splice runs is EXACT:
//   global = Σ(paraLen_i + 1  for i < para) + offset
// with no ambiguity between paragraph separators and forced line breaks (the engine already reports
// forced breaks as segment boundaries).
//
// ## Contracts pinned here (mirroring caret.ts / 018)
//  1. null policy — a click off any cell text is `null`; an unresolvable address is `null`; neither
//     ever throws. `clear()` is the only other way the caret goes away.
//  2. paraLen clamp — the engine CLAMPS a past-end offset (returns a rect, never null for it); the
//     controller clamps its own moves to `[0, paraLen]` via `clampOffset`.
//  3. Commits go ONLY through `SetTableCellRuns` (§4.1-5 — the run-preserving variant), one intent
//     per keystroke = one undo unit, dispatched through `DocSession.applyBatch` so the layout
//     invalidation / undo bookkeeping stay coherent with every other edit lane.

import type { EngineAdapter } from "./adapter";
import { clampOffset } from "./caret";
import { Emitter } from "./events";
import type { RunStyle } from "./runs";
import type { DocSession } from "./session";
import type { CellCaretRect, CellTextHit, RunSpec } from "./types";

/** The MODEL half of a cell caret: the cell address + the editor-space (para, offset) within it. */
export interface CellCaretAnchor {
  section: number;
  block: number;
  row: number;
  col: number;
  /** "\n"-segment ordinal within the cell (the editor paragraph — see the module header). */
  para: number;
  /** Char offset within that paragraph, `0..=paraLen` (never counts a "\n"). */
  offset: number;
  /** The paragraph's char count — the clamp bound for caret moves. */
  paraLen: number;
}

/** A live cell caret: the model anchor + its geometry (own-render PAGE px + the owning page). */
export interface CellCaretState {
  anchor: CellCaretAnchor;
  rect: CellCaretRect;
}

// ---- pure helpers (exported for node tests) ----------------------------------------------------

/** The joined editor text of a `blockRuns` result (paragraphs separated by the bare "\n" runs). */
export function runsText(runs: RunSpec[]): string {
  return runs.map((r) => r.text).join("");
}

/** Global (joined-text) char offset of the editor-space `(para, offset)` — clamped into the text. */
export function cellGlobalOffset(joined: string, para: number, offset: number): number {
  const paras = joined.split("\n");
  const p = Math.min(Math.max(0, para), paras.length - 1);
  let base = 0;
  for (let i = 0; i < p; i++) base += paras[i].length + 1;
  return base + clampOffset(offset, paras[p].length);
}

/** Inverse of `cellGlobalOffset`: the `(para, offset, paraLen)` at a global joined-text offset. */
export function cellParaOffsetAt(joined: string, global: number): { para: number; offset: number; paraLen: number } {
  const g = Math.min(Math.max(0, global), joined.length);
  let para = 0;
  let segStart = 0;
  for (let i = 0; i < g; i++) {
    if (joined[i] === "\n") {
      para++;
      segStart = i + 1;
    }
  }
  const segEnd = joined.indexOf("\n", segStart);
  const paraLen = (segEnd === -1 ? joined.length : segEnd) - segStart;
  return { para, offset: g - segStart, paraLen };
}

const STYLE_KEYS = ["bold", "italic", "underline", "strike", "size_pt", "color", "highlight", "font"] as const;

function styleOf(r: RunSpec): RunStyle {
  const out: RunStyle = {};
  for (const k of STYLE_KEYS) {
    const v = r[k];
    if (v !== undefined && v !== false) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

function sameStyle(a: RunStyle, b: RunStyle): boolean {
  return STYLE_KEYS.every((k) => (a[k] ?? undefined) === (b[k] ?? undefined));
}

/** The style inserted text INHERITS between char positions `start..end` of an exploded char array:
 *  nearest non-"\n" char before `start`, else the char at `end`, else scan back past separators, else
 *  unstyled. The single source of the "typing continues the style you're in" rule (spliceRuns + the 059
 *  IME preview both read it). */
function inheritFromChars(chars: { ch: string; style: RunStyle }[], start: number, end: number): RunStyle {
  const prev = chars[start - 1];
  if (prev && prev.ch !== "\n") return prev.style;
  const next = chars[end];
  if (next && next.ch !== "\n") return next.style;
  for (let i = start - 2; i >= 0; i--) if (chars[i].ch !== "\n") return chars[i].style;
  return {};
}

/** The run style text typed/composed at joined-text offset `at` will take — the SAME inherit rule
 *  `spliceRuns` applies (with del=0). Pure + read-only; exported so the 059 IME composition preview can
 *  style its overlay exactly like the coming text (styleOf 재사용) without a commit. */
export function inheritStyleAt(runs: RunSpec[], at: number): RunStyle {
  const chars: { ch: string; style: RunStyle }[] = [];
  for (const r of runs) {
    const style = styleOf(r);
    for (const ch of r.text) chars.push({ ch, style });
  }
  const end = Math.min(Math.max(0, at), chars.length);
  return inheritFromChars(chars, end, end);
}

/** Splice a cell's runs at the joined-text offset `at`: delete `del` chars ENDING at `at`, then
 *  insert `insert` there — preserving every untouched run's style and INHERITING the style of the
 *  nearest non-"\n" char before the caret for the inserted text (typing continues the style you are
 *  in; a fresh/empty cell types unstyled). "\n" chars re-emit as BARE separator runs (the exact shape
 *  `blockRuns` reads back and `SetTableCellRuns` splits on), so a typed "\n" splits the paragraph.
 *  Pure + total: offsets are clamped, and a fully-cleared cell yields one empty run (the documented
 *  "clear, don't no-op" shape from `inheritRuns`). */
export function spliceRuns(runs: RunSpec[], at: number, del: number, insert: string): RunSpec[] {
  type Ch = { ch: string; style: RunStyle };
  const chars: Ch[] = [];
  for (const r of runs) {
    const style = styleOf(r);
    for (const ch of r.text) chars.push({ ch, style });
  }
  const end = Math.min(Math.max(0, at), chars.length);
  const start = Math.max(0, end - Math.max(0, del));
  // Inherit for the insertion: nearest non-separator char before the caret; else the char after; else
  // scan back past separators; else unstyled (shared with the 059 IME preview via inheritFromChars).
  const insStyle = inheritFromChars(chars, start, end);
  const next: Ch[] = [...chars.slice(0, start), ...[...insert].map((ch) => ({ ch, style: insStyle })), ...chars.slice(end)];
  // Re-group: consecutive same-style chars merge; every "\n" is its own bare run (separator parity).
  const out: RunSpec[] = [];
  for (const c of next) {
    if (c.ch === "\n") {
      out.push({ text: "\n" });
      continue;
    }
    const last = out[out.length - 1];
    if (last && last.text !== "\n" && sameStyle(styleOf(last), c.style)) {
      last.text += c.ch;
    } else {
      out.push({ text: c.ch, ...c.style });
    }
  }
  if (out.length === 0) out.push({ text: "" });
  return out;
}

// ---- controller ---------------------------------------------------------------------------------

/// CellCaretController — the headless cell caret: click → anchor+rect, arrow moves, per-keystroke
/// text commits. All async entry points are CHAINED (a fast key burst applies strictly in order —
/// each commit reads the runs the previous one wrote). Emits `onChange(state | null)`; the React
/// CaretLayer draws from that with zero workspace re-renders.
export class CellCaretController {
  private state: CellCaretState | null = null;
  private changed = new Emitter<CellCaretState | null>();
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private adapter: EngineAdapter,
    private session: DocSession,
  ) {}

  /** Whether this backend can answer cell caret queries at all (018: absent methods = feature off). */
  get supported(): boolean {
    return !!(this.adapter.hitTestCellText && this.adapter.caretRectCell && this.adapter.blockRuns);
  }

  get(): CellCaretState | null {
    return this.state;
  }

  onChange(l: (s: CellCaretState | null) => void): () => void {
    return this.changed.on(l);
  }

  /** Drop the caret (Escape / focus loss / document swap). Emits only when something was cleared. */
  clear(): void {
    if (this.state) {
      this.state = null;
      this.changed.emit(null);
    }
  }

  /** Queue `fn` after every previously queued operation (strict order under fast keystrokes). */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(fn);
    this.chain = p.catch(() => undefined);
    return p;
  }

  /** Resolve a PAGE-LOCAL px click to a cell caret. `null` (and a cleared caret) off any cell text. */
  clickAt(page: number, x: number, y: number): Promise<CellCaretState | null> {
    if (!this.supported) return Promise.resolve(null);
    return this.enqueue(async () => {
      const hit = (await this.adapter.hitTestCellText!(page, x, y)) ?? null;
      if (!hit) {
        this.clear();
        return null;
      }
      this.set(hit);
      return this.state;
    });
  }

  /** Move the caret by `delta` chars within the current paragraph (arrow keys), clamped to
   *  `[0, paraLen]`. Crossing into the previous/next paragraph is v1-out-of-scope (clamp instead). */
  move(delta: number): Promise<CellCaretState | null> {
    return this.enqueue(async () => {
      const a = this.state?.anchor;
      if (!a || !this.adapter.caretRectCell) return null;
      const offset = clampOffset(a.offset + delta, a.paraLen);
      const rect = (await this.adapter.caretRectCell(a.section, a.block, a.row, a.col, a.para, offset)) ?? null;
      if (!rect) {
        this.clear();
        return null;
      }
      this.state = { anchor: { ...a, offset }, rect };
      this.changed.emit(this.state);
      return this.state;
    });
  }

  /** Insert `text` at the caret as ONE `SetTableCellRuns` undo unit (per-keystroke commit lane).
   *  A "\n" in `text` splits the paragraph (Enter). Resolves false when no caret is active. */
  insertText(text: string): Promise<boolean> {
    return this.enqueue(() => this.splice(text, 0));
  }

  /** Backspace: delete the char (or paragraph separator — merging paragraphs) ENDING at the caret.
   *  A caret at the very start of the cell is a graceful no-op (resolves false). */
  deleteBack(): Promise<boolean> {
    return this.enqueue(() => this.splice("", 1));
  }

  /** The run style the composing/typed text will take at the current caret (059 — IME preview 스타일
   *  소스). Read-only (no intent, no undo unit); `null` when no caret is live or the backend can't answer.
   *  NOT enqueued — it's a pure read that never mutates the caret, so it can run alongside a key burst. */
  async styleAtCaret(): Promise<RunStyle | null> {
    const a = this.state?.anchor;
    if (!a || !this.supported) return null;
    const runs = await this.adapter.blockRuns!(a.section, a.block, a.row, a.col);
    const joined = runsText(runs);
    const global = cellGlobalOffset(joined, a.para, a.offset);
    return inheritStyleAt(runs, global);
  }

  private set(hit: CellTextHit): void {
    this.state = {
      anchor: {
        section: hit.section,
        block: hit.block,
        row: hit.row,
        col: hit.col,
        para: hit.para,
        offset: clampOffset(hit.offset, hit.para_len),
        paraLen: hit.para_len,
      },
      rect: hit.caret,
    };
    this.changed.emit(this.state);
  }

  /** The shared read → splice → commit → re-anchor lane behind insertText/deleteBack. */
  private async splice(insert: string, del: number): Promise<boolean> {
    const a = this.state?.anchor;
    if (!a || !this.supported) return false;
    const runs = await this.adapter.blockRuns!(a.section, a.block, a.row, a.col);
    const joined = runsText(runs);
    const global = cellGlobalOffset(joined, a.para, a.offset);
    if (del > 0 && global === 0) return false; // Backspace at the cell start — graceful no-op
    const nextRuns = spliceRuns(runs, global, del, insert);
    await this.session.applyBatch([
      { intent: "SetTableCellRuns", section: a.section, index: a.block, row: a.row, col: a.col, runs: nextRuns },
    ]);
    // Re-anchor in the NEW text (the splice math is pure, so this needs no second read), then
    // re-resolve the rect against the post-edit geometry (the row may have grown/wrapped).
    const nextJoined = joined.slice(0, Math.max(0, global - del)) + insert + joined.slice(global);
    const at = cellParaOffsetAt(nextJoined, Math.max(0, global - del) + insert.length);
    const anchor: CellCaretAnchor = { ...a, para: at.para, offset: at.offset, paraLen: at.paraLen };
    const rect =
      (await this.adapter.caretRectCell!(anchor.section, anchor.block, anchor.row, anchor.col, anchor.para, anchor.offset)) ??
      null;
    if (!rect) {
      // Geometry vanished (e.g. the cell left the page) — the edit stands; the caret goes away (018).
      this.state = null;
      this.changed.emit(null);
      return true;
    }
    this.state = { anchor, rect };
    this.changed.emit(this.state);
    return true;
  }
}
