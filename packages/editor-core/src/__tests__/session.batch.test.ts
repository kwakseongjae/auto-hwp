import { describe, expect, it } from "vitest";
import { CellCaretController } from "../cellCaret";
import { TypingCoalescer } from "../coalesce";
import { DocSession } from "../session";
import type { BatchApplyOptions, BatchApplyResult, CellCaretRect, Intent } from "../types";
import { MockAdapter } from "./mockAdapter";

// #371 (atomic batch lane) · #369 (typing undo coalescing) · #372 (undo limits) — the DocSession half.
// The engine half (one snapshot per group, all-or-nothing, keyed join) is pinned by Rust tests in
// hwp-ops (`group_*`) and hwp-mcp (`atomic_batch_*`, `keyed_atomic_batches_coalesce`).

const edit = (text: string): Intent => ({ intent: "SetParagraphText", section: 0, block: 0, text });

/** A backend with the ATOMIC lane: models the engine contract (one unit per batch, keyed join,
 *  failure = no change) so DocSession's bookkeeping can be checked against it. */
class AtomicAdapter extends MockAdapter {
  calls: { intents: Intent[]; opts?: BatchApplyOptions }[] = [];
  units = 0; // engine undo units
  private engineKey: string | null = null;
  failAt = -1;
  async applyIntents(intents: Intent[], opts?: BatchApplyOptions): Promise<BatchApplyResult> {
    this.calls.push({ intents, opts });
    if (this.failAt >= 0 && this.failAt < intents.length) throw Object.assign(new Error(`intent[${this.failAt}]: boom`), { code: "batch_failed" });
    const key = opts?.coalesceKey ?? null;
    const joined = key !== null && opts?.coalesce !== false && key === this.engineKey && this.units > 0;
    if (!joined) this.units++;
    this.engineKey = key;
    return { applied: intents.length, pages: 1, changed: intents.length > 0, joined };
  }
  override async undo(): Promise<boolean> {
    this.engineKey = null;
    if (this.units === 0) return false;
    this.units--;
    return super.undo();
  }
}

describe("DocSession atomic batch lane (#371)", () => {
  it("sends the whole batch in ONE adapter call and records ONE undo step", async () => {
    const adapter = new AtomicAdapter();
    const session = new DocSession(adapter);
    expect(await session.applyBatch([edit("a"), edit("b"), edit("c")])).toBe(3);
    expect(adapter.calls).toHaveLength(1);
    expect(adapter.applied).toHaveLength(0); // never the per-intent lane
    expect(session.undoDepth()).toBe(1);
    expect(await session.undo()).toBe(true);
    expect(adapter.undos).toBe(1); // one engine undo for the whole batch
  });

  it("a failing atomic batch rethrows and records nothing (the engine already rolled back)", async () => {
    const adapter = new AtomicAdapter();
    const session = new DocSession(adapter);
    await session.applyBatch([edit("keep")]);
    adapter.failAt = 1;
    await expect(session.applyBatch([edit("x"), edit("y")])).rejects.toThrow(/boom/);
    expect(session.undoDepth()).toBe(1);
    expect(adapter.undos).toBe(0); // no JS-side rollback needed
  });

  it("an empty batch never reaches the engine", async () => {
    const adapter = new AtomicAdapter();
    const session = new DocSession(adapter);
    expect(await session.applyBatch([])).toBe(0);
    expect(adapter.calls).toHaveLength(0);
    expect(session.canUndo()).toBe(false);
  });
});

describe("typing undo coalescing (#369)", () => {
  const type = async (session: DocSession, co: TypingCoalescer, chars: string, start = 0) => {
    let at = start;
    for (const ch of chars) {
      await session.applyBatch([edit(ch)], { coalesceKey: co.keyFor("cell:0/1/0/0", at, ch) });
      at += ch.length;
    }
  };

  it('"ab c" → ⌘Z removes " c", ⌘Z again removes "ab"; redo replays the same groups (fallback lane)', async () => {
    const adapter = new MockAdapter();
    const session = new DocSession(adapter);
    await type(session, new TypingCoalescer(), "ab c");
    expect(adapter.applied).toHaveLength(4);
    expect(session.undoDepth()).toBe(2);
    await session.undo();
    expect(adapter.undos).toBe(2); // " c" = 2 engine units
    await session.undo();
    expect(adapter.undos).toBe(4); // "ab" = 2 engine units
    await session.redo();
    expect(adapter.redos).toBe(2);
    await session.redo();
    expect(adapter.redos).toBe(4);
  });

  it('"ab c" on the atomic lane: the ENGINE joins, so each word is ONE engine unit', async () => {
    const adapter = new AtomicAdapter();
    const session = new DocSession(adapter);
    await type(session, new TypingCoalescer(), "ab c");
    expect(adapter.calls.map((c) => c.opts?.coalesce)).toEqual([false, true, false, true]);
    expect(adapter.units).toBe(2);
    expect(session.undoDepth()).toBe(2);
    await session.undo();
    expect(adapter.undos).toBe(1);
    expect(adapter.units).toBe(1);
  });

  it("a pause longer than the window starts a new undo step", async () => {
    let t = 0;
    const session = new DocSession(new MockAdapter(), { coalesceWindowMs: 500, now: () => t });
    const co = new TypingCoalescer();
    await session.applyBatch([edit("a")], { coalesceKey: co.keyFor("p", 0, "a") });
    t = 400;
    await session.applyBatch([edit("b")], { coalesceKey: co.keyFor("p", 1, "b") });
    t = 1000;
    await session.applyBatch([edit("c")], { coalesceKey: co.keyFor("p", 2, "c") });
    expect(session.undoDepth()).toBe(2);
  });

  it("undo, an unkeyed batch, or breakCoalescing() ends the run", async () => {
    const session = new DocSession(new MockAdapter());
    const co = new TypingCoalescer();
    await session.applyBatch([edit("a")], { coalesceKey: co.keyFor("p", 0, "a") });
    await session.applyBatch([edit("x")]); // e.g. a style toggle
    await session.applyBatch([edit("b")], { coalesceKey: co.keyFor("p", 1, "b") });
    expect(session.undoDepth()).toBe(3);
    session.breakCoalescing();
    await session.applyBatch([edit("c")], { coalesceKey: co.keyFor("p", 2, "c") });
    expect(session.undoDepth()).toBe(4);
    await session.undo();
    await session.applyBatch([edit("c")], { coalesceKey: co.keyFor("p", 2, "c") });
    expect(session.undoDepth()).toBe(4); // re-typed after undo = a fresh step, not glued onto "b"
  });

  it("a failed keyed batch (fallback lane) still rolls back exactly its own ops", async () => {
    class Failing extends MockAdapter {
      fail = false;
      override async applyIntent(intent: Intent) {
        if (this.fail) throw new Error("nope");
        return super.applyIntent(intent);
      }
    }
    const adapter = new Failing();
    const session = new DocSession(adapter);
    const co = new TypingCoalescer();
    await session.applyBatch([edit("a")], { coalesceKey: co.keyFor("p", 0, "a") });
    adapter.fail = true;
    await expect(session.applyBatch([edit("b")], { coalesceKey: co.keyFor("p", 1, "b") })).rejects.toThrow("nope");
    expect(adapter.undos).toBe(0);
    expect(session.undoDepth()).toBe(1);
  });
});

describe("TypingCoalescer", () => {
  it("same word → same key; whitespace after a word, a caret jump, another target → new key", () => {
    const co = new TypingCoalescer();
    const a = co.keyFor("t", 0, "a");
    expect(co.keyFor("t", 1, "b")).toBe(a);
    const sp = co.keyFor("t", 2, " ");
    expect(sp).not.toBe(a);
    expect(co.keyFor("t", 3, "c")).toBe(sp);
    expect(co.keyFor("t", 0, "z")).not.toBe(sp); // caret moved
    expect(co.keyFor("u", 1, "y")).not.toBe(sp); // other cell
    expect(co.keyFor("u", 2, "\n")).toBeUndefined(); // Enter is its own step
  });
});

describe("cell caret typing → word-level undo (#369 acceptance)", () => {
  it('typing "ab c" into a cell leaves two undo steps', async () => {
    const rect: CellCaretRect = { page: 0, x: 100, top: 200, height: 13 };
    // A LIVE read: blockRuns returns whatever the last SetTableCellRuns committed (the stock mock is frozen).
    const adapter: MockAdapter = new MockAdapter({
      cellText: { section: 0, block: 1, row: 0, col: 0, para: 0, offset: 0, para_len: 0, caret: rect },
      cellCaret: rect,
      runs: () => {
        const last = adapter.applied[adapter.applied.length - 1] as { runs?: { text: string }[] } | undefined;
        return last?.runs ?? [];
      },
    });
    const session = new DocSession(adapter);
    const ctl = new CellCaretController(adapter, session);
    await ctl.clickAt(0, 5, 5);
    for (const ch of "ab c") await ctl.insertText(ch);
    expect(adapter.applied).toHaveLength(4);
    expect(session.undoDepth()).toBe(2);
  });
});

describe("undo limits + read parity (#372 · #371)", () => {
  it("setUndoLimits forwards to the engine and drops the oldest batches the engine evicted", async () => {
    class Limited extends AtomicAdapter {
      limits: [number, number | undefined] | null = null;
      async setUndoLimits(depth: number, budgetBytes?: number) {
        this.limits = [depth, budgetBytes];
        this.units = Math.min(this.units, depth);
      }
      async undoStats() {
        return { snapshots: this.units, bytes: 0 };
      }
    }
    const adapter = new Limited();
    const session = new DocSession(adapter);
    for (let i = 0; i < 5; i++) await session.applyBatch([edit(`e${i}`)]);
    expect(await session.setUndoLimits(3)).toBe(true);
    expect(adapter.limits).toEqual([3, 0]);
    expect(session.undoDepth()).toBe(3);
    expect(await new DocSession(new MockAdapter()).setUndoLimits(3)).toBe(false);
  });

  it("cellFits / pageUsage degrade to null / [] on a backend without them", async () => {
    const session = new DocSession(new MockAdapter());
    expect(await session.cellFits(0, 1)).toBeNull();
    expect(await session.pageUsage()).toEqual([]);
  });
});
