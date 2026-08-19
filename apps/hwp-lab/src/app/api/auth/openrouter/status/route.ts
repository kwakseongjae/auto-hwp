import { NextResponse } from "next/server";
import { openRouterEnvDefaultModel, peekOpenRouterKeySource } from "@/lib/openrouter/resolveKey";
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
    defaultModel: openRouterEnvDefaultModel(),
  });
}
