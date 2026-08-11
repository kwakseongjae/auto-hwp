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
    DAILY_CAP: "400",
    PER_IP_CAP: "20",
    MAX_TOKENS: "2048",
    REASONING_EFFORT: "low",
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

function mockUpstream(choice: Record<string, unknown> = { message: { content: "[]" } }) {
  const upstream = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
    new Response(JSON.stringify({ choices: [choice] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", upstream);
  return upstream;
}

/** 이슈 1-(1) 실측 실패의 상류 모습: 다중 SetTableCell JSON이 배열 중간에서 끊긴 채
 *  `finish_reason: "length"`로 돌아온다(온전한 2건 + 반쪽 1건). */
const TRUNCATED_CONTENT =
  '[{"intent":"SetTableCell","section":0,"index":10,"row":0,"col":3,"text":"오토케"},' +
  '{"intent":"SetTableCell","section":0,"index":10,"row":1,"col":3,"text":"모바일 앱(1개)"},' +
  '{"intent":"SetTableCell","section":0,"index":10,"row":5,"col":1,"tex';

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
      { MAX_TOKENS: "2049" },
      { REASONING_EFFORT: "ultra" },
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

    const globalFull = fakeKv((key) => (key.startsWith("all:") ? "400" : null));
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
    // 1-(1): 출력 예산은 2048(추론 토큰 포함) — wrangler.toml 비용 재계산과 한 벌이다.
    expect(body.max_tokens).toBe(2048);
    expect((body as unknown as { reasoning?: unknown }).reasoning).toEqual({ effort: "low" });
    expect(body.messages[1]?.content).not.toContain("attackerPayload");
    expect(body.messages[1]?.content).not.toContain("never forward me");
  });

  it("omits the reasoning field when REASONING_EFFORT is blank (rollback switch)", async () => {
    const upstream = mockUpstream();
    const res = await worker.fetch(request(validBody()), env(fakeKv(), { REASONING_EFFORT: "" }) as never);
    expect(res.status).toBe(200);
    const body = JSON.parse(String((upstream.mock.calls[0]?.[1] as RequestInit).body)) as Record<string, unknown>;
    expect(body.reasoning).toBeUndefined();
  });
});

// ── 이슈 1-(1): 빈 제안에 침묵하지 않는다 (사유코드 + 절단 구제) ────────────────────────────────
describe("empty-proposal honesty", () => {
  it("salvages the COMPLETE intents from a truncated response and says why", async () => {
    mockUpstream({ message: { content: TRUNCATED_CONTENT }, finish_reason: "length" });
    const res = await worker.fetch(request(validBody()), env(fakeKv()) as never);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { intents: unknown[]; reason?: string; message?: string };
    // 온전한 2건만 회수하고 반쪽 1건은 버린다(deny_unknown 규율).
    expect(body.intents).toHaveLength(2);
    expect(body.intents[1]).toMatchObject({ intent: "SetTableCell", row: 1, col: 3 });
    expect(body.reason).toBe("truncated");
    expect(body.message).toContain("잘렸");
  });

  it("reports `truncated` (not silence) when nothing at all survives the cut", async () => {
    mockUpstream({ message: { content: '[{"intent":"SetTableCell","sect' }, finish_reason: "length" });
    const res = await worker.fetch(request(validBody()), env(fakeKv()) as never);
    const body = (await res.json()) as { intents: unknown[]; reason?: string };
    expect(body.intents).toEqual([]);
    expect(body.reason).toBe("truncated");
  });

  it("reports `no_valid_intents` for an empty or non-whitelisted answer", async () => {
    mockUpstream();
    const empty = (await (await worker.fetch(request(validBody()), env(fakeKv()) as never)).json()) as { reason?: string };
    expect(empty.reason).toBe("no_valid_intents");

    vi.unstubAllGlobals();
    mockUpstream({ message: { content: '[{"intent":"DropTableColumn","section":0,"index":1}]' } });
    const dropped = (await (await worker.fetch(request(validBody()), env(fakeKv()) as never)).json()) as {
      intents: unknown[];
      reason?: string;
    };
    expect(dropped.intents).toEqual([]);
    expect(dropped.reason).toBe("no_valid_intents");
  });

  it("carries NO reason when the proposal is good (additive — old clients unaffected)", async () => {
    mockUpstream({
      message: { content: '[{"intent":"SetTableCell","section":0,"index":10,"row":0,"col":3,"text":"오토케"}]' },
      finish_reason: "stop",
    });
    const body = (await (await worker.fetch(request(validBody()), env(fakeKv()) as never)).json()) as {
      intents: unknown[];
      reason?: string;
      message?: string;
    };
    expect(body.intents).toHaveLength(1);
    expect(body.reason).toBeUndefined();
    expect(body.message).toBeUndefined();
  });

  it("tags an upstream failure with `upstream_error`", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    const res = await worker.fetch(request(validBody()), env(fakeKv()) as never);
    expect(res.status).toBe(502);
    expect((await res.json() as { reason?: string }).reason).toBe("upstream_error");
  });
});
