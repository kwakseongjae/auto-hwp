import type { EngineAdapter } from "./adapter";
import type { DocSession } from "./session";
import type { FindMatch, FindOptions, MatchBox, ReplaceResult } from "./types";

/// FindController — the headless 찾기/바꾸기 engine (SDK-LAYERS L2, issue 045), DESCENDED from the desktop
/// Ctrl+F bar so the web and the new-shell desktop get the SAME feature from one code path. It drives the
/// engine's read-only `find` + one-undo-unit `replace` through the EngineAdapter (WasmAdapter = the Find/
/// Replace Intents over applyIntent JSON, TauriAdapter = the desktop find_text/replace_text commands —
/// 043 homomorphic parity), and holds the search STATE the FindBar renders: query, matches, and the
/// current-match cursor (n/m navigation).
///
/// Geometry (매치 하이라이트 + 스크롤-투-매치): a `FindMatch` carries only model/char coords — it has NO
/// page/box. Rather than invent a new engine query (엔진 신작 금지), we RESOLVE each match's box from the
/// SAME char coords through the EXISTING `caretRect` query (issue 041): `caretRect(node, start)` and
/// `caretRect(node, start+len)` bracket the match on its line, and probing pages finds the one it renders
/// on. When a backend omits `caretRect` (a lean wasm build without the rhwp glyph path), `locate` returns
/// null and the FindBar degrades to count + navigation only (하이라이트 스코프 축소 — 근거: docs 045).
///
/// Undo coherence (undo 실측): `replace` mutates through the adapter's NATIVE command, which the DocSession's
/// batch bookkeeping doesn't see; so after a successful replace the controller calls
/// `session.recordExternalEdit()` to push ONE undo batch (replace-all is ONE `do_ops` = ONE undo unit),
/// keeping `session.undo()` able to revert it and re-flowing the view (which also invalidates the matches).
export class FindController {
  private _query = "";
  private _opts: FindOptions = {};
  private _matches: FindMatch[] = [];
  private _cursor = -1; // index into `_matches`; -1 = no current match

  constructor(
    private readonly adapter: EngineAdapter,
    private readonly session: DocSession,
  ) {}

  // ── state getters ─────────────────────────────────────────────────────────
  /** The last searched query (may not match `_matches` if the doc changed since — call `refresh`). */
  get query(): string {
    return this._query;
  }
  /** The last search options. */
  get options(): FindOptions {
    return this._opts;
  }
  /** All matches from the last search (reading order). */
  get matches(): FindMatch[] {
    return this._matches;
  }
  /** How many matches were found. */
  get count(): number {
    return this._matches.length;
  }
  /** Index of the current match (−1 when none). */
  get cursor(): number {
    return this._cursor;
  }
  /** The current match, or null when there are none. */
  get current(): FindMatch | null {
    return this._cursor >= 0 ? this._matches[this._cursor] ?? null : null;
  }
  /** 1-based ordinal of the current match for the "n/m" readout (0 when none). */
  get ordinal(): number {
    return this._cursor >= 0 && this._matches.length ? this._cursor + 1 : 0;
  }
  /** Whether the backend can search/replace at all (both adapters do; a lean backend may omit it). */
  get supported(): boolean {
    return typeof this.adapter.find === "function";
  }
  /** Whether the backend can resolve match geometry (drives the highlight/scroll; count/nav work regardless). */
  get canLocate(): boolean {
    return typeof this.adapter.caretRect === "function";
  }

  // ── commands ──────────────────────────────────────────────────────────────
  /** Run a search: store query+opts, query the adapter, reset the cursor to the FIRST match (or −1).
   *  An empty query (or a backend without `find`) clears the matches without touching the engine. */
  async search(query: string, opts?: FindOptions): Promise<FindMatch[]> {
    this._query = query;
    this._opts = opts ?? {};
    if (!query || !this.adapter.find) {
      this._matches = [];
      this._cursor = -1;
      return this._matches;
    }
    this._matches = await this.adapter.find(query, this._opts);
    this._cursor = this._matches.length ? 0 : -1;
    return this._matches;
  }

  /** Re-run the CURRENT query/opts — the 함정 fix for stale match coords after an edit (refreshToken bump):
   *  a `SetParagraphRuns`/replace shifts char offsets, so the workspace calls this to invalidate + re-find.
   *  Preserves the cursor position when possible (clamped to the new count) so navigation feels continuous. */
  async refresh(): Promise<FindMatch[]> {
    const prevCursor = this._cursor;
    await this.search(this._query, this._opts);
    if (this._matches.length) this._cursor = Math.min(Math.max(prevCursor, 0), this._matches.length - 1);
    return this._matches;
  }

  /** Reset all state (the find bar closed). */
  clear(): void {
    this._query = "";
    this._opts = {};
    this._matches = [];
    this._cursor = -1;
  }

  /** Advance the cursor to the next match (wraps). Returns the new current match (or null when none). */
  next(): FindMatch | null {
    if (!this._matches.length) return null;
    this._cursor = (this._cursor + 1) % this._matches.length;
    return this.current;
  }

  /** Step the cursor to the previous match (wraps). Returns the new current match (or null when none). */
  prev(): FindMatch | null {
    if (!this._matches.length) return null;
    this._cursor = (this._cursor - 1 + this._matches.length) % this._matches.length;
    return this.current;
  }

  /** Replace the FIRST match in the document (the engine's `all:false` contract — NOT necessarily the
   *  cursor's match) as ONE undo unit, then record the undo batch + re-flow. Returns the count replaced
   *  (0 when nothing matched / no query / backend can't replace). The caller re-searches afterward. */
  async replaceCurrent(replacement: string): Promise<ReplaceResult> {
    return this.doReplace(replacement, false);
  }

  /** Replace EVERY match as ONE undo unit (`all:true`), record the batch + re-flow, return the count. */
  async replaceAll(replacement: string): Promise<ReplaceResult> {
    return this.doReplace(replacement, true);
  }

  private async doReplace(replacement: string, all: boolean): Promise<ReplaceResult> {
    if (!this._query || !this.adapter.replace) return { replaced: 0, pages: 0 };
    const res = await this.adapter.replace(this._query, replacement, { ...this._opts, all });
    // Only a real mutation records an undo unit + re-flows (a 0-count replace is a no-op — no undo, no
    // refresh), matching the no-op discipline the manual editor uses (issue 040 §no-op guard).
    if (res.replaced > 0) await this.session.recordExternalEdit();
    return res;
  }

  /** Resolve ONE match's on-page geometry from its char coords via the EXISTING `caretRect` query (no new
   *  engine work). Probes pages `[from, pageCount)` for the one the match's paragraph renders on (matches
   *  are in reading order, so pages are non-decreasing → the caller advances `from`). Returns null when
   *  `caretRect` is unavailable — the backend omits it, the node resolves on no page, OR `caretRect`
   *  REJECTS. The last case is load-bearing: the rhwp glyph-box path that answers `caretRect` only exists
   *  for an UNEDITED document, so after a replace/edit it throws ("edited docs render from the IR"). We
   *  swallow that to null (highlight/scroll degrade to count + navigation after an edit — the documented
   *  fallback), never crashing the search. */
  async locate(m: FindMatch, pageCount: number, from = 0): Promise<MatchBox | null> {
    const caretRect = this.adapter.caretRect?.bind(this.adapter);
    if (!caretRect) return null;
    for (let p = Math.max(0, from); p < pageCount; p++) {
      let a;
      try {
        a = await caretRect(p, m.node, m.start);
      } catch {
        return null; // caretRect unavailable for this doc (e.g. edited → rhwp render gone): no geometry
      }
      if (!a) continue;
      let b = null;
      try {
        b = await caretRect(p, m.node, m.start + m.len);
      } catch {
        /* keep the start caret; fall through to the one-glyph fallback below */
      }
      // A single-line match brackets start↔end on the SAME line; if it wrapped/clamped to another line
      // (or `b` is null), fall back to ~one glyph so the highlight is still visible (v1 single-line box).
      const sameLine = !!b && Math.abs(b.top - a.top) < Math.max(a.height, 1);
      const endX = sameLine ? b!.x : a.x + a.height * 0.6;
      const x = Math.min(a.x, endX);
      const w = Math.max(Math.abs(endX - a.x), 3);
      return { page: p, box: { x, y: a.top, w, h: a.height } };
    }
    return null;
  }

  /** Locate EVERY match's box for the highlight overlay, reusing a monotone page cursor so the whole pass
   *  is ~O(pages + matches), not O(pages × matches) — important for the Tauri backend (one IPC per query).
   *  Entries are null where geometry is unavailable. */
  async locateAll(pageCount: number): Promise<(MatchBox | null)[]> {
    const out: (MatchBox | null)[] = [];
    let from = 0;
    for (const m of this._matches) {
      const box = await this.locate(m, pageCount, from);
      if (box) from = box.page; // reading order ⇒ the next match is on this page or a later one
      out.push(box);
    }
    return out;
  }
}
