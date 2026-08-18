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
import { type RangeRect, rectsByProbe, selRange } from "./caretRange";
import { Emitter } from "./events";
import type { RunStyle } from "./runs";
import type { DocSession } from "./session";
import type { CellAddr, CellCaretRect, CellTextHit, RunSpec } from "./types";

/** The MODEL half of a cell caret: the cell address + the editor-space (para, offset) within it. */
export interface CellCaretAnchor {
  section: number;
  block: number;
  row: number;
  col: number;
  /** Descending CellPath for a nested leaf (issue #48). Absent / length ≤ 1 = the flat 053 lane. */
  path?: CellAddr[];
  /** "\n"-segment ordinal within the cell (the editor paragraph — see the module header). */
  para: number;
  /** Char offset within that paragraph, `0..=paraLen` (never counts a "\n"). */
  offset: number;
  /** 선택 범위의 **고정단**(shift 를 누르기 시작한 자리 — DOM Selection 의 anchor). `offset` 이 이동단
   *  (focus)이라 캐럿 막대는 늘 `offset` 에 선다. 둘이 같으면 범위 없음 = 그냥 캐럿. 본문 캐럿과 **같은
   *  규약**(caretRange.ts). */
  selAnchor: number;
  /** The paragraph's char count — the clamp bound for caret moves. */
  paraLen: number;
}

/** True when `path` is a nested (≥2) CellPath that must use the path commit/read lane (A2). */
export function isNestedPath(path?: CellAddr[]): path is CellAddr[] {
  return !!path && path.length > 1;
}

function pathKey(path: CellAddr[]): string {
  return path.map((s) => `${s.block}.${s.row}.${s.col}`).join("/");
}

function samePath(a: CellAddr[], b: CellAddr[]): boolean {
  return a.length === b.length && a.every((s, i) => s.block === b[i].block && s.row === b[i].row && s.col === b[i].col);
}

function leafRowCol(hit: CellTextHit): { row: number; col: number } {
  if (isNestedPath(hit.path)) {
    const last = hit.path[hit.path.length - 1];
    return { row: last.row, col: last.col };
  }
  return { row: hit.row ?? 0, col: hit.col ?? 0 };
}

function sameCellPara(a: Pick<CellCaretAnchor, "section" | "block" | "row" | "col" | "para" | "path">, hit: CellTextHit): boolean {
  if (a.section !== hit.section || a.block !== hit.block || a.para !== hit.para) return false;
  if (isNestedPath(a.path) || isNestedPath(hit.path)) {
    return isNestedPath(a.path) && isNestedPath(hit.path) && samePath(a.path, hit.path);
  }
  return a.row === (hit.row ?? 0) && a.col === (hit.col ?? 0);
}

/** A live cell caret: the model anchor + its geometry (own-render PAGE px + the owning page). */
export interface CellCaretState {
  anchor: CellCaretAnchor;
  rect: CellCaretRect;
  /** 선택 범위의 줄별 하이라이트(범위가 없으면 빈 배열) — 오버레이가 그대로 그린다. */
  rects: RangeRect[];
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
  const chars = explodeRuns(runs);
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
  const chars = explodeRuns(runs);
  const end = Math.min(Math.max(0, at), chars.length);
  const start = Math.max(0, end - Math.max(0, del));
  // Inherit for the insertion: nearest non-separator char before the caret; else the char after; else
  // scan back past separators; else unstyled (shared with the 059 IME preview via inheritFromChars).
  const insStyle = inheritFromChars(chars, start, end);
  return regroupRuns([...chars.slice(0, start), ...[...insert].map((ch) => ({ ch, style: insStyle })), ...chars.slice(end)]);
}

/** One char of a paragraph/cell text with the run style it carries — the intermediate form every
 *  run-preserving edit works in (splice / range styling). */
type Ch = { ch: string; style: RunStyle };

/** Runs → per-char array (styles attached). The inverse of `regroupRuns`. */
function explodeRuns(runs: RunSpec[]): Ch[] {
  const chars: Ch[] = [];
  for (const r of runs) {
    const style = styleOf(r);
    for (const ch of r.text) chars.push({ ch, style });
  }
  return chars;
}

/** Per-char array → runs: consecutive same-style chars merge; every "\n" is its own BARE separator run
 *  (the exact shape `blockRuns` reads back and `SetTableCellRuns` splits on). A fully-cleared text
 *  yields one empty run ("clear, don't no-op"). */
function regroupRuns(chars: Ch[]): RunSpec[] {
  const out: RunSpec[] = [];
  for (const c of chars) {
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

/** The character style attributes a range toggle can flip (booleans only — 크기/색/글꼴 은 리본의 몫). */
export type ToggleKey = "bold" | "italic" | "underline" | "strike";

/** True when EVERY char of `[start, end)` already carries `key` (the toggle's "켜져 있다" test — 부분만
 *  굵은 선택에 ⌘B 를 누르면 전체가 굵어지는 워드프로세서 관례). An empty range is `false`. */
export function rangeHasStyle(runs: RunSpec[], start: number, end: number, key: ToggleKey): boolean {
  const chars = explodeRuns(runs);
  const s = Math.max(0, Math.min(start, chars.length));
  const e = Math.max(0, Math.min(end, chars.length));
  if (e <= s) return false;
  for (let i = s; i < e; i++) if (chars[i].ch !== "\n" && chars[i].style[key] !== true) return false;
  return true;
}

/** Set/clear ONE boolean char attribute over `[start, end)`, preserving every other attribute of every
 *  run (색/크기/글꼴/이웃 런) — the run-preserving twin of `spliceRuns` for 부분 서식. Pure + total
 *  (offsets clamp); the text is untouched, so a commit through `SetParagraphRuns`/`SetTableCellRuns`
 *  changes formatting only. */
export function styleRunRange(runs: RunSpec[], start: number, end: number, key: ToggleKey, on: boolean): RunSpec[] {
  const chars = explodeRuns(runs);
  const s = Math.max(0, Math.min(start, chars.length));
  const e = Math.max(0, Math.min(end, chars.length));
  const next = chars.map((c, i) => {
    if (i < s || i >= e || c.ch === "\n") return c;
    const style: RunStyle = { ...c.style };
    if (on) style[key] = true;
    else delete style[key];
    return { ch: c.ch, style };
  });
  return regroupRuns(next);
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
  /** 마우스 글자 드래그가 현재 셀 문단을 소유하는 동안의 고정 주소. */
  private dragging: Pick<CellCaretAnchor, "section" | "block" | "row" | "col" | "para" | "path"> | null = null;
  /** 포인터 종료 뒤 늦은 cell hit가 드래그 소유권을 되살리지 못하게 하는 취소 세대. */
  private dragGeneration = 0;
  /** offset → caret rect 메모(현재 주소 한정 — `memoKey` 가 바뀌면 버린다). 범위 하이라이트가 오프셋을
   *  훑어야 해서 생긴 캐시. */
  private rectMemo = new Map<number, CellCaretRect | null>();
  private memoKey = "";

  constructor(
    private adapter: EngineAdapter,
    private session: DocSession,
  ) {
    // 기하 캐시는 **레이아웃이 바뀌면 전부 거짓말**이 된다 — 우리 커밋뿐 아니라 바깥의 ⌘Z/AI 적용/문서
    // 교체도 마찬가지다. 세션의 무효화 신호 하나에 묶어 버린다(캐시가 캐럿을 엉뚱한 자리에 그리지 않게).
    this.session.onLayoutInvalidated(() => this.rectMemo.clear());
  }

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
    this.dragGeneration++;
    this.dragging = null;
    this.rectMemo.clear();
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

  /** Resolve a PAGE-LOCAL px click to a cell caret. `null` (and a cleared caret) off any cell text.
   *  `extend` (Shift+클릭) keeps the CURRENT 고정단 when the click lands in the SAME cell paragraph —
   *  otherwise it starts a fresh caret (다른 셀/문단으로의 범위는 v1 밖: 커밋 대상이 하나가 아니다). */
  clickAt(page: number, x: number, y: number, extend = false): Promise<CellCaretState | null> {
    if (!this.supported) return Promise.resolve(null);
    return this.enqueue(async () => {
      const hit = (await this.adapter.hitTestCellText!(page, x, y)) ?? null;
      if (!hit) {
        this.clear();
        return null;
      }
      if (isNestedPath(hit.path) && !this.adapter.blockRunsPath) {
        // 중첩 leaf 는 읽기 경로(blockRunsPath)까지 있어야 심는다(018: 부재=기능 off) — 없으면
        // 입력이 조용히 무시되는 죽은 캐럿이 된다. 백엔드가 배선될 때까지(#51) 표 선택으로 강등.
        this.clear();
        return null;
      }
      const prev = extend ? this.state?.anchor : undefined;
      const same = prev && sameCellPara(prev, hit);
      const offset = clampOffset(hit.offset, hit.para_len);
      const { row, col } = leafRowCol(hit);
      const anchor: CellCaretAnchor = {
        section: hit.section,
        block: hit.block,
        row,
        col,
        para: hit.para,
        offset,
        selAnchor: same ? prev!.selAnchor : offset,
        paraLen: hit.para_len,
      };
      if (isNestedPath(hit.path)) anchor.path = hit.path;
      return this.publish(anchor, hit.caret);
    });
  }

  /** 마우스 텍스트 드래그 시작. 현재 캐럿과 **같은 셀 문단**의 글리프에서 시작할 때만 소유한다. */
  beginDragAt(page: number, x: number, y: number): Promise<boolean> {
    if (!this.supported) return Promise.resolve(false);
    const generation = ++this.dragGeneration;
    this.dragging = null;
    return this.enqueue(async () => {
      const a = this.state?.anchor;
      if (!a) return false;
      const hit = (await this.adapter.hitTestCellText!(page, x, y)) ?? null;
      if (generation !== this.dragGeneration) return false;
      if (!hit || !sameCellPara(a, hit)) {
        return false;
      }
      const offset = clampOffset(hit.offset, hit.para_len);
      this.dragging = {
        section: a.section,
        block: a.block,
        row: a.row,
        col: a.col,
        para: a.para,
        path: a.path,
      };
      await this.publish({ ...a, offset, selAnchor: offset, paraLen: hit.para_len }, hit.caret);
      return true;
    });
  }

  /** 소유한 드래그의 focus를 옮긴다. 다른 셀/문단으로 넘어가면 마지막 유효 focus를 유지하므로
   *  커밋 주소는 언제나 시작 셀 문단 하나에 머문다(멀티 블록 범위는 v1 밖). */
  dragTo(page: number, x: number, y: number): Promise<boolean> {
    return this.enqueue(async () => {
      const a = this.state?.anchor;
      const d = this.dragging;
      if (!a || !d) return false;
      const hit = (await this.adapter.hitTestCellText!(page, x, y)) ?? null;
      if (!hit || !sameCellPara(d, hit)) return true; // 소유권은 유지하되 범위는 마지막 유효 오프셋에 클램프
      await this.publish({ ...a, offset: clampOffset(hit.offset, a.paraLen) }, hit.caret);
      return true;
    });
  }

  /** 포인터 종료/취소. 범위는 남기고 드래그 주소만 놓는다. */
  endDrag(): void {
    this.dragGeneration++;
    this.dragging = null;
  }

  /** Move the caret by `delta` chars within the current paragraph (arrow keys), clamped to
   *  `[0, paraLen]`. Crossing into the previous/next paragraph is v1-out-of-scope (clamp instead).
   *  A LIVE range COLLAPSES to its near edge instead of moving one char (워드프로세서 관례). */
  move(delta: number): Promise<CellCaretState | null> {
    return this.enqueue(async () => {
      const a = this.state?.anchor;
      if (!a || !this.adapter.caretRectCell) return null;
      const { start, end } = selRange(a.selAnchor, a.offset);
      const offset = end > start && delta !== 0 ? (delta < 0 ? start : end) : clampOffset(a.offset + delta, a.paraLen);
      return this.publish({ ...a, offset, selAnchor: offset });
    });
  }

  /** Shift+방향키 — 고정단은 그대로 두고 이동단(focus)만 옮겨 범위를 넓히거나 줄인다. */
  extend(delta: number): Promise<CellCaretState | null> {
    return this.enqueue(async () => {
      const a = this.state?.anchor;
      if (!a || !this.adapter.caretRectCell) return null;
      return this.publish({ ...a, offset: clampOffset(a.offset + delta, a.paraLen) });
    });
  }

  /** ⌘A — 이 셀 문단 전체를 선택한다(셀 하나가 편집 단위라 문서 전체가 아니다). */
  selectAll(): Promise<CellCaretState | null> {
    return this.enqueue(async () => {
      const a = this.state?.anchor;
      if (!a || !this.adapter.caretRectCell) return null;
      return this.publish({ ...a, selAnchor: 0, offset: a.paraLen });
    });
  }

  /** Home/End — move to the first/last offset of the CURRENT visual line (leaf line info, issue #48).
   *  Uses the same `caretRectCell` probe as range highlights so a nested path walks the leaf, not
   *  the outer table. */
  moveToLineEnd(which: "start" | "end"): Promise<CellCaretState | null> {
    return this.enqueue(async () => {
      const a = this.state?.anchor;
      if (!a || !this.adapter.caretRectCell) return null;
      const here = await this.probeRect(a, a.offset);
      if (!here) return null;
      let target = a.offset;
      for (let o = 0; o <= a.paraLen; o++) {
        const r = await this.probeRect(a, o);
        if (!r || r.page !== here.page || Math.abs(r.top - here.top) > 0.05) continue;
        if (which === "start") {
          target = o;
          break;
        }
        target = o;
      }
      return this.publish({ ...a, offset: target, selAnchor: target });
    });
  }

  /** Insert `text` at the caret as ONE `SetTableCellRuns` undo unit (per-keystroke commit lane).
   *  A "\n" in `text` splits the paragraph (Enter). 범위가 살아 있으면 그 범위를 **대체**한다.
   *  Resolves false when no caret is active. */
  insertText(text: string): Promise<boolean> {
    return this.enqueue(() => this.splice(text, 0));
  }

  /** Backspace: 범위가 있으면 그 범위를 지우고, 없으면 캐럿 **앞** 한 글자(또는 문단 구분자 — 문단 병합)를
   *  지운다. A caret at the very start of the cell with no range is a graceful no-op (resolves false). */
  deleteBack(): Promise<boolean> {
    return this.enqueue(() => this.splice("", 1));
  }

  /** ⌘B/⌘I 등 — 선택 **범위에만** 굵게/기울임/밑줄/취소선을 토글한다(범위 전체가 이미 켜져 있으면 끈다).
   *  같은 `SetTableCellRuns` 커밋 레인이라 undo 하나. 범위가 없으면 조용한 false. */
  toggleStyle(key: ToggleKey): Promise<boolean> {
    return this.enqueue(async () => {
      const a = this.state?.anchor;
      if (!a || !this.supported) return false;
      const { start, end } = selRange(a.selAnchor, a.offset);
      if (end <= start) return false;
      const runs = await this.readRuns(a);
      if (!runs) return false;
      const joined = runsText(runs);
      const g0 = cellGlobalOffset(joined, a.para, start);
      const g1 = cellGlobalOffset(joined, a.para, end);
      const on = !rangeHasStyle(runs, g0, g1, key);
      const nextRuns = styleRunRange(runs, g0, g1, key, on);
      await this.session.applyBatch([this.commitIntent(a, nextRuns)]);
      this.rectMemo.clear(); // 서식은 글자 폭을 바꾼다 — 캐시된 기하는 버린다
      await this.publish({ ...a });
      return true;
    });
  }

  /** The run style the composing/typed text will take at the current caret (059 — IME preview 스타일
   *  소스). Read-only (no intent, no undo unit); `null` when no caret is live or the backend can't answer.
   *  NOT enqueued — it's a pure read that never mutates the caret, so it can run alongside a key burst. */
  async styleAtCaret(): Promise<RunStyle | null> {
    const a = this.state?.anchor;
    if (!a || !this.supported) return null;
    const runs = await this.readRuns(a);
    if (!runs) return null;
    const joined = runsText(runs);
    const global = cellGlobalOffset(joined, a.para, a.offset);
    return inheritStyleAt(runs, global);
  }

  /** One `caretRectCell` probe, MEMOIZED per address — a Shift+방향키 하나가 범위 전체의 줄 하이라이트를
   *  다시 물어보므로(엔진엔 "구간 기하" 표면이 없다) 같은 오프셋을 반복해서 왕복하지 않게 한다. 커밋/주소
   *  변경/해제 때 버린다(기하가 달라지므로). */
  private async probeRect(a: CellCaretAnchor, offset: number): Promise<CellCaretRect | null> {
    const key = isNestedPath(a.path)
      ? `${a.section}/${pathKey(a.path)}/${a.para}`
      : `${a.section}/${a.block}/${a.row}/${a.col}/${a.para}`;
    if (this.memoKey !== key) {
      this.memoKey = key;
      this.rectMemo.clear();
    }
    if (this.rectMemo.has(offset)) return this.rectMemo.get(offset)!;
    const r =
      (await this.adapter.caretRectCell!(
        a.section,
        a.block,
        a.row,
        a.col,
        a.para,
        offset,
        isNestedPath(a.path) ? a.path : undefined,
      )) ?? null;
    this.rectMemo.set(offset, r);
    return r;
  }

  private async readRuns(a: CellCaretAnchor): Promise<RunSpec[] | null> {
    if (isNestedPath(a.path)) {
      if (!this.adapter.blockRunsPath) return null;
      return (await this.adapter.blockRunsPath(a.section, a.path)) ?? [];
    }
    return (await this.adapter.blockRuns!(a.section, a.block, a.row, a.col)) ?? [];
  }

  private commitIntent(a: CellCaretAnchor, runs: RunSpec[]) {
    return isNestedPath(a.path)
      ? { intent: "SetTableCellRuns", section: a.section, index: a.block, row: a.row, col: a.col, path: a.path, runs }
      : { intent: "SetTableCellRuns", section: a.section, index: a.block, row: a.row, col: a.col, runs };
  }

  /** Resolve `anchor` to geometry (caret bar + 범위 하이라이트) and emit. Geometry 가 사라지면 018 대로
   *  캐럿을 지운다. `rect` 를 넘기면 그 값을 쓴다(클릭이 이미 받아온 히트). */
  private async publish(anchor: CellCaretAnchor, rect?: CellCaretRect): Promise<CellCaretState | null> {
    const bar = rect ?? (await this.probeRect(anchor, anchor.offset));
    if (!bar) {
      this.clear();
      return null;
    }
    const { start, end } = selRange(anchor.selAnchor, anchor.offset);
    const rects = end > start ? await rectsByProbe((o) => this.probeRect(anchor, o), start, end) : [];
    this.state = { anchor, rect: bar, rects };
    this.changed.emit(this.state);
    return this.state;
  }

  /** The shared read → splice → commit → re-anchor lane behind insertText/deleteBack. 범위가 살아 있으면
   *  `del` 은 그 범위 길이로 갈음된다(범위 위 타이핑 = 대체 · Backspace = 범위 삭제). */
  private async splice(insert: string, del: number): Promise<boolean> {
    const a = this.state?.anchor;
    if (!a || !this.supported) return false;
    const runs = await this.readRuns(a);
    if (!runs) return false;
    const joined = runsText(runs);
    const { start, end } = selRange(a.selAnchor, a.offset);
    const ranged = end > start;
    // 범위가 있으면 그 범위를 지운다(캐럿 앞 한 글자가 아니라). 커밋 좌표는 셀 전체 텍스트의 global 오프셋.
    const global = cellGlobalOffset(joined, a.para, ranged ? end : a.offset);
    const delChars = ranged ? cellGlobalOffset(joined, a.para, end) - cellGlobalOffset(joined, a.para, start) : del;
    if (delChars > 0 && global === 0) return false; // Backspace at the cell start — graceful no-op
    if (!ranged && delChars === 0 && insert.length === 0) return false;
    const nextRuns = spliceRuns(runs, global, delChars, insert);
    await this.session.applyBatch([this.commitIntent(a, nextRuns)]);
    // Re-anchor in the NEW text (the splice math is pure, so this needs no second read), then
    // re-resolve the rect against the post-edit geometry (the row may have grown/wrapped).
    const nextJoined = joined.slice(0, Math.max(0, global - delChars)) + insert + joined.slice(global);
    const at = cellParaOffsetAt(nextJoined, Math.max(0, global - delChars) + insert.length);
    this.rectMemo.clear(); // 편집으로 기하가 바뀌었다
    const anchor: CellCaretAnchor = { ...a, para: at.para, offset: at.offset, selAnchor: at.offset, paraLen: at.paraLen };
    // Geometry vanished (e.g. the cell left the page) → the edit stands; the caret goes away (018).
    await this.publish(anchor);
    return true;
  }
}
