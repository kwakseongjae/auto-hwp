// 073 2단계 — 벌크 생성 파이프라인이 **실엔진 + 실제 워커 프로토콜** 위에서 도는지 잠근다.
// engineWorker.test.ts 와 같은 방식으로 packages/engine/worker.js 를 Node 에서 `self` 셤으로 구동하고,
// bulkEngine 의 EngineLane 을 그 RPC 에 연결한다. 이게 잠그는 것:
//  ① 벌크가 부르는 엔진 메서드가 전부 worker.js 의 화이트리스트(METHODS) 안에 있다 — 화이트리스트
//     밖이면 워커가 "unknown engine method"로 거절하므로 이 테스트가 즉시 빨개진다(웹 회귀 조기 검출).
//  ② 워커의 "문서 1개" 계약 위에서 채움 → toHwpx → 재개봉 검증(값·쪽수)이 실제로 성립한다.
//  ③ 검수 프리뷰 lazy 경로가 실제 SVG/셀 경계를 만든다.
// 실브라우저 모듈 워커 경유는 e2e(bulk-*.spec.ts)와 100명 파일럿이 검증한다.
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { baselinePages, generateRow, listTables, newBatchCache, renderRowPreview, type EngineLane } from "./bulkEngine";

const REPO = path.resolve(process.cwd(), "..", "..");
const WASM = path.join(REPO, "packages", "engine", "pkg", "hwp_wasm_bg.wasm");
const WORKER = path.join(REPO, "packages", "engine", "worker.js");
// HWPX 양식 = 무편집 영역 바이트 보존 — 벌크의 권장 입력이자 가장 안정적인 픽스처.
const FIXTURE = path.join(REPO, "benchmarks", "benchmark1.hwpx");

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

/** 워커 RPC 를 EngineLane 으로 — 실제 WorkerLane(EngineWorkerClient)이 하는 일과 같은 계약이다. */
const lane: EngineLane = {
  open: (bytes, name) => rpc<{ pages: number }>("open", { bytes, name }),
  call: <T,>(method: string, params?: unknown[]) => rpc<T>("call", { method, params }),
};

const template = readFileSync(FIXTURE);
const TPL = new Uint8Array(template.buffer, template.byteOffset, template.byteLength);

beforeAll(async () => {
  (globalThis as { self?: unknown }).self = shim;
  await import(WORKER);
  expect(shim.onmessage).toBeTypeOf("function");
  await rpc("init", { wasmInput: readFileSync(WASM) });
}, 180_000);

describe("073 2단계 — 워커 경유 벌크 생성(실엔진)", () => {
  it(
    "채움 → HWPX 산출 → 재개봉 검증(값·쪽수) → lazy 프리뷰가 워커 화이트리스트만으로 완주한다",
    async () => {
      const basePages = await baselinePages(lane, TPL, "template.hwpx");
      expect(basePages).toBeGreaterThan(0);

      // 채울 셀은 실문서에서 결정론으로 고른다(하드코딩 pin 은 조판이 움직이면 조용히 어긋난다).
      await lane.open(TPL, "template.hwpx");
      const tables = await listTables(lane, basePages);
      expect(tables.length).toBeGreaterThan(0);
      const VALUE = "오토한글벌크검증값";
      let done: Awaited<ReturnType<typeof generateRow>> | null = null;
      let pin: { section: number; index: number; row: number; col: number } | null = null;
      const cache = newBatchCache();
      for (const t of tables) {
        const grid = await lane.call<{ cells: { row: number; col: number }[] } | null>("tableGrid", [t.section, t.block]);
        const cell = grid?.cells.find((c) => c.col >= 1);
        if (!cell) continue;
        const candidate = { section: t.section, index: t.block, row: cell.row, col: cell.col };
        const out = await generateRow(lane, {
          templateBytes: TPL,
          templateName: "template.hwpx",
          targets: [{ key: "검증", pin: candidate, required: true, example: "" }],
          row: { 검증: VALUE },
          basePages,
          cache,
        });
        if (!out.reasons.length) {
          done = out;
          pin = candidate;
          break;
        }
        // 셀이 편집 거부(병합 커버 등)면 다음 후보로 — 단 사유는 반드시 남아 있어야 한다(조용한 통과 금지).
        expect(out.reasons.some((r) => r.startsWith("apply_failed") || r.startsWith("value_not_found") || r.startsWith("overflow"))).toBe(true);
        await lane.open(TPL, "template.hwpx");
      }
      expect(pin, "편집 가능한 표 셀을 하나도 찾지 못했습니다").not.toBeNull();
      expect(done).not.toBeNull();
      expect(done!.pages).toBe(basePages); // 한 셀 채움으로 쪽수가 늘지 않는다(HWPX 보존 계약)
      expect(done!.values).toHaveLength(1);
      expect(done!.bytes.length).toBeGreaterThan(0);

      // 산출물은 실제 HWPX(zip) — 다운로드해서 한글에서 바로 열리는 그 바이트다.
      expect([...done!.bytes.slice(0, 2)]).toEqual([0x50, 0x4b]);

      // lazy 프리뷰: 채운 셀이 있는 페이지의 SVG + 셀 경계 하이라이트
      const preview = await renderRowPreview(lane, done!.bytes, done!.values);
      expect(preview, "프리뷰를 만들지 못했습니다").not.toBeNull();
      expect(preview!.svg).toContain("<svg");
      expect(preview!.pageW).toBeGreaterThan(0);
      expect(preview!.highlights).toHaveLength(1);
      expect(preview!.highlights[0].value).toBe(VALUE);
      expect(preview!.highlights[0].w).toBeGreaterThan(0);
      expect(preview!.highlights[0].h).toBeGreaterThan(0);
    },
    300_000,
  );
});
