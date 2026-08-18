// OpenRouter PKCE session — process memory only (issue #56).
//
// Next dev HMR re-evaluates modules, so a module-level `let` would drop the key and a stale
// `connected=true` on the client could silently fall through to env. The store lives on
// `globalThis` (Symbol.for) and every status/edit request re-reads it.

export type OpenRouterSession = {
  key: string | null;
  codeVerifier: string | null;
  selectedModel: string | null;
};

const STORE = Symbol.for("auto-hwp.openrouter.session.v1");

type GlobalBag = typeof globalThis & {
  [STORE]?: OpenRouterSession;
};

function emptySession(): OpenRouterSession {
  return { key: null, codeVerifier: null, selectedModel: null };
}

export function getOpenRouterSession(): OpenRouterSession {
  const g = globalThis as GlobalBag;
  if (!g[STORE]) g[STORE] = emptySession();
  return g[STORE];
}

export function getOpenRouterSessionKey(): string | null {
  const key = getOpenRouterSession().key?.trim() ?? "";
  return key || null;
}

export function setOpenRouterSessionKey(key: string): void {
  const trimmed = key.trim();
  if (!trimmed) throw new Error("OpenRouter session key must be non-empty.");
  getOpenRouterSession().key = trimmed;
}

export function setPkceVerifier(verifier: string): void {
  const trimmed = verifier.trim();
  if (!trimmed) throw new Error("PKCE verifier must be non-empty.");
  getOpenRouterSession().codeVerifier = trimmed;
}

/** Read-and-clear the pending verifier so a code cannot be exchanged twice. */
export function takePkceVerifier(): string | null {
  const session = getOpenRouterSession();
  const verifier = session.codeVerifier?.trim() ?? "";
  session.codeVerifier = null;
  return verifier || null;
}

export function getSelectedOpenRouterModel(): string | null {
  const model = getOpenRouterSession().selectedModel?.trim() ?? "";
  return model || null;
}

export function setSelectedOpenRouterModel(model: string | null): void {
  getOpenRouterSession().selectedModel = model?.trim() || null;
}

/** Wipe every in-memory field. Does not revoke the key on OpenRouter's side. */
export function clearOpenRouterSession(): void {
  const session = getOpenRouterSession();
  session.key = null;
  session.codeVerifier = null;
  session.selectedModel = null;
}

export function resetOpenRouterSessionForTests(): void {
  const g = globalThis as GlobalBag;
  g[STORE] = emptySession();
}
