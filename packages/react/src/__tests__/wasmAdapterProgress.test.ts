// W6.1/W6.2 — WasmAdapter 쪽 계약: CDN 기본값(=인자 없이 생성 가능) · onProgress 배선(메인스레드 ∥
// 워커) · prefetch(유휴 예열, 실패해도 호출자를 깨지 않음).
//
// 잠그는 것:
//   1. wasmInput 을 안 주면 어댑터는 **아무것도 지어내지 않고** undefined 를 그대로 로더에 넘긴다 —
//      기본값의 정본은 엔진 로더 한 곳(cdn.js)이다(어댑터가 URL 을 흉내내면 두 벌이 어긋난다).
//   2. onProgress 를 안 주면 로더 옵션 자체가 undefined — 기존(0.0.2) 호출 형태와 바이트동일.
//   3. 워커 모드에서 id 없는 {progress} 메시지는 RPC 응답 demux 를 건드리지 않고 관찰자로만 간다.
//   4. prefetch 는 실패를 삼키고 false 를 돌려준다(랜딩 예열이 앱을 깨면 안 된다).
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineLoadProgress } from "@auto-hwp/engine/cdn";

const engine = {
  init: vi.fn(async (_input?: unknown, _options?: unknown) => ({})),
  reset: vi.fn(async (_input?: unknown, _options?: unknown) => ({})),
};
vi.mock("@auto-hwp/engine", () => ({
  HwpDoc: class {
    static open() {
      throw new Error("not used in this test");
    }
  },
  initEngine: (input?: unknown, options?: unknown) => engine.init(input, options),
  resetEngine: (input?: unknown, options?: unknown) => engine.reset(input, options),
}));

import { EngineWorkerClient } from "@auto-hwp/engine/worker-client";
import { WasmAdapter } from "../WasmAdapter";

const tick = (over: Partial<EngineLoadProgress> = {}): EngineLoadProgress => ({
  loaded: 100,
  total: 200,
  ratio: 0.5,
  done: false,
  estimated: false,
  url: "https://cdn.jsdelivr.net/npm/@auto-hwp/engine@0.0.2/pkg/hwp_wasm_bg.wasm",
  ...over,
});

beforeEach(() => {
  engine.init.mockClear();
  engine.reset.mockClear();
});

describe("WasmAdapter — CDN default + progress (main thread)", () => {
  it("passes NO wasm input through when the host gave none (the loader owns the default)", async () => {
    const adapter = new WasmAdapter();
    expect(await adapter.prefetch()).toBe(true);
    expect(engine.init).toHaveBeenCalledTimes(1);
    expect(engine.init.mock.calls[0][0]).toBeUndefined();
    expect(engine.init.mock.calls[0][1]).toBeUndefined(); // 진행률 미사용 = 종전 호출과 동일
  });

  it("forwards an explicit wasm URL (self-hosting stays an override, not a rewrite)", async () => {
    const url = new URL("https://host.example/hwp/hwp_wasm_bg.wasm");
    await new WasmAdapter(url).prefetch();
    expect(engine.init.mock.calls[0][0]).toBe(url);
  });

  it("wires onProgress into the loader and relays every tick to the host", async () => {
    const ticks: EngineLoadProgress[] = [];
    engine.init.mockImplementationOnce(async (_input, options) => {
      const onProgress = (options as { onProgress?: (p: EngineLoadProgress) => void } | undefined)?.onProgress;
      onProgress?.(tick());
      onProgress?.(tick({ loaded: 200, ratio: 1, done: true }));
      return {};
    });
    const adapter = new WasmAdapter(undefined, { onProgress: (p) => ticks.push(p) });
    await adapter.prefetch();
    expect(ticks).toHaveLength(2);
    expect(ticks[1]).toMatchObject({ done: true, ratio: 1 });
  });

  it("passes expectedBytes through as the progress denominator override", async () => {
    await new WasmAdapter(undefined, { onProgress: () => {}, expectedBytes: 1234 }).prefetch();
    expect(engine.init.mock.calls[0][1]).toMatchObject({ expectedBytes: 1234 });
  });

  it("prefetch swallows a failed load and answers false (a landing warm-up must not break the app)", async () => {
    engine.init.mockRejectedValueOnce(new Error("offline"));
    expect(await new WasmAdapter().prefetch()).toBe(false);
  });
});

// ── 워커 레인 ────────────────────────────────────────────────────────────────────────────────────
// 최소 fake worker: init/open 에 응답하고, init 도중 id 없는 {progress} 를 흘려보낸다.
class ProgressWorker {
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  postMessage(req: { id: number; op: string }) {
    queueMicrotask(() => {
      if (req.op === "init") {
        this.onmessage?.({ data: { progress: tick() } }); // id 없음 = 관찰자 전용
        this.onmessage?.({ data: { progress: tick({ loaded: 200, ratio: 1, done: true }) } });
      }
      // open → {pages}, call(pageCount) → 3 (어댑터가 open 직후 재질의한다), 그 외 → null
      const result = req.op === "open" ? { pages: 3 } : req.op === "call" ? 3 : null;
      this.onmessage?.({ data: { id: req.id, ok: true, result } });
    });
  }
  terminate() {}
}

describe("WasmAdapter — progress relayed out of the worker", () => {
  it("routes id-less {progress} to the observer without disturbing the RPC replies", async () => {
    const ticks: EngineLoadProgress[] = [];
    const adapter = new WasmAdapter(undefined, {
      worker: { factory: () => new ProgressWorker() as unknown as Worker },
      onProgress: (p) => ticks.push(p),
    });
    const opened = await adapter.open(new Uint8Array([1, 2, 3]), "a.hwpx");
    expect(opened.pages).toBe(3); // RPC 응답이 진행률 메시지에 먹히지 않았다
    expect(ticks.map((t) => t.done)).toEqual([false, true]);
    expect(engine.init).not.toHaveBeenCalled(); // 워커 모드는 메인스레드 엔진을 건드리지 않는다
  });
});

describe("EngineWorkerClient — CDN worker default", () => {
  it("no longer requires { url } or { factory } (the default is this version's worker.js)", () => {
    expect(() => new EngineWorkerClient()).not.toThrow();
    expect(new EngineWorkerClient().alive).toBe(false);
  });
});
