import { NextResponse } from "next/server";
import { requestOrigin } from "@/lib/openrouter/gating";
import { generatePkce, openRouterAuthorizeUrl } from "@/lib/openrouter/oauth";
import { setPkceVerifier } from "@/lib/openrouter/session";
import { rejectIfGated } from "../_guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const gated = rejectIfGated(req);
  if (gated) return gated;

  const { verifier, challenge } = generatePkce();
  setPkceVerifier(verifier);
  const callbackUrl = `${requestOrigin(req)}/api/auth/openrouter/callback`;
  return NextResponse.redirect(openRouterAuthorizeUrl(callbackUrl, challenge));
}
