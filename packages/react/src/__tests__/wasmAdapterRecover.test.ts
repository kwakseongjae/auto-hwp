// issue 052 — WasmAdapter trap recovery: SNAPSHOT-FIRST re-open + the autosave mutation signal.
//
// The engine module is mocked (no wasm): a fake HwpDoc whose applyIntent can be armed to throw a
// `{code:"wasm_trap"}` (what @auto-hwp/engine surfaces on a real wasm panic), and whose open() can be
// armed to REJECT specific bytes (a corrupt snapshot). This locks the recovery contract:
//   1. trap → resetEngine → re-open from the LATEST RecoverySnapshotSource bytes (snapshot-first),
//      onRecovered({source:"snapshot"}), and the trap is STILL rethrown (the UI toasts + re-fetches).
//   2. snapshot open fails → engine reset AGAIN (the bad open may itself poison) → original bytes
//      fallback + onRecovered({source:"original", reason}) — honest, never a false "복구됨".
//   3. no source wired → original bytes (the pre-052 behavior, unchanged).
//   4. onMutation fires ONLY on successful content mutations (applyIntent / effective undo / effective
//      replace) — never on open/read paths, so an un-edited doc is never snapshotted.
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── engine mock ──────────────────────────────────────────────────────────────────────────────────────
const engineState = {
  trapNextApply: false,
  rejectOpenBytes: null as Uint8Array | null,
  opens: [] as { bytes: Uint8Array; name?: string }[],
  resetCalls: 0,
  undoResult: true,
  replaced: 0,
};

vi.mock("@auto-hwp/engine", () => {
  const trap = () => Object.assign(new Error("wasm trap — poisoned"), { code: "wasm_trap" });
  class FakeDoc {
    static open(bytes: Uint8Array, name?: string) {
      engineState.opens.push({ bytes, name });
      if (engineState.rejectOpenBytes && bytes === engineState.rejectOpenBytes) throw trap();
      return new FakeDoc();
    }
    pageCount() {
      return 3;
    }
    renderPageSvg() {
      return "<svg/>";
    }
    applyIntent(intent: unknown) {
      if (engineState.trapNextApply) {
        engineState.trapNextApply = false;
        throw trap();
      }
      const s = typeof intent === "string" ? intent : JSON.stringify(intent);
      if (s.includes('"Replace"')) return { kind: "replaced", replaced: engineState.replaced, pages: 3 };
      return { kind: "ok" };
    }
    undo() {
      return engineState.undoResult;
    }
    redo() {
      return engineState.undoResult;
    }
    registerFont() {}
    toHwpx() {
      return new Uint8Array([9, 9, 9]);
    }
    free() {}
  }
  return {
    HwpDoc: FakeDoc,
    initEngine: vi.fn(async () => ({})),
    resetEngine: vi.fn(async () => {
      engineState.resetCalls++;
      return {};
    }),
  };
});

import { WasmAdapter } from "../WasmAdapter";
import type { RecoveryInfo } from "../WasmAdapter";

const ORIGINAL = new Uint8Array([1, 2, 3]);
const SNAPSHOT = new Uint8Array([7, 7, 7, 7]);

async function openAdapter(): Promise<WasmAdapter> {
  const a = new WasmAdapter();
  await a.open(ORIGINAL, "doc.hwp");
  return a;
}

beforeEach(() => {
  engineState.trapNextApply = false;
  engineState.rejectOpenBytes = null;
  engineState.opens = [];
  engineState.resetCalls = 0;
  engineState.undoResult = true;
  engineState.replaced = 0;
});

describe("issue 052 — trap recovery, snapshot-first", () => {
  it("trap → snapshot bytes re-open + onRecovered(snapshot) + the trap still rethrows", async () => {
    const a = await openAdapter();
    a.setRecoverySource(() => ({ bytes: SNAPSHOT, label: "rev 4" }));
    const infos: RecoveryInfo[] = [];
    a.onRecovered = (i) => infos.push(i);

    engineState.trapNextApply = true;
    await expect(a.applyIntent({ intent: "X" } as never)).rejects.toMatchObject({ code: "wasm_trap" });

    expect(engineState.resetCalls).toBe(1);
    const last = engineState.opens[engineState.opens.length - 1];
    expect(last.bytes).toBe(SNAPSHOT); // snapshot-first, NOT the original
    expect(infos).toEqual([{ source: "snapshot", label: "rev 4" }]);
    // The document is live again: reads work without another open.
    await expect(a.pageCount()).resolves.toBe(3);
    // The snapshot BECAME the current bytes: a second trap (source now empty) recovers from it.
    a.setRecoverySource(() => null);
    engineState.trapNextApply = true;
    await expect(a.applyIntent({ intent: "X" } as never)).rejects.toMatchObject({ code: "wasm_trap" });
    expect(engineState.opens[engineState.opens.length - 1].bytes).toBe(SNAPSHOT);
    expect(infos[infos.length - 1]).toEqual({ source: "original", reason: undefined });
  });

  it("corrupt snapshot → engine reset AGAIN + honest original fallback with the reason", async () => {
    const a = await openAdapter();
    a.setRecoverySource(() => ({ bytes: SNAPSHOT }));
    engineState.rejectOpenBytes = SNAPSHOT; // the snapshot open itself traps
    const infos: RecoveryInfo[] = [];
    a.onRecovered = (i) => infos.push(i);

    engineState.trapNextApply = true;
    await expect(a.applyIntent({ intent: "X" } as never)).rejects.toMatchObject({ code: "wasm_trap" });

    expect(engineState.resetCalls).toBe(2); // once for the trap, once more after the bad snapshot open
    expect(engineState.opens[engineState.opens.length - 1].bytes).toBe(ORIGINAL);
    expect(infos).toHaveLength(1);
    expect(infos[0].source).toBe("original");
    expect(infos[0].reason).toContain("snapshot open failed");
  });

  it("no recovery source → original bytes (pre-052 behavior unchanged)", async () => {
    const a = await openAdapter();
    engineState.trapNextApply = true;
    await expect(a.applyIntent({ intent: "X" } as never)).rejects.toMatchObject({ code: "wasm_trap" });
    expect(engineState.opens[engineState.opens.length - 1].bytes).toBe(ORIGINAL);
  });

  it("a throwing snapshot source never breaks recovery (original fallback + reason)", async () => {
    const a = await openAdapter();
    a.setRecoverySource(() => {
      throw new Error("idb dead");
    });
    const infos: RecoveryInfo[] = [];
    a.onRecovered = (i) => infos.push(i);
    engineState.trapNextApply = true;
    await expect(a.applyIntent({ intent: "X" } as never)).rejects.toMatchObject({ code: "wasm_trap" });
    expect(engineState.opens[engineState.opens.length - 1].bytes).toBe(ORIGINAL);
    expect(infos[0].reason).toContain("snapshot source failed");
  });
});

describe("issue 052 — onMutation (autosave trigger)", () => {
  it("fires on successful applyIntent, effective undo/redo, and effective replace — not on reads/open", async () => {
    const a = await openAdapter();
    let fired = 0;
    a.onMutation = () => fired++;

    expect(fired).toBe(0); // open() never fires it
    await a.pageCount();
    await a.pageSvg(0);
    expect(fired).toBe(0); // reads never fire it

    await a.applyIntent({ intent: "X" } as never);
    expect(fired).toBe(1);

    engineState.undoResult = true;
    await a.undo();
    await a.redo();
    expect(fired).toBe(3);

    engineState.undoResult = false; // empty stack: graceful no-op must NOT fire
    await a.undo();
    await a.redo();
    expect(fired).toBe(3);

    engineState.replaced = 2;
    await a.replace("a", "b", { all: true });
    expect(fired).toBe(4);
    engineState.replaced = 0; // no match: replace(0) must NOT fire
    await a.replace("zz", "b", { all: true });
    expect(fired).toBe(4);
  });

  it("a throwing onMutation observer does not fail the edit", async () => {
    const a = await openAdapter();
    a.onMutation = () => {
      throw new Error("observer bug");
    };
    await expect(a.applyIntent({ intent: "X" } as never)).resolves.toMatchObject({ kind: "ok" });
  });

  it("a failed applyIntent (trap) does not fire onMutation", async () => {
    const a = await openAdapter();
    let fired = 0;
    a.onMutation = () => fired++;
    engineState.trapNextApply = true;
    await expect(a.applyIntent({ intent: "X" } as never)).rejects.toMatchObject({ code: "wasm_trap" });
    expect(fired).toBe(0);
  });
});
