import { NextResponse } from "next/server";
import { DEFAULT_OPENROUTER_MODEL, peekOpenRouterKeySource, resolveOpenRouterModel } from "@/lib/openrouter/resolveKey";
import { getOpenRouterSessionKey, getSelectedOpenRouterModel } from "@/lib/openrouter/session";
import { rejectIfGated } from "../_guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const gated = rejectIfGated(req);
  if (gated) return gated;

  const connected = Boolean(getOpenRouterSessionKey());
  const keySource = peekOpenRouterKeySource();
  return NextResponse.json({
    connected,
    keySource,
    selectedModel: getSelectedOpenRouterModel(),
    defaultModel: resolveOpenRouterModel() || DEFAULT_OPENROUTER_MODEL,
  });
}
