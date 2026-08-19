import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "./route";
import { resetOpenRouterSessionForTests, setOpenRouterSessionKey, setSelectedOpenRouterModel } from "@/lib/openrouter/session";

const ENV_KEYS = ["OPENROUTER_API_KEY", "ANTHROPIC_API_KEY", "AUTO_HWP_OPENROUTER_MODEL", "AUTO_HWP_LOCAL_MODELS"] as const;

const OK = {
  choices: [
    {
      message: {
        content: '[{"intent":"SetParagraphText","section":0,"block":2,"text":"ok"}]',
        annotations: [],
      },
    },
  ],
};

function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

const SSE_EMIT = [
  'data: {"choices":[{"delta":{"content":"[{\\"intent\\":\\"SetParagraphText\\",\\"section\\":0,\\"block\\":2,\\"text\\":\\"ok\\"}]"}}]}\n\n',
  'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
  "data: [DONE]\n\n",
];

async function readNdjson(res: Response): Promise<Array<{ type: string }>> {
  const text = await res.text();
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { type: string });
}

describe("hwp-edit — OpenRouter PKCE session + explicit model", () => {
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
  let calls: RequestInit[];

  beforeEach(() => {
    resetOpenRouterSessionForTests();
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    calls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init: RequestInit) => {
        calls.push(init);
        const body = JSON.parse(String(init.body ?? "{}")) as { stream?: boolean };
        if (body.stream) {
          return { ok: true, body: sseStream(SSE_EMIT) } as unknown as Response;
        }
        return { ok: true, json: async () => OK, text: async () => "" } as unknown as Response;
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetOpenRouterSessionForTests();
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("routes PKCE session + no env to openrouter (does not silently use anthropic/mock)", async () => {
    process.env.ANTHROPIC_API_KEY = "anthropic-should-not-win";
    setOpenRouterSessionKey("session-only-key");

    const probe = (await (await GET(new Request("http://localhost/api/hwp-edit"))).json()) as { provider: string; keySource: string; mode: string };
    expect(probe).toMatchObject({ provider: "openrouter", keySource: "session", mode: "live" });

    const res = await POST(
      new Request("http://localhost/api/hwp-edit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ instruction: "다듬어", anchors: [], docContext: "" }),
      }),
    );
    const data = (await res.json()) as { provider: string; keySource: string; mode: string };
    expect(data).toMatchObject({ provider: "openrouter", keySource: "session", mode: "live" });
    expect(calls.length).toBeGreaterThan(0);
    const auth = (calls[0].headers as Record<string, string>).Authorization;
    expect(auth).toBe("Bearer session-only-key");
    expect(JSON.stringify(data)).not.toContain("session-only-key");
    expect(JSON.stringify(data)).not.toContain("anthropic-should-not-win");
  });

  it("puts the explicit model on both streaming and non-streaming OpenRouter requests", async () => {
    process.env.OPENROUTER_API_KEY = "env-key";
    setSelectedOpenRouterModel("stored/should-lose");

    const nonStream = await POST(
      new Request("http://localhost/api/hwp-edit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ instruction: "다듬어", anchors: [], docContext: "", model: "test/explicit-model" }),
      }),
    );
    expect(nonStream.status).toBe(200);
    const nonStreamBody = JSON.parse(String(calls[0].body)) as { model: string };
    expect(nonStreamBody.model).toBe("test/explicit-model");

    calls.length = 0;
    const stream = await POST(
      new Request("http://localhost/api/hwp-edit?stream=1", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ instruction: "다듬어", anchors: [], docContext: "", model: "test/stream-model" }),
      }),
    );
    expect(stream.headers.get("X-Auto-Hwp-Key-Source")).toBe("env");
    const events = await readNdjson(stream);
    expect(events.some((e) => e.type === "intents")).toBe(true);
    const streamBody = JSON.parse(String(calls[0].body)) as { model: string };
    expect(streamBody.model).toBe("test/stream-model");
  });

  it("uses the stored selection when the request does not name a model", async () => {
    process.env.OPENROUTER_API_KEY = "env-key";
    setSelectedOpenRouterModel("session/stored-model");
    await POST(
      new Request("http://localhost/api/hwp-edit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ instruction: "다듬어", anchors: [], docContext: "" }),
      }),
    );
    expect(JSON.parse(String(calls[0].body)).model).toBe("session/stored-model");
  });
});
