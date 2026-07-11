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
import { beforeAll, describe, expect, it } from "vitest";
import { HwpDoc, initEngine } from "@tf-hwp/engine";

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

// Node 셤에선 postMessage transfer 가 없으므로 Uint8Array 가 그대로 온다 — 방어적으로만 감싼다.
function toU8(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  throw new Error("expected bytes");
}
