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
