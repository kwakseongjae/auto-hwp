import { NextResponse } from "next/server";
import { localModelsDeniedReason } from "@/lib/openrouter/gating";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Dual-gate failure is a 404 so the local-only surface is not advertised on hosted builds. */
export function rejectIfGated(req: Request): NextResponse | null {
  if (!localModelsDeniedReason(req)) return null;
  return NextResponse.json({ error: "not found" }, { status: 404 });
}

export function modelsRedirect(req: Request, query: Record<string, string>): NextResponse {
  const url = new URL("/models", req.url);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return NextResponse.redirect(url);
}
