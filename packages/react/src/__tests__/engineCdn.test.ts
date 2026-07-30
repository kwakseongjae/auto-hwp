// W6.1/W6.2 — @auto-hwp/engine 의 CDN 기본값 + 진행률 로더 계약.
//
// 이 파일이 잠그는 것:
//   1. 기본 wasm/워커 URL 은 **이 패키지 자신의 버전**으로 pin 된다 — `@latest` 금지(JS↔wasm 짝이
//      어긋나면 링크 실패 또는 신규 Intent 의 "unknown variant" 거부 = 스테일 wasm 함정의 제도화).
//   2. cdn.js 의 ENGINE_VERSION 은 packages/engine/package.json 의 version 과 항상 같다
//      (발행 훅 build-wasm.mjs 도 같은 것을 하드 게이트로 검사한다 — 여기서는 커밋 시점에 잡는다).
//   3. 명시 URL/바이트는 **오버라이드**로 그대로 통과한다(기본값이 override 를 이기지 않는다).
//   4. 진행률: 비압축 응답은 Content-Length 로 정확한 %, **압축 응답은 헤더가 압축 바이트라 분모로
//      쓸 수 없다** → 발행 크기(WASM_BYTES) 추정 + `estimated:true` + 끝나기 전 100% 금지.
//   5. 정적 호스트가 없는 자산에 HTML 폴백을 돌려주면(임베드 최대 함정) 컴파일 오류가 아니라
//      원인을 말하는 {code:"wasm_fetch"} 로 즉시 실패한다.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ENGINE_VERSION,
  WASM_BYTES,
  defaultWasmUrl,
  defaultWorkerUrl,
  fetchWasmResponse,
  resolveWasmInput,
} from "@auto-hwp/engine/cdn";
import type { EngineLoadProgress } from "@auto-hwp/engine/cdn";

// vitest 는 packages/react 에서 실행된다(scripts/verify-local.sh). jsdom 환경에선 import.meta.url 이
// file: 이 아니므로 cwd 기준으로 형제 패키지를 읽는다.
const enginePkg = JSON.parse(readFileSync(resolve(process.cwd(), "../engine/package.json"), "utf8")) as {
  version: string;
  files: string[];
  exports: Record<string, unknown>;
};

const streamOf = (chunks: Uint8Array[]) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(ch);
      c.close();
    },
  });

describe("engine CDN defaults (W6.1)", () => {
  it("pins the default asset URLs to THIS package's own version — never @latest", () => {
    expect(ENGINE_VERSION).toBe(enginePkg.version);
    expect(defaultWasmUrl()).toBe(
      `https://cdn.jsdelivr.net/npm/@auto-hwp/engine@${enginePkg.version}/pkg/hwp_wasm_bg.wasm`,
    );
    expect(defaultWorkerUrl()).toBe(`https://cdn.jsdelivr.net/npm/@auto-hwp/engine@${enginePkg.version}/worker.js`);
    expect(defaultWasmUrl()).not.toContain("latest");
    expect(defaultWorkerUrl()).not.toContain("latest");
  });

  it("ships cdn.js in the published tarball (else the CDN default 404s for installers)", () => {
    expect(enginePkg.files).toContain("cdn.js");
    expect(enginePkg.files).toContain("cdn.d.ts");
    expect(enginePkg.exports["./cdn"]).toEqual({ types: "./cdn.d.ts", import: "./cdn.js" });
  });

  it("treats an explicit URL/bytes as an OVERRIDE, and only defaults when nothing is given", () => {
    expect(resolveWasmInput(undefined)).toBe(defaultWasmUrl());
    expect(resolveWasmInput("/hwp/hwp_wasm_bg.wasm")).toBe("/hwp/hwp_wasm_bg.wasm");
    expect(resolveWasmInput(new URL("https://host.example/w.wasm"))).toBe("https://host.example/w.wasm");
    const bytes = new Uint8Array([0, 97, 115, 109]);
    expect(resolveWasmInput(bytes)).toBe(bytes);
  });

  it("keeps the glue's own fetch (instantiateStreaming lane) when nobody watches progress", () => {
    // A plain string goes to the wasm-bindgen glue untouched — it fetches and streams-compiles, with
    // its own application/octet-stream fallback. We only take over the fetch to MEASURE it.
    expect(typeof resolveWasmInput(undefined, {})).toBe("string");
  });
});

describe("engine download progress (W6.2)", () => {
  const wasmBytes = (n: number) => new Uint8Array(n).fill(7);

  async function run(headers: Record<string, string>, chunks: Uint8Array[]) {
    const ticks: EngineLoadProgress[] = [];
    const res = new Response(streamOf(chunks), { headers });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => res),
    );
    const out = await fetchWasmResponse("https://cdn.example/w.wasm", (p) => ticks.push(p));
    const body = new Uint8Array(await out.arrayBuffer());
    vi.unstubAllGlobals();
    return { ticks, body, out };
  }

  it("reports an EXACT ratio on an identity transfer and passes the bytes through untouched", async () => {
    const { ticks, body } = await run(
      { "content-type": "application/wasm", "content-length": "300" },
      [wasmBytes(100), wasmBytes(200)],
    );
    expect(body.byteLength).toBe(300);
    expect(ticks.at(-1)).toMatchObject({ loaded: 300, total: 300, ratio: 1, done: true, estimated: false });
    const mid = ticks.find((t) => t.loaded === 100);
    expect(mid?.ratio).toBeCloseTo(100 / 300, 6);
  });

  it("does NOT divide by a COMPRESSED Content-Length — it estimates and never claims 100% early", async () => {
    // brotli/gzip 응답: Content-Length 는 압축 바이트, body 는 비압축 바이트 → 나누면 200% 가 된다.
    const { ticks } = await run(
      { "content-type": "application/wasm", "content-length": "1000", "content-encoding": "br" },
      [wasmBytes(4000)],
    );
    const mid = ticks.find((t) => t.loaded === 4000 && !t.done);
    expect(mid?.estimated).toBe(true);
    expect(mid?.total).toBe(WASM_BYTES);
    expect(mid?.ratio).toBeLessThan(1);
    expect(ticks.at(-1)).toMatchObject({ done: true, ratio: 1 });
  });

  it("normalizes the Content-Type so an application/octet-stream host keeps the streaming lane", async () => {
    const { out } = await run({ "content-type": "application/octet-stream" }, [wasmBytes(8)]);
    expect(out.headers.get("content-type")).toBe("application/wasm");
  });

  it("names the cause when a static host answers with its HTML fallback instead of the wasm", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<!doctype html><title>404</title>", { headers: { "content-type": "text/html" } })),
    );
    await expect(fetchWasmResponse("https://host.example/hwp_wasm_bg.wasm", () => {})).rejects.toMatchObject({
      code: "wasm_fetch",
    });
    vi.unstubAllGlobals();
  });

  it("fails with the HTTP status (not an opaque compile error) when the asset is missing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 404, statusText: "Not Found" })),
    );
    await expect(fetchWasmResponse("https://host.example/w.wasm", () => {})).rejects.toMatchObject({
      code: "wasm_fetch",
    });
    vi.unstubAllGlobals();
  });
});
