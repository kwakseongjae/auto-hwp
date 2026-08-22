import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isLoopbackRequest,
  localModelsDeniedReason,
  localModelsPageRequest,
  requestOrigin,
} from "./gating";

const ENV_KEYS = ["AUTO_HWP_LOCAL_MODELS", "DEMO_STATIC", "NEXT_PUBLIC_DEMO", "DEMO_AI_MODE"] as const;

function req(url: string, headers?: Record<string, string>): Request {
  return new Request(url, { headers });
}

describe("models-gating", () => {
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("denies when AUTO_HWP_LOCAL_MODELS is off, even on loopback", () => {
    expect(localModelsDeniedReason(req("http://127.0.0.1:3000/api/auth/openrouter/status"))).toBe("flag-off");
  });

  it("allows flag-on loopback across the local ports (dev 3000 / e2e 3100 / launch 3110)", () => {
    process.env.AUTO_HWP_LOCAL_MODELS = "1";
    expect(localModelsDeniedReason(req("http://localhost:3000/api/auth/openrouter/connect"))).toBeNull();
    expect(localModelsDeniedReason(req("http://127.0.0.1:3100/api/auth/openrouter/connect"))).toBeNull();
    expect(
      localModelsDeniedReason(
        req("http://localhost:3110/api/auth/openrouter/connect", { host: "localhost:3110" }),
      ),
    ).toBeNull();
  });

  it("denies a non-loopback host even when the flag is on", () => {
    process.env.AUTO_HWP_LOCAL_MODELS = "1";
    expect(
      localModelsDeniedReason(req("https://autohwp.com/api/auth/openrouter/status", { host: "autohwp.com" })),
    ).toBe("non-loopback");
  });

  it("denies a spoofed X-Forwarded-Host in front of a loopback URL", () => {
    process.env.AUTO_HWP_LOCAL_MODELS = "1";
    expect(
      localModelsDeniedReason(
        req("http://127.0.0.1:3000/api/auth/openrouter/status", {
          host: "127.0.0.1:3000",
          "x-forwarded-host": "autohwp.com",
        }),
      ),
    ).toBe("non-loopback");
  });

  it("keeps the actual page Host authoritative against inverse forwarded-host spoofing", () => {
    process.env.AUTO_HWP_LOCAL_MODELS = "1";

    const publicHost = localModelsPageRequest("autohwp.com", "localhost:3000");
    expect(publicHost).not.toBeNull();
    expect(localModelsDeniedReason(publicHost!)).toBe("non-loopback");

    const loopback = localModelsPageRequest("127.0.0.1:3000", null);
    expect(loopback).not.toBeNull();
    expect(localModelsDeniedReason(loopback!)).toBeNull();

    expect(localModelsPageRequest(null, "localhost:3000")).toBeNull();
  });

  it("denies the static demo build (DEMO_STATIC=1)", () => {
    process.env.AUTO_HWP_LOCAL_MODELS = "1";
    process.env.DEMO_STATIC = "1";
    expect(localModelsDeniedReason(req("http://localhost:3000/api/auth/openrouter/status"))).toBe("demo-static");
  });

  it("denies NEXT_PUBLIC_DEMO=1 the same way as a static export", () => {
    process.env.AUTO_HWP_LOCAL_MODELS = "1";
    process.env.NEXT_PUBLIC_DEMO = "1";
    expect(localModelsDeniedReason(req("http://localhost:3000/api/auth/openrouter/status"))).toBe("demo-static");
  });

  it("denies the hosted server demo (DEMO_AI_MODE=1) even on loopback", () => {
    process.env.AUTO_HWP_LOCAL_MODELS = "1";
    process.env.DEMO_AI_MODE = "1";
    expect(localModelsDeniedReason(req("http://localhost:3000/api/auth/openrouter/status"))).toBe("demo-ai-mode");
  });

  it("treats only localhost / 127.0.0.1 / ::1 as loopback", () => {
    expect(isLoopbackRequest(req("http://localhost/"))).toBe(true);
    expect(isLoopbackRequest(req("http://127.0.0.1:3100/", { host: "127.0.0.1:3100" }))).toBe(true);
    expect(isLoopbackRequest(req("http://[::1]:3000/", { host: "[::1]:3000" }))).toBe(true);
    expect(isLoopbackRequest(req("http://192.168.0.10:3000/", { host: "192.168.0.10:3000" }))).toBe(false);
    expect(isLoopbackRequest(req("https://example.com/", { host: "example.com" }))).toBe(false);
  });

  it("derives the callback origin from the request host (no hardcoded port)", () => {
    expect(requestOrigin(req("http://localhost:3100/api/auth/openrouter/connect", { host: "localhost:3100" }))).toBe(
      "http://localhost:3100",
    );
    expect(requestOrigin(req("http://127.0.0.1:3110/x", { host: "127.0.0.1:3110" }))).toBe("http://127.0.0.1:3110");
  });
});
