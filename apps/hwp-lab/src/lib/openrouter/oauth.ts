// OpenRouter official PKCE (S256) helpers.
// https://openrouter.ai/docs/guides/overview/auth/oauth
//
// The OAuth `code` travels in the callback URL by design. The boundary is the
// exchanged **key**, which never leaves this server process.

import { createHash, randomBytes } from "node:crypto";

export const OPENROUTER_AUTH_URL = "https://openrouter.ai/auth";
export const OPENROUTER_KEY_EXCHANGE_URL = "https://openrouter.ai/api/v1/auth/keys";
export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

const MODEL_SLUG = /^[a-zA-Z0-9][a-zA-Z0-9+_./:-]{0,199}$/;

export function isOpenRouterModelSlug(value: string): boolean {
  return MODEL_SLUG.test(value);
}

export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function openRouterAuthorizeUrl(callbackUrl: string, challenge: string): string {
  const url = new URL(OPENROUTER_AUTH_URL);
  url.searchParams.set("callback_url", callbackUrl);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export async function exchangeOpenRouterCode(code: string, verifier: string): Promise<string> {
  const res = await fetch(OPENROUTER_KEY_EXCHANGE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code,
      code_verifier: verifier,
      code_challenge_method: "S256",
    }),
  });
  if (!res.ok) {
    throw new Error(`OpenRouter key exchange failed (${res.status})`);
  }
  let data: { key?: unknown };
  try {
    data = (await res.json()) as { key?: unknown };
  } catch {
    throw new Error("OpenRouter key exchange returned a non-JSON body");
  }
  if (typeof data.key !== "string" || !data.key.trim()) {
    throw new Error("OpenRouter key exchange returned no key");
  }
  return data.key.trim();
}

export type OpenRouterCatalogEntry = { id: string; name: string };

export async function fetchOpenRouterCatalog(apiKey: string): Promise<OpenRouterCatalogEntry[]> {
  const res = await fetch(OPENROUTER_MODELS_URL, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    throw new Error(`OpenRouter models catalog failed (${res.status})`);
  }
  const body = (await res.json()) as { data?: unknown };
  if (!Array.isArray(body.data)) return [];
  const out: OpenRouterCatalogEntry[] = [];
  for (const row of body.data) {
    if (!row || typeof row !== "object") continue;
    const rec = row as { id?: unknown; name?: unknown };
    if (typeof rec.id !== "string" || !rec.id.trim()) continue;
    const id = rec.id.trim();
    if (!isOpenRouterModelSlug(id)) continue;
    const name = typeof rec.name === "string" && rec.name.trim() ? rec.name.trim() : id;
    out.push({ id, name });
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}
