import { exchangeOpenRouterCode } from "@/lib/openrouter/oauth";
import { setOpenRouterSessionKey, takePkceVerifier } from "@/lib/openrouter/session";
import { modelsRedirect, rejectIfGated } from "../_guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const gated = rejectIfGated(req);
  if (gated) return gated;

  const url = new URL(req.url);
  const code = url.searchParams.get("code")?.trim() ?? "";
  // `code` is expected in the URL (it is not the key). Missing/empty is a failed handshake.
  if (!code) return modelsRedirect(req, { error: "missing_code" });

  const verifier = takePkceVerifier();
  if (!verifier) return modelsRedirect(req, { error: "missing_verifier" });

  try {
    const key = await exchangeOpenRouterCode(code, verifier);
    setOpenRouterSessionKey(key);
  } catch {
    return modelsRedirect(req, { error: "exchange_failed" });
  }
  return modelsRedirect(req, { connected: "1" });
}
