import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "./index";

type FakeKv = {
  get: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
};

function fakeKv(read: (key: string) => string | null = () => null): FakeKv {
  return {
    get: vi.fn(async (key: string) => read(key)),
    put: vi.fn(async () => undefined),
  };
}

function env(kv: FakeKv, overrides: Record<string, unknown> = {}) {
  return {
    OPENROUTER_API_KEY: "test-only-key",
    RATELIMIT: kv,
    ALLOWED_ORIGIN: "https://kwakseongjae.github.io",
    MODEL: "openai/gpt-5.6-luna",
    DAILY_CAP: "2000",
    PER_IP_CAP: "20",
    MAX_TOKENS: "1024",
    ...overrides,
  };
}

function request(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://worker.test/", {
    method: "POST",
    headers: {
      Origin: "https://kwakseongjae.github.io",
      "content-type": "application/json",
      "CF-Connecting-IP": "203.0.113.7",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function validBody(extra: Record<string, unknown> = {}) {
  return {
    instruction: "첫 표를 정리해 줘",
    anchors: [{ kind: "table", section: 0, block: 3, label: "표", page: 0 }],
    docContext: "format=hwpx pages=1",
    ...extra,
  };
}

function mockUpstream() {
  const upstream = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
    new Response(JSON.stringify({ choices: [{ message: { content: "[]" } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", upstream);
  return upstream;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("demo AI proxy request and cost guards", () => {
  it("rejects a missing/disallowed origin before quota or upstream", async () => {
    const kv = fakeKv();
    const upstream = mockUpstream();
    const res = await worker.fetch(
      request(validBody(), { Origin: "https://evil.example" }),
      env(kv) as never,
    );
    expect(res.status).toBe(403);
    expect(kv.get).not.toHaveBeenCalled();
    expect(kv.put).not.toHaveBeenCalled();
    expect(upstream).not.toHaveBeenCalled();
  });

  it("fails closed on empty CORS or invalid numeric configuration", async () => {
    for (const overrides of [
      { ALLOWED_ORIGIN: "" },
      { DAILY_CAP: "NaN" },
      { PER_IP_CAP: "0" },
      { MAX_TOKENS: "1025" },
      { DAILY_CAP: "10", PER_IP_CAP: "20" },
    ]) {
      const kv = fakeKv();
      const upstream = mockUpstream();
      const res = await worker.fetch(request(validBody()), env(kv, overrides) as never);
      expect(res.status).toBe(503);
      expect(kv.put).not.toHaveBeenCalled();
      expect(upstream).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    }
  });

  it("rejects non-JSON, oversized, and malformed-anchor bodies before quota", async () => {
    const cases: Request[] = [
      request("plain text", { "content-type": "text/plain" }),
      request(JSON.stringify(validBody({ docContext: "x".repeat(129 * 1024) }))),
      request(
        validBody({
          anchors: [{
            kind: "cell",
            section: 0,
            block: 0,
            path: [{ block: -1, row: 0, col: 0 }],
          }],
        }),
      ),
    ];
    for (const req of cases) {
      const kv = fakeKv();
      const upstream = mockUpstream();
      const res = await worker.fetch(req, env(kv) as never);
      expect([400, 413, 415]).toContain(res.status);
      expect(kv.put).not.toHaveBeenCalled();
      expect(upstream).not.toHaveBeenCalled();
      vi.unstubAllGlobals();
    }
  });

  it("enforces IP and global counters before upstream", async () => {
    const upstream = mockUpstream();
    const ipFull = fakeKv((key) => (key.startsWith("ip:") ? "20" : null));
    expect((await worker.fetch(request(validBody()), env(ipFull) as never)).status).toBe(429);
    expect(upstream).not.toHaveBeenCalled();

    const globalFull = fakeKv((key) => (key.startsWith("all:") ? "2000" : null));
    expect((await worker.fetch(request(validBody()), env(globalFull) as never)).status).toBe(429);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("strips unknown anchor fields, charges both counters, and requires ZDR on one valid call", async () => {
    const kv = fakeKv();
    const upstream = mockUpstream();
    const res = await worker.fetch(
      request(
        validBody({
          anchors: [{
            kind: "cell",
            section: 0,
            block: 3,
            rows: [0, 0],
            cols: [1, 1],
            label: "값",
            page: 0,
            attackerPayload: { huge: "never forward me" },
          }],
        }),
      ),
      env(kv) as never,
    );
    expect(res.status).toBe(200);
    expect(kv.put).toHaveBeenCalledTimes(2);
    expect(upstream).toHaveBeenCalledTimes(1);
    const init = upstream.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(init.body)) as {
      model: string;
      provider: { zdr: boolean };
      max_tokens: number;
      messages: Array<{ content: string }>;
    };
    // 서버가 모델을 고정한다 — 클라이언트는 모델을 고를 수 없고, 설정한 MODEL이 그대로 상류로 간다
    // (모델을 바꾸면 wrangler.toml의 DAILY_CAP도 새 단가로 재계산해야 한다).
    expect(body.model).toBe("openai/gpt-5.6-luna");
    expect(body.provider).toEqual({ zdr: true });
    expect(body.max_tokens).toBe(1024);
    expect(body.messages[1]?.content).not.toContain("attackerPayload");
    expect(body.messages[1]?.content).not.toContain("never forward me");
  });
});
