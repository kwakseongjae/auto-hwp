// OpenRouter key + model resolver (issue #56).
//
// `resolveOpenRouterKey() = session key ?? env`. Callers that already decided the
// provider is OpenRouter must use this — they must not fall back to Anthropic/mock
// and must not invent or mask a key. Missing both sources is an explicit error.

import { getOpenRouterSessionKey, getSelectedOpenRouterModel } from "./session";

export const DEFAULT_OPENROUTER_MODEL = "x-ai/grok-4.5";

export type OpenRouterKeySource = "session" | "env";

export class MissingOpenRouterKeyError extends Error {
  readonly code = "missing_openrouter_key" as const;
  constructor() {
    super("OpenRouter API key is not available (no PKCE session key and no OPENROUTER_API_KEY).");
    this.name = "MissingOpenRouterKeyError";
  }
}

export function peekOpenRouterKeySource(): OpenRouterKeySource | null {
  if (getOpenRouterSessionKey()) return "session";
  if (process.env.OPENROUTER_API_KEY?.trim()) return "env";
  return null;
}

/** Session key wins. Env is the fallback. Neither → throw (no silent empty/masked key). */
export function resolveOpenRouterKey(): { key: string; source: OpenRouterKeySource } {
  const session = getOpenRouterSessionKey();
  if (session) return { key: session, source: "session" };
  const env = process.env.OPENROUTER_API_KEY?.trim() ?? "";
  if (env) return { key: env, source: "env" };
  throw new MissingOpenRouterKeyError();
}

/**
 * Explicit request/session selection wins and is never swapped for a vision model.
 * Without an explicit choice, env default (and the existing vision override) apply.
 */
export function resolveOpenRouterModel(requested?: string | null, opts?: { hasImage?: boolean }): string {
  const fromRequest = typeof requested === "string" ? requested.trim() : "";
  const fromSession = getSelectedOpenRouterModel() ?? "";
  const explicit = fromRequest || fromSession;
  if (explicit) return explicit;

  const envModel = process.env.AUTO_HWP_OPENROUTER_MODEL?.trim() || DEFAULT_OPENROUTER_MODEL;
  if (opts?.hasImage) {
    return process.env.AUTO_HWP_OPENROUTER_VISION_MODEL?.trim() || envModel;
  }
  return envModel;
}
