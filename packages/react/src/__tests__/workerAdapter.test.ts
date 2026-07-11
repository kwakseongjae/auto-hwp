// issue 055 (FG-14) — WasmAdapter WORKER MODE: the RPC bridge + the 052 recovery contract over it.
//
// A FAKE Worker (in-process, protocol-faithful to @tf-hwp/engine/worker.js) stands in for the real
// module worker — jsdom has no Worker. It can be armed to (a) answer normally, (b) surface a
// worker-side {code:"wasm_trap"} (what worker.js sends after a real wasm panic), or (c) DIE
// (fire onerror), so this locks:
//   1. the plain RPC round-trip (open → pages, call → result, byte results intact);
//   2. trap → reset op INSIDE THE SAME WORKER → snapshot-first re-open (052 parity, no respawn);
//   3. WORKER DEATH → every in-flight call rejects {code:"worker_dead"} → recovery RESPAWNS a fresh
//      worker (factory called again) + re-opens — the 055 "워커 죽음 = 인스턴스 중독" contract;
//   4. dispose() = intentional terminate → in-flight open rejects {code:"worker_terminated"}
//      (a CANCEL, not a crash — the host folds it silently), and a later open() respawns;
//   5. worker mode NEVER touches the main-thread engine module (initEngine/resetEngine uncalled).
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── main-thread engine mock: worker mode must never call it (assertion #5) ──────────────────────────
const mainEngine = { init: vi.fn(async () => ({})), reset: vi.fn(async () => ({})) };
vi.mock("@tf-hwp/engine", () => ({
  HwpDoc: class {
    static open() {
      throw new Error("worker mode must not open on the main thread");
    }
  },
  initEngine: () => mainEngine.init(),
  resetEngine: () => mainEngine.reset(),
}));

import { WasmAdapter } from "../WasmAdapter";
import type { RecoveryInfo } from "../WasmAdapter";

// ── the fake worker (protocol-faithful to packages/engine/worker.js) ────────────────────────────────
const state = {
  spawns: 0,
  resets: 0,
  inits: 0,
  opens: [] as { bytes: Uint8Array; name?: string }[],
  trapNextApply: false,
  rejectOpenBytes: null as Uint8Array | null,
  /** Park the next `open` op without replying — models a long parse (the cancel/dispose window). */
  hangNextOpen: false,
  edits: 0,
  workers: [] as FakeWorker[],
};

class FakeWorker {
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: { message?: string }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminated = false;
  hasDoc = false;
  /** Arm to swallow the next request (no reply) and fire onerror instead — a mid-call worker death. */
  dieOnNextRequest = false;

  constructor() {
    state.spawns++;
    state.workers.push(this);
  }

  postMessage(msg: { id: number; op: string; args?: Record<string, unknown> }): void {
    if (this.terminated) return;
    if (this.dieOnNextRequest) {
      this.dieOnNextRequest = false;
      queueMicrotask(() => this.onerror?.({ message: "worker crashed" }));
      return;
    }
    if (msg.op === "open" && state.hangNextOpen) {
      state.hangNextOpen = false; // a parse that never finishes — only terminate() releases the caller
      return;
    }
    queueMicrotask(() => {
      if (this.terminated) return;
      try {
        const result = this.handle(msg.op, msg.args ?? {});
        this.onmessage?.({ data: { id: msg.id, ok: true, result } });
      } catch (e) {
        const err = e as { message?: string; code?: string };
        this.onmessage?.({ data: { id: msg.id, ok: false, error: { message: String(err.message ?? e), code: err.code } } });
      }
    });
  }

  private handle(op: string, args: Record<string, unknown>): unknown {
    const trap = () => Object.assign(new Error("wasm trap — poisoned"), { code: "wasm_trap" });
    switch (op) {
      case "init":
        state.inits++;
        return null;
      case "reset":
        state.resets++;
        this.hasDoc = false;
        return null;
      case "open": {
        const bytes = args.bytes as Uint8Array;
        state.opens.push({ bytes, name: args.name as string | undefined });
        if (state.rejectOpenBytes && bytes === state.rejectOpenBytes) throw trap();
        this.hasDoc = true;
        return { pages: 3 };
      }
      case "call": {
        if (!this.hasDoc) throw Object.assign(new Error("no document open"), { code: "no_document" });
        const method = args.method as string;
        if (method === "pageCount") return 3;
        if (method === "renderPageSvg") return `<svg data-page="${(args.params as unknown[])[0]}"/>`;
        if (method === "applyIntent") {
          if (state.trapNextApply) {
            state.trapNextApply = false;
            throw trap();
          }
          state.edits++;
          return { kind: "ok" };
        }
        if (method === "undo" || method === "redo") return true;
        if (method === "toHwpx") return new Uint8Array([9, 9, 9]);
        if (method === "exportPdf") return new Uint8Array([1, 2, 3, 4]);
        throw new Error(`unexpected method in test: ${method}`);
      }
      case "free":
        this.hasDoc = false;
        return null;
      default:
        throw new Error(`unknown op: ${op}`);
    }
  }

  terminate(): void {
    this.terminated = true;
  }
}

const ORIGINAL = new Uint8Array([1, 2, 3]);
const SNAPSHOT = new Uint8Array([7, 7, 7, 7]);

function makeAdapter(): WasmAdapter {
  return new WasmAdapter("http://localhost/hwp_wasm_bg.wasm", { worker: { factory: () => new FakeWorker() as unknown as Worker } });
}

async function openAdapter(): Promise<WasmAdapter> {
  const a = makeAdapter();
  await a.open(ORIGINAL, "doc.hwp");
  return a;
}

beforeEach(() => {
  state.spawns = 0;
  state.resets = 0;
  state.inits = 0;
  state.opens = [];
  state.trapNextApply = false;
  state.rejectOpenBytes = null;
  state.hangNextOpen = false;
  state.edits = 0;
  state.workers = [];
  mainEngine.init.mockClear();
  mainEngine.reset.mockClear();
});

describe("issue 055 — worker-mode RPC round-trip", () => {
  it("open/pageCount/pageSvg/undo run over the worker; byte results come back intact", async () => {
    const a = await openAdapter();
    expect(state.spawns).toBe(1);
    expect(state.opens[0]).toMatchObject({ bytes: ORIGINAL, name: "doc.hwp" });
    await expect(a.pageCount()).resolves.toBe(3);
    await expect(a.pageSvg(1)).resolves.toContain('data-page="1"');
    await expect(a.undo()).resolves.toBe(true);
    await expect(a.toHwpx()).resolves.toEqual(new Uint8Array([9, 9, 9]));
    await expect(a.exportPdf()).resolves.toEqual(new Uint8Array([1, 2, 3, 4]));
  });

  it("worker mode never touches the main-thread engine module", async () => {
    const a = await openAdapter();
    await a.pageCount();
    await a.applyIntent({ intent: "X" } as never);
    expect(mainEngine.init).not.toHaveBeenCalled();
    expect(mainEngine.reset).not.toHaveBeenCalled();
  });

  it("re-open on the SAME adapter reuses the worker (no teardown/respawn per document)", async () => {
    const a = await openAdapter();
    await a.open(new Uint8Array([5, 5]), "doc2.hwpx");
    expect(state.spawns).toBe(1); // same worker — the worker-side open op swaps the doc
    await expect(a.pageCount()).resolves.toBe(3);
  });
});

describe("issue 055 — trap inside the worker (052 recovery parity)", () => {
  it("trap → in-worker reset → snapshot-first re-open + onRecovered + the trap still rethrows", async () => {
    const a = await openAdapter();
    a.setRecoverySource(() => ({ bytes: SNAPSHOT, label: "rev 4" }));
    const infos: RecoveryInfo[] = [];
    a.onRecovered = (i) => infos.push(i);

    state.trapNextApply = true;
    await expect(a.applyIntent({ intent: "X" } as never)).rejects.toMatchObject({ code: "wasm_trap" });

    expect(state.resets).toBe(1); // recovered INSIDE the same worker
    expect(state.spawns).toBe(1); // a trap does not kill the worker — no respawn
    expect(state.opens[state.opens.length - 1].bytes).toBe(SNAPSHOT); // snapshot-first
    expect(infos).toEqual([{ source: "snapshot", label: "rev 4" }]);
    await expect(a.pageCount()).resolves.toBe(3); // live again without another open()
  });

  it("corrupt snapshot → reset AGAIN → honest original fallback with the reason", async () => {
    const a = await openAdapter();
    a.setRecoverySource(() => ({ bytes: SNAPSHOT }));
    state.rejectOpenBytes = SNAPSHOT;
    const infos: RecoveryInfo[] = [];
    a.onRecovered = (i) => infos.push(i);

    state.trapNextApply = true;
    await expect(a.applyIntent({ intent: "X" } as never)).rejects.toMatchObject({ code: "wasm_trap" });

    expect(state.resets).toBe(2);
    expect(state.opens[state.opens.length - 1].bytes).toBe(ORIGINAL);
    expect(infos[0].source).toBe("original");
    expect(infos[0].reason).toContain("snapshot open failed");
  });
});

describe("issue 055 — worker DEATH = poisoned instance (재스폰 + 스냅샷 우선 복구)", () => {
  it("mid-call death → {code:worker_dead} rethrown + respawn + snapshot-first re-open", async () => {
    const a = await openAdapter();
    a.setRecoverySource(() => ({ bytes: SNAPSHOT, label: "rev 9" }));
    const infos: RecoveryInfo[] = [];
    a.onRecovered = (i) => infos.push(i);

    state.workers[0].dieOnNextRequest = true;
    await expect(a.pageCount()).rejects.toMatchObject({ code: "worker_dead" });

    expect(state.spawns).toBe(2); // a FRESH worker was spawned
    expect(state.opens[state.opens.length - 1].bytes).toBe(SNAPSHOT); // snapshot-first, like a trap
    expect(infos).toEqual([{ source: "snapshot", label: "rev 9" }]);
    await expect(a.pageCount()).resolves.toBe(3); // the adapter is functional on the new worker
    expect(mainEngine.reset).not.toHaveBeenCalled(); // recovery stayed in the worker lane
  });
});

describe("issue 055 — dispose/cancel (intentional terminate)", () => {
  it("dispose() during an in-flight open rejects {code:worker_terminated} (a cancel, not a crash)", async () => {
    const a = makeAdapter();
    state.hangNextOpen = true; // the parse "takes forever" — the user hits 취소 mid-flight
    const opening = a.open(ORIGINAL, "big.hwp");
    await new Promise((r) => setTimeout(r, 0)); // init resolved; the open op is parked in the worker
    a.dispose();
    await expect(opening).rejects.toMatchObject({ code: "worker_terminated" });
  });

  it("open() after dispose() respawns a fresh worker", async () => {
    const a = await openAdapter();
    a.dispose();
    expect(state.workers[0].terminated).toBe(true);
    await a.open(ORIGINAL, "doc.hwp");
    expect(state.spawns).toBe(2);
    await expect(a.pageCount()).resolves.toBe(3);
  });

  it("onMutation still fires only on successful mutations over the worker", async () => {
    const a = await openAdapter();
    let fired = 0;
    a.onMutation = () => fired++;
    await a.pageCount();
    expect(fired).toBe(0);
    await a.applyIntent({ intent: "X" } as never);
    expect(fired).toBe(1);
  });
});
