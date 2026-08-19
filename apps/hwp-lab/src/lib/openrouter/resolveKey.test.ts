import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MissingOpenRouterKeyError,
  peekOpenRouterKeySource,
  resolveOpenRouterKey,
  resolveOpenRouterModel,
} from "./resolveKey";
import {
  resetOpenRouterSessionForTests,
  setOpenRouterSessionKey,
  setSelectedOpenRouterModel,
} from "./session";

const ENV_KEYS = ["OPENROUTER_API_KEY", "AUTO_HWP_OPENROUTER_MODEL", "AUTO_HWP_OPENROUTER_VISION_MODEL"] as const;

describe("resolveOpenRouterKey", () => {
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

  beforeEach(() => {
    resetOpenRouterSessionForTests();
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    resetOpenRouterSessionForTests();
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("prefers the PKCE session key over env (verbatim, no masking)", () => {
    process.env.OPENROUTER_API_KEY = "env-fallback-key";
    setOpenRouterSessionKey("session-priority-key");
    expect(resolveOpenRouterKey()).toEqual({ key: "session-priority-key", source: "session" });
    expect(peekOpenRouterKeySource()).toBe("session");
  });

  it("falls back to env when the session store is empty", () => {
    process.env.OPENROUTER_API_KEY = "env-only-key";
    expect(resolveOpenRouterKey()).toEqual({ key: "env-only-key", source: "env" });
    expect(peekOpenRouterKeySource()).toBe("env");
  });

  it("throws an explicit error when neither session nor env has a key", () => {
    expect(() => resolveOpenRouterKey()).toThrow(MissingOpenRouterKeyError);
    expect(() => resolveOpenRouterKey()).toThrow(/no PKCE session key and no OPENROUTER_API_KEY/);
    expect(peekOpenRouterKeySource()).toBeNull();
  });

  it("treats blank/whitespace env as missing (no silent empty key)", () => {
    process.env.OPENROUTER_API_KEY = "   ";
    expect(() => resolveOpenRouterKey()).toThrow(MissingOpenRouterKeyError);
    expect(peekOpenRouterKeySource()).toBeNull();
  });

  it("does not silently mask the resolved key as another provider source", () => {
    setOpenRouterSessionKey("session-priority-key");
    process.env.OPENROUTER_API_KEY = "env-fallback-key";
    const resolved = resolveOpenRouterKey();
    expect(resolved.source).not.toBe("env");
    expect(resolved.key).not.toBe("env-fallback-key");
    expect(resolved.key).not.toMatch(/^\*+$/);
    expect(resolved.key).toBe("session-priority-key");
  });
});

describe("resolveOpenRouterModel", () => {
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

  beforeEach(() => {
    resetOpenRouterSessionForTests();
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    resetOpenRouterSessionForTests();
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("uses the request model over the stored selection and env default", () => {
    process.env.AUTO_HWP_OPENROUTER_MODEL = "env/default-model";
    setSelectedOpenRouterModel("session/stored-model");
    expect(resolveOpenRouterModel("request/chosen-model")).toBe("request/chosen-model");
  });

  it("uses the stored selection when the request does not name a model", () => {
    process.env.AUTO_HWP_OPENROUTER_MODEL = "env/default-model";
    setSelectedOpenRouterModel("session/stored-model");
    expect(resolveOpenRouterModel(undefined, { hasImage: true })).toBe("session/stored-model");
  });

  it("does not silently swap an explicit model for the vision override", () => {
    process.env.AUTO_HWP_OPENROUTER_VISION_MODEL = "env/vision-model";
    expect(resolveOpenRouterModel("request/chosen-model", { hasImage: true })).toBe("request/chosen-model");
  });

  it("keeps the env default / vision override when nothing is selected", () => {
    process.env.AUTO_HWP_OPENROUTER_MODEL = "env/default-model";
    process.env.AUTO_HWP_OPENROUTER_VISION_MODEL = "env/vision-model";
    expect(resolveOpenRouterModel()).toBe("env/default-model");
    expect(resolveOpenRouterModel(null, { hasImage: true })).toBe("env/vision-model");
  });
});
