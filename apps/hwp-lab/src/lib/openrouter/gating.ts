// Dual gate for local Models / OpenRouter PKCE routes (issue #56).
//
// Both must pass:
//   1. AUTO_HWP_LOCAL_MODELS=1  (never set on Vercel)
//   2. the request host is loopback (server-side — build-time gating is not enough
//      because the hosted demo ships the same route tree)
//
// Static demo (DEMO_STATIC / NEXT_PUBLIC_DEMO) and server demo (DEMO_AI_MODE) deny
// even if someone sets the flag.

export type LocalModelsDenyReason = "flag-off" | "demo-static" | "demo-ai-mode" | "non-loopback";

export function isLocalModelsFlagOn(): boolean {
  return process.env.AUTO_HWP_LOCAL_MODELS === "1";
}

export function isDemoStaticBuild(): boolean {
  return process.env.DEMO_STATIC === "1" || process.env.NEXT_PUBLIC_DEMO === "1";
}

export function isDemoAiModeOn(): boolean {
  return process.env.DEMO_AI_MODE === "1";
}

export function hostnameOf(host: string | null | undefined): string | null {
  if (!host) return null;
  const first = host.split(",")[0]?.trim() ?? "";
  if (!first) return null;
  if (first.startsWith("[")) {
    const end = first.indexOf("]");
    if (end > 1) return first.slice(1, end).toLowerCase();
  }
  const noPort = first.replace(/:\d+$/, "");
  return noPort.toLowerCase();
}

export function isLoopbackHostname(hostname: string | null | undefined): boolean {
  if (!hostname) return false;
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

export function isLoopbackRequest(req: Request): boolean {
  const urlHost = hostnameOf(new URL(req.url).host);
  const host = hostnameOf(req.headers.get("host"));
  const forwarded = hostnameOf(req.headers.get("x-forwarded-host"));
  const candidates = [urlHost, host].filter((h): h is string => Boolean(h));
  if (candidates.length === 0) return false;
  if (!candidates.every(isLoopbackHostname)) return false;
  // A non-loopback forwarded host means a proxy in front — treat as public.
  if (forwarded && !isLoopbackHostname(forwarded)) return false;
  return true;
}

export function localModelsDeniedReason(req: Request): LocalModelsDenyReason | null {
  if (isDemoStaticBuild()) return "demo-static";
  if (isDemoAiModeOn()) return "demo-ai-mode";
  if (!isLocalModelsFlagOn()) return "flag-off";
  if (!isLoopbackRequest(req)) return "non-loopback";
  return null;
}

/** Callback / connect URL origin from the request itself — no hardcoded 3000/3100/3110. */
export function requestOrigin(req: Request): string {
  const url = new URL(req.url);
  const host = req.headers.get("host");
  if (host && isLoopbackHostname(hostnameOf(host))) {
    return `${url.protocol}//${host}`;
  }
  return url.origin;
}
