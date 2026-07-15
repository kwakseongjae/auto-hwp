// Feature A — web-search grounding (OpenRouter web plugin) at the reference proxy. MOCKED fetch only (no
// real network / no real key / no cost): asserts the upstream request carries `plugins:[{id:"web"}]` ONLY
// when the request opts in (webSearch:true), and that `url_citation` annotations are parsed into the
// additive `citations` on the response. The intents whitelist/validation lane is unchanged.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

// A canned OpenRouter (OpenAI-compatible) success body: JSON intents in `content` + web-search sources in
// `annotations` (the shape the web plugin returns).
const OK_ANNOTATED = {
  choices: [
    {
      message: {
        content: '[{"intent":"SetParagraphText","section":0,"block":2,"text":"근거 반영"}]',
        annotations: [
          { type: "url_citation", url_citation: { url: "https://ex.com/a", title: "출처 A" } },
          { type: "url_citation", url_citation: { url: "https://ex.com/b", title: "출처 B" } },
        ],
      },
    },
  ],
};

function makeReq(body: unknown) {
  return new Request("http://localhost/api/hwp-edit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("hwp-edit route — web-search plugin + citations (Feature A)", () => {
  const prevOpenRouter = process.env.OPENROUTER_API_KEY;
  const prevAnthropic = process.env.ANTHROPIC_API_KEY;
  let calls: { url: unknown; init: RequestInit }[];

  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = "test-key"; // force the openrouter provider (checked first)
    delete process.env.ANTHROPIC_API_KEY;
    calls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, init: RequestInit) => {
        calls.push({ url, init });
        return { ok: true, json: async () => OK_ANNOTATED, text: async () => "" } as unknown as Response;
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    if (prevOpenRouter === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = prevOpenRouter;
    if (prevAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevAnthropic;
  });

  it("webSearch:true adds the web plugin and returns parsed citations alongside the intents", async () => {
    const res = await POST(makeReq({ instruction: "최신 시장 규모 찾아줘", anchors: [], docContext: "", webSearch: true }));
    const data = (await res.json()) as { intents: unknown[]; citations: unknown[]; provider: string };

    // The upstream OpenRouter request body carried the web plugin (server-side search, no key leaked).
    const body = JSON.parse(calls[0].init.body as string) as { plugins?: unknown };
    expect(body.plugins).toEqual([{ id: "web" }]);

    // The intents lane is unchanged (whitelisted) and the citations are the parsed url_citation sources.
    expect(data.intents).toEqual([{ intent: "SetParagraphText", section: 0, block: 2, text: "근거 반영" }]);
    expect(data.citations).toEqual([
      { url: "https://ex.com/a", title: "출처 A" },
      { url: "https://ex.com/b", title: "출처 B" },
    ]);
    expect(data.provider).toBe("openrouter");
  });

  it("webSearch omitted does NOT add the web plugin (no search/billing on ordinary edits)", async () => {
    const res = await POST(makeReq({ instruction: "이 문단 다듬어줘", anchors: [], docContext: "" }));
    const data = (await res.json()) as { citations: unknown[] };
    const body = JSON.parse(calls[0].init.body as string) as { plugins?: unknown };
    expect(body.plugins).toBeUndefined();
    // Shape stays additive — citations present but empty when the plugin didn't run.
    expect(data.citations).toEqual([{ url: "https://ex.com/a", title: "출처 A" }, { url: "https://ex.com/b", title: "출처 B" }]);
  });

  it("mock provider (no keys) returns an additive empty citations array", async () => {
    delete process.env.OPENROUTER_API_KEY; // no keys → mock provider
    const res = await POST(makeReq({ instruction: "표 채워줘", anchors: [], docContext: "", webSearch: true }));
    const data = (await res.json()) as { mode: string; citations: unknown[] };
    expect(data.mode).toBe("mock");
    expect(data.citations).toEqual([]); // no web search in mock, but the field is present (shape stable)
  });
});

// ── Multimodal: image → content-parts user message (vision); doc → R5 <attachment> fenced text ─────────
describe("hwp-edit route — multimodal attachments (image vision + doc text)", () => {
  const prevOpenRouter = process.env.OPENROUTER_API_KEY;
  const prevAnthropic = process.env.ANTHROPIC_API_KEY;
  let calls: { url: unknown; init: RequestInit }[];
  const IMG = "data:image/png;base64,iVBORw0KGgoAAAANSU=";

  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = "test-key";
    delete process.env.ANTHROPIC_API_KEY;
    calls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, init: RequestInit) => {
        calls.push({ url, init });
        return { ok: true, json: async () => OK_ANNOTATED, text: async () => "" } as unknown as Response;
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    if (prevOpenRouter === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = prevOpenRouter;
    if (prevAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevAnthropic;
  });

  it("an IMAGE attachment makes the upstream user message a content-PARTS array (text + image_url)", async () => {
    const attachments = [{ id: "a1", kind: "image", name: "table.png", mime: "image/png", dataUrl: IMG }];
    const res = await POST(makeReq({ instruction: "이 표 사진을 그대로 채워줘", anchors: [{ kind: "table", section: 0, block: 3 }], docContext: "format=hwpx", attachments }));
    expect(res.status).toBe(200);

    const body = JSON.parse(calls[0].init.body as string) as { messages: { role: string; content: unknown }[] };
    const userMsg = body.messages[1];
    expect(userMsg.role).toBe("user");
    // Content is PARTS (array), not a plain string — the vision channel.
    expect(Array.isArray(userMsg.content)).toBe(true);
    const parts = userMsg.content as Array<{ type: string; text?: string; image_url?: { url: string } }>;
    // The text part still carries the R5-fenced instruction/doc-context…
    const textPart = parts.find((p) => p.type === "text");
    expect(textPart?.text).toContain("사용자 지시: 이 표 사진을 그대로 채워줘");
    expect(textPart?.text).toContain("<document-content>");
    // …and the image rides as an image_url part with the base64 dataUrl.
    expect(parts).toContainEqual({ type: "image_url", image_url: { url: IMG } });
  });

  it("a DOC (text) attachment stays a STRING user message with the extracted text in an R5 <attachment> fence", async () => {
    const attachments = [{ id: "d1", kind: "doc", name: "ref.txt", mime: "text/plain", text: "표 데이터: A=1 B=2" }];
    await POST(makeReq({ instruction: "참고 문서대로 채워줘", anchors: [], docContext: "format=hwpx", attachments }));

    const body = JSON.parse(calls[0].init.body as string) as { messages: { role: string; content: unknown }[] };
    const content = body.messages[1].content;
    // No image → back-compat STRING content (not parts).
    expect(typeof content).toBe("string");
    expect(content as string).toContain('<attachment name="ref.txt" mime="text/plain">');
    expect(content as string).toContain("표 데이터: A=1 B=2");
  });

  it("no attachments → the upstream user message is a plain STRING (back-compat, unchanged wire)", async () => {
    await POST(makeReq({ instruction: "이 문단 다듬어줘", anchors: [], docContext: "format=hwpx" }));
    const body = JSON.parse(calls[0].init.body as string) as { messages: { content: unknown }[] };
    expect(typeof body.messages[1].content).toBe("string");
  });
});

// ══ Agentic streaming runner: tool-calling loop (web_search → emit_intents) → NDJSON AgentEvent stream ══
// MOCKED OpenRouter (no real network / no key / no cost). Two STREAMING turns (SSE): turn 1 emits a
// web_search tool_call; turn 2 emits emit_intents. The web_search sub-call is a NON-streaming completion
// with the web plugin, returning content + url_citation annotations. Asserts the ordered AgentEvents and
// the validated final intents.

/** Build a ReadableStream that emits the given SSE chunk strings then closes (mocks res.body). */
function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const ch of chunks) controller.enqueue(enc.encode(ch));
      controller.close();
    },
  });
}

/** Drain the route's NDJSON stream response into parsed AgentEvents. */
async function readNdjson(res: Response): Promise<Array<Record<string, unknown>>> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
  }
  return buf
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

// Turn 1: the model streams a web_search tool_call (id + name, then the JSON arguments in fragments).
const SSE_SEARCH = [
  'data: {"choices":[{"delta":{"role":"assistant","content":""}}]}\n\n',
  'data: {"choices":[{"delta":{"reasoning":"최신 시장 규모를 확인해야겠다."}}]}\n\n',
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"web_search","arguments":""}}]}}]}\n\n',
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"query\\":"}}]}}]}\n\n',
  'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"2026 시장 규모\\"}"}}]}}]}\n\n',
  'data: {"choices":[{"finish_reason":"tool_calls"}]}\n\n',
  "data: [DONE]\n\n",
];
// Turn 2: the model streams the FINAL Intent[] as a plain JSON-array message (the terminal action — NOT a
// tool call; emit_intents was removed because Grok degenerated on it). finish_reason "stop" ends the loop.
const SSE_EMIT = [
  'data: {"choices":[{"delta":{"content":"[{\\"intent\\":\\"SetParagraphText\\",\\"section\\":0,\\"block\\":2,\\"text\\":\\"근거 반영\\"}]"}}]}\n\n',
  'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
  "data: [DONE]\n\n",
];
// The web_search sub-call (non-streaming, web plugin) → summary content + url_citation sources.
const WEB_RESULT = {
  choices: [
    {
      message: {
        content: "2026 반도체 시장 규모는 약 6천억 달러로 추정됩니다.",
        annotations: [{ type: "url_citation", url_citation: { url: "https://ex.com/report", title: "2026 Market Report" } }],
      },
    },
  ],
};

function makeStreamReq(body: unknown) {
  return new Request("http://localhost/api/hwp-edit?stream=1", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("hwp-edit route — agentic streaming (tool-calling loop + NDJSON AgentEvents)", () => {
  const prevOpenRouter = process.env.OPENROUTER_API_KEY;
  const prevAnthropic = process.env.ANTHROPIC_API_KEY;
  let streamCalls: RequestInit[]; // captured streaming-turn request inits (in order)
  let searchCalls: RequestInit[]; // captured web_search sub-call inits

  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = "test-key";
    delete process.env.ANTHROPIC_API_KEY;
    streamCalls = [];
    searchCalls = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init: RequestInit) => {
        const body = JSON.parse(init.body as string) as { stream?: boolean };
        if (body.stream) {
          streamCalls.push(init);
          const sse = streamCalls.length === 1 ? SSE_SEARCH : SSE_EMIT;
          return { ok: true, body: sseStream(sse) } as unknown as Response;
        }
        // Non-streaming = the web_search sub-call (web plugin).
        searchCalls.push(init);
        return { ok: true, json: async () => WEB_RESULT, text: async () => "" } as unknown as Response;
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    if (prevOpenRouter === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = prevOpenRouter;
    if (prevAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevAnthropic;
  });

  it("streams ordered AgentEvents (status → tool_call → tool_result → intents) with validated final intents", async () => {
    const res = await POST(makeStreamReq({ instruction: "최신 시장 규모 반영해줘", anchors: [], docContext: "format=hwpx" }));
    expect(res.headers.get("Content-Type")).toContain("application/x-ndjson");
    const events = await readNdjson(res);
    const types = events.map((e) => e.type);

    // The key steps appear IN ORDER (as a subsequence — extra status phases are fine).
    const idxStatus = types.indexOf("status");
    const idxCall = types.indexOf("tool_call");
    const idxResult = types.indexOf("tool_result");
    const idxIntents = types.indexOf("intents");
    expect(idxStatus).toBeGreaterThanOrEqual(0);
    expect(idxStatus).toBeLessThan(idxCall);
    expect(idxCall).toBeLessThan(idxResult);
    expect(idxResult).toBeLessThan(idxIntents);

    // The tool_call carried the model's search query; the tool_result carried the parsed citations.
    const toolCall = events.find((e) => e.type === "tool_call") as { tool: string; args: { query: string } };
    expect(toolCall.tool).toBe("web_search");
    expect(toolCall.args.query).toBe("2026 시장 규모");
    const toolResult = events.find((e) => e.type === "tool_result") as { tool: string; citations: unknown[] };
    expect(toolResult.citations).toEqual([{ url: "https://ex.com/report", title: "2026 Market Report" }]);

    // The TERMINAL intents event carries the whitelisted, validated Intent[].
    const intentsEv = events.find((e) => e.type === "intents") as { intents: unknown[] };
    expect(intentsEv.intents).toEqual([{ intent: "SetParagraphText", section: 0, block: 2, text: "근거 반영" }]);

    // The reasoning delta streamed as a thinking_delta (thinking transparency).
    expect(events.some((e) => e.type === "thinking_delta" && String(e.text).includes("최신 시장 규모"))).toBe(true);

    // Two STREAMING turns (search → final JSON array) + one web_search sub-call — the loop ran end-to-end.
    expect(streamCalls).toHaveLength(2);
    expect(searchCalls).toHaveLength(1);

    // The streaming turn exposes ONLY web_search with tool_choice:auto (MODEL decides when to search; the
    // terminal action is a JSON-array message, not a tool).
    const turn1 = JSON.parse(streamCalls[0].body as string) as { tools: Array<{ function: { name: string } }>; tool_choice: string; stream: boolean };
    expect(turn1.stream).toBe(true);
    expect(turn1.tool_choice).toBe("auto");
    expect(turn1.tools.map((t) => t.function.name)).toEqual(["web_search"]);
    // The web_search sub-call carried the OpenRouter web plugin (server-side search, no separate key).
    const sub = JSON.parse(searchCalls[0].body as string) as { plugins: unknown };
    expect(sub.plugins).toEqual([{ id: "web" }]);
  });

  it("CONVERSATION MEMORY: bounded prior turns fold into the upstream model messages (between system and the new user turn)", async () => {
    const history = [
      { role: "user", text: "이 표를 채워줘" },
      { role: "assistant", text: "제안: 셀 채우기" },
      // 8 more turns to prove the SERVER bounds the window (last 6 kept).
      ...Array.from({ length: 8 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", text: `turn ${i}` })),
    ];
    await POST(makeStreamReq({ instruction: "이제 행 하나 더", anchors: [], docContext: "format=hwpx", history }));

    const turn1 = JSON.parse(streamCalls[0].body as string) as { messages: Array<{ role: string; content: unknown }> };
    // messages = [system, ...bounded history, user]. First is system, last is the new user turn.
    expect(turn1.messages[0].role).toBe("system");
    expect(turn1.messages[turn1.messages.length - 1]).toMatchObject({ role: "user", content: expect.stringContaining("이제 행 하나 더") });
    // The window is bounded to the last 6 prior turns (server-side memory policy).
    const priors = turn1.messages.slice(1, -1);
    expect(priors).toHaveLength(6);
    // …and they are the MOST RECENT 6 (the oldest "이 표를 채워줘" was dropped).
    expect(priors.every((m) => m.content !== "이 표를 채워줘")).toBe(true);
  });

  it("mock provider (no keys) still streams a deterministic timeline (thinking → intents) — keyless demo works", async () => {
    delete process.env.OPENROUTER_API_KEY; // no keys → mock provider
    const res = await POST(makeStreamReq({ instruction: "표 채워줘", anchors: [{ kind: "cell", section: 0, block: 3, rows: [0, 0], cols: [1, 1] }], docContext: "format=hwpx (r0c1)_빈칸_" }));
    const events = await readNdjson(res);
    const types = events.map((e) => e.type);
    expect(types).toContain("status");
    expect(types[types.length - 1]).toBe("intents"); // terminal
    // No upstream LLM calls in mock mode (deterministic, keyless).
    expect(streamCalls).toHaveLength(0);
    expect(searchCalls).toHaveLength(0);
  });
});
