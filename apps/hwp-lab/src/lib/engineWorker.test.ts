// issue 055 (FG-14) — 워커 프로토콜 golden (실엔진): packages/engine/worker.js 를 Node 에서 `self` 셤으로
// 구동해, 실제 wasm 엔진 위에서 RPC 프로토콜(init/open/call/free)과 "워커 경유 == 직결" 동등성을 잠근다.
//
// 브라우저 없이 실엔진으로 잠그는 것: ① renderPageSvg/pageCount/blockRuns 가 직결 HwpDoc 과 문자열/값
// 동일(034 raw-diff 가 워커 경유에서도 유효하다는 증거 — 무편집 재렌더는 같은 문자열), ② 편집(applyIntent
// Replace) → toHwpx 바이트가 직결과 sha 동일, ③ 오류가 {message, code} 로 직렬화되어 돌아온다(no_document).
// 실브라우저 모듈 워커/전 스위트 경유는 e2e 가 검증한다(playwright 는 dev 서버에서 worker.js 정적 배포).
//
// goldenRecovery.test.ts 와 같은 실엔진 규칙: packages/engine/pkg 부재 시 명확히 실패(조용한 스킵 금지).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { HwpDoc, initEngine, isTrapError } from "@auto-hwp/engine";

const REPO = path.resolve(process.cwd(), "..", "..");
const WASM = path.join(REPO, "packages", "engine", "pkg", "hwp_wasm_bg.wasm");
const WORKER = path.join(REPO, "packages", "engine", "worker.js");
const FIXTURE = path.join(REPO, "benchmarks", "benchmark.hwp");

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

// ── `self` shim: worker.js 는 모듈 워커 전역(self.onmessage/postMessage)만 쓴다 ───────────────────────
type WorkerResponse = { id: number; ok: boolean; result?: unknown; error?: { message: string; code?: string } };
const shim = {
  onmessage: null as ((ev: { data: unknown }) => void) | null,
  listeners: new Map<number, (r: WorkerResponse) => void>(),
  postMessage(msg: WorkerResponse) {
    const fn = shim.listeners.get(msg.id);
    shim.listeners.delete(msg.id);
    fn?.(msg);
  },
};

let seq = 0;
function rpc<T = unknown>(op: string, args?: Record<string, unknown>): Promise<T> {
  const id = ++seq;
  return new Promise<T>((resolve, reject) => {
    shim.listeners.set(id, (r) => {
      if (r.ok) resolve(r.result as T);
      else reject(Object.assign(new Error(r.error?.message ?? "worker error"), { code: r.error?.code }));
    });
    shim.onmessage?.({ data: { id, op, args } });
  });
}

beforeAll(async () => {
  (globalThis as { self?: unknown }).self = shim;
  await import(WORKER); // worker.js 가 self.onmessage 를 설치한다
  expect(shim.onmessage).toBeTypeOf("function");
  await rpc("init", { wasmInput: readFileSync(WASM) });
  // 직결(레퍼런스) 엔진 — 같은 모듈 인스턴스여도 무방(워커 셤과 같은 프로세스).
  await initEngine(readFileSync(WASM));
}, 120_000);

describe("issue 055 — 워커 프로토콜 golden (실엔진, 워커 경유 == 직결)", () => {
  it(
    "open → pageCount/renderPageSvg/blockRuns 가 직결과 동일 + 무편집 재렌더는 같은 문자열(034 raw-diff 유효)",
    async () => {
      const bytes = readFileSync(FIXTURE);
      const opened = await rpc<{ pages: number }>("open", { bytes: new Uint8Array(bytes), name: "benchmark.hwp" });

      const direct = HwpDoc.open(new Uint8Array(bytes), "benchmark.hwp");
      try {
        expect(opened.pages).toBe(direct.pageCount());
        for (const p of [0, 1, opened.pages - 1]) {
          const viaWorker = await rpc<string>("call", { method: "renderPageSvg", params: [p] });
          expect(viaWorker, `page ${p} SVG must equal the direct render`).toBe(direct.renderPageSvg(p));
          // 무편집 재호출 = 동일 문자열 (엔진 SVG 캐시) → HwpPageView 의 raw-diff 스킵이 워커 경유에서도 성립.
          await expect(rpc<string>("call", { method: "renderPageSvg", params: [p] })).resolves.toBe(viaWorker);
        }
      } finally {
        direct.free();
      }
    },
    120_000,
  );

  it(
    "편집(Replace) → toHwpx 바이트가 직결과 sha 동일 (편집/직렬화 레인도 워커 경유 동등)",
    async () => {
      // HWPX 오리진 레인(goldenRecovery 와 동일): .hwp 원본의 문단은 Replace 앵커가 없을 수 있으므로
      // 한 번 toHwpx 로 변환한 바이트를 양쪽(워커/직결)에 동일하게 먹인다.
      const seed = HwpDoc.open(new Uint8Array(readFileSync(FIXTURE)), "benchmark.hwp");
      let bytes: Uint8Array;
      try {
        bytes = seed.toHwpx();
      } finally {
        seed.free();
      }
      await rpc("open", { bytes: new Uint8Array(bytes), name: "benchmark.hwpx" });
      const intent = { intent: "Replace", query: "사업", replacement: "워커055", case_sensitive: false, whole_word: false, all: false };

      const outW = await rpc<{ replaced?: number }>("call", { method: "applyIntent", params: [intent] });
      expect(outW.replaced ?? 0).toBeGreaterThan(0);
      const hwpxW = await rpc<Uint8Array>("call", { method: "toHwpx", params: [] });

      const direct = HwpDoc.open(new Uint8Array(bytes), "benchmark.hwpx");
      try {
        const outD = direct.applyIntent(intent) as { replaced?: number };
        expect(outD.replaced).toBe(outW.replaced);
        expect(sha(toU8(hwpxW))).toBe(sha(direct.toHwpx()));
      } finally {
        direct.free();
      }

      // undo 도 워커 경유로 동작한다(한 undo 유닛).
      await expect(rpc<boolean>("call", { method: "undo", params: [] })).resolves.toBe(true);
      await expect(rpc<boolean>("call", { method: "undo", params: [] })).resolves.toBe(false);
    },
    120_000,
  );

  it("오류는 {message, code} 로 직렬화된다: free 후 call → no_document, 미허용 메서드 거부", async () => {
    await rpc("free");
    await expect(rpc("call", { method: "pageCount", params: [] })).rejects.toMatchObject({ code: "no_document" });
    // 화이트리스트 밖(프로토타입 워크 차단): free/constructor 는 call 로 못 부른다.
    const bytes = readFileSync(FIXTURE);
    await rpc("open", { bytes: new Uint8Array(bytes), name: "benchmark.hwp" });
    await expect(rpc("call", { method: "free", params: [] })).rejects.toThrow(/unknown engine method/);
    await expect(rpc("call", { method: "constructor", params: [] })).rejects.toThrow(/unknown engine method/);
    await rpc("free");
  });
});

describe("issue 055 사후 #6 — 실패한 open 은 이전 문서 생존 (실엔진 worker.js)", () => {
  it("정상 문서 open 후 손상 바이트 open 실패 → 기존 문서가 그대로 질의된다", async () => {
    const bytes = readFileSync(FIXTURE);
    const opened = await rpc<{ pages: number }>("open", { bytes: new Uint8Array(bytes), name: "benchmark.hwp" });
    expect(opened.pages).toBeGreaterThan(0);

    // 손상/비형식 바이트 — 구조화 거부(트랩 아님)여야 하고, 파싱 성공 전엔 기존 doc 을 free 하지 않는다.
    let refused: unknown;
    try {
      await rpc("open", { bytes: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), name: "corrupt.hwp" });
    } catch (e) {
      refused = e;
    }
    expect(refused).toBeTruthy();
    expect(isTrapError(refused)).toBe(false); // 트랩이면 이 테스트의 전제(인스턴스 생존)가 아니다

    // "failed open은 이전 문서 생존": 구 코드는 파싱 전에 freeDoc() → no_document 지옥이었다.
    await expect(rpc<number>("call", { method: "pageCount", params: [] })).resolves.toBe(opened.pages);
    await rpc("free");
  }, 120_000);
});

describe("issue 055 사후 #8 — 트랩 분류기 단일 소스 (isTrapError)", () => {
  it("전체 트랩 패턴을 분류하고('table index …' 포함), 코드 있는 구조화 오류는 코드가 우선한다", () => {
    expect(isTrapError(new WebAssembly.RuntimeError("unreachable"))).toBe(true);
    expect(isTrapError(new Error("unreachable executed"))).toBe(true);
    expect(isTrapError(new Error("table index is out of bounds"))).toBe(true); // LabWorkspace 사본에 빠져 있던 패턴
    expect(isTrapError(new Error("memory access out of bounds"))).toBe(true);
    expect(isTrapError(Object.assign(new Error("boom"), { code: "wasm_trap" }))).toBe(true);
    expect(isTrapError(Object.assign(new Error("worker died"), { code: "worker_dead" }))).toBe(false); // 워커 죽음은 트랩과 다른 신호
    expect(isTrapError(Object.assign(new Error("RuntimeError처럼 보이는 메시지"), { code: "doc_limit" }))).toBe(false); // 코드 우선
    expect(isTrapError(new Error("plain failure"))).toBe(false);
  });

  it("LabWorkspace 는 단일 소스를 소비하고 로컬 정규식 사본을 갖지 않는다", () => {
    const src = readFileSync(path.join(process.cwd(), "src", "components", "LabWorkspace.tsx"), "utf8");
    expect(src).toContain("isTrapError"); // @auto-hwp/engine 단일 소스 소비
    expect(src).not.toMatch(/memory access out of bounds/); // 사본(트랩 정규식) 삭제됨
  });

  it("worker.js 도 같은 단일 소스를 소비한다(사본 없음)", () => {
    const src = readFileSync(WORKER, "utf8");
    expect(src).toContain("isTrapError");
    expect(src).not.toMatch(/memory access out of bounds/i);
  });
});

// 첫 로드의 wasm 인스턴스화 실패(일시적 fetch 오류 등)가 영구화되지 않는지 잠근다. 주의: wasm-bindgen
// glue 는 성공 후엔 재-init 을 단락시키므로(`if (wasm !== undefined) return wasm`), "거부된 첫 init"은
// 반드시 신선한 모듈 인스턴스에서만 재현된다 — vi.resetModules() + 동적 import 로 격리한다(공유 엔진
// 인스턴스/위 테스트들과 상호작용 없음).
describe("issue 055 사후 #7 — 거부된 initEngine 은 캐시되지 않는다", () => {
  it("첫 init 거부(손상 wasm 입력) 후 initEngine 재시도가 성공한다", async () => {
    vi.resetModules();
    const eng = await import("@auto-hwp/engine"); // 신선한 모듈 상태 (wasm === undefined)
    await expect(eng.initEngine(new Uint8Array([0, 1, 2, 3]))).rejects.toBeTruthy();
    // 구 코드: 거부된 프라미스가 _initPromise 에 영구 캐시 → 아래 재시도도 영원히 같은 거부를 재생했다.
    await expect(eng.initEngine(readFileSync(WASM))).resolves.toBeTruthy();
    const doc = eng.HwpDoc.open(new Uint8Array(readFileSync(FIXTURE)), "benchmark.hwp");
    try {
      expect(doc.pageCount()).toBeGreaterThan(0); // 엔진이 실제로 살아났다
    } finally {
      doc.free();
    }
  }, 120_000);
});

// Node 셤에선 postMessage transfer 가 없으므로 Uint8Array 가 그대로 온다 — 방어적으로만 감싼다.
function toU8(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  throw new Error("expected bytes");
}
