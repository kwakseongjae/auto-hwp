import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as connect } from "./connect/route";
import { GET as callback } from "./callback/route";
import { GET as status } from "./status/route";
import { POST as disconnect } from "./disconnect/route";
import { GET as catalog } from "./models/route";
import { POST as setModel } from "./model/route";
import { resetOpenRouterSessionForTests, setPkceVerifier } from "@/lib/openrouter/session";

const ENV_KEYS = ["AUTO_HWP_LOCAL_MODELS", "DEMO_STATIC", "NEXT_PUBLIC_DEMO", "DEMO_AI_MODE", "OPENROUTER_API_KEY"] as const;

function req(path: string, init?: RequestInit): Request {
  return new Request(`http://localhost:3000${path}`, init);
}

function leak(payload: string, secrets: string[]): void {
  for (const secret of secrets) {
    expect(payload, `response must not contain ${secret}`).not.toContain(secret);
  }
}

describe("openrouter auth routes", () => {
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

  beforeEach(() => {
    resetOpenRouterSessionForTests();
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
    process.env.AUTO_HWP_LOCAL_MODELS = "1";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetOpenRouterSessionForTests();
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("returns 404 when the local-models flag is off", async () => {
    delete process.env.AUTO_HWP_LOCAL_MODELS;
    const res = await connect(req("/api/auth/openrouter/connect"));
    expect(res.status).toBe(404);
  });

  it("returns 404 in DEMO_AI_MODE even with the flag on", async () => {
    process.env.DEMO_AI_MODE = "1";
    const res = await status(req("/api/auth/openrouter/status"));
    expect(res.status).toBe(404);
  });

  it("redirects connect to OpenRouter with an S256 challenge and a request-origin callback", async () => {
    const res = await connect(req("/api/auth/openrouter/connect", { headers: { host: "localhost:3000" } }));
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
    const location = res.headers.get("location") ?? "";
    const dest = new URL(location);
    expect(dest.origin).toBe("https://openrouter.ai");
    expect(dest.pathname).toBe("/auth");
    expect(dest.searchParams.get("code_challenge_method")).toBe("S256");
    expect(dest.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(dest.searchParams.get("callback_url")).toBe("http://localhost:3000/api/auth/openrouter/callback");
    leak(location, ["sk-or-"]);
  });

  it("exchanges the OAuth code on the server and never puts the key in the redirect", async () => {
    setPkceVerifier("test-verifier");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ key: "sk-or-test-session-key" }),
      })),
    );

    const res = await callback(req("/api/auth/openrouter/callback?code=oauth-code-not-a-key"));
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("/models");
    leak(location, ["sk-or-test-session-key", "test-verifier"]);

    const st = await status(req("/api/auth/openrouter/status"));
    const body = (await st.json()) as { connected: boolean; keySource: string | null };
    expect(body).toEqual({ connected: true, keySource: "session", selectedModel: null, defaultModel: "x-ai/grok-4.5" });
    leak(JSON.stringify(body), ["sk-or-test-session-key"]);
  });

  it("disconnect wipes the in-memory key", async () => {
    setPkceVerifier("test-verifier");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ key: "sk-or-test-session-key" }),
      })),
    );
    await callback(req("/api/auth/openrouter/callback?code=oauth-code-not-a-key"));
    const gone = await disconnect(req("/api/auth/openrouter/disconnect", { method: "POST" }));
    const body = (await gone.json()) as { connected: boolean };
    expect(body.connected).toBe(false);
    const st = await (await status(req("/api/auth/openrouter/status"))).json();
    expect(st.connected).toBe(false);
    expect(st.keySource).toBeNull();
    leak(JSON.stringify(st), ["sk-or-test-session-key"]);
  });

  it("stores an explicit model slug without echoing any key", async () => {
    process.env.OPENROUTER_API_KEY = "env-only-key";
    const res = await setModel(
      req("/api/auth/openrouter/model", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "x-ai/grok-4.5" }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { selectedModel: string };
    expect(body.selectedModel).toBe("x-ai/grok-4.5");
    leak(JSON.stringify(body), ["env-only-key"]);
  });

  it("proxies the catalog with the resolved key and returns only id/name", async () => {
    process.env.OPENROUTER_API_KEY = "env-only-key";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, init?: RequestInit) => {
        expect(String(url)).toBe("https://openrouter.ai/api/v1/models");
        expect(String(init?.headers && (init.headers as Record<string, string>).Authorization)).toBe("Bearer env-only-key");
        return {
          ok: true,
          json: async () => ({
            data: [
              { id: "x-ai/grok-4.5", name: "Grok 4.5", extra: "drop-me" },
              { id: "not a slug", name: "bad" },
            ],
          }),
        };
      }),
    );
    const res = await catalog(req("/api/auth/openrouter/models"));
    const body = (await res.json()) as { models: Array<{ id: string; name: string }>; keySource: string };
    expect(body.keySource).toBe("env");
    expect(body.models).toEqual([{ id: "x-ai/grok-4.5", name: "Grok 4.5" }]);
    leak(JSON.stringify(body), ["env-only-key"]);
  });
});
