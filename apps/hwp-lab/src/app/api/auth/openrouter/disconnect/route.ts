import { NextResponse } from "next/server";
import { openRouterEnvDefaultModel, peekOpenRouterKeySource } from "@/lib/openrouter/resolveKey";
import { clearOpenRouterSession, getSelectedOpenRouterModel } from "@/lib/openrouter/session";
import { rejectIfGated } from "../_guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const gated = rejectIfGated(req);
  if (gated) return gated;
  clearOpenRouterSession();
  return NextResponse.json({
    connected: false,
    keySource: peekOpenRouterKeySource(),
    selectedModel: getSelectedOpenRouterModel(),
    defaultModel: openRouterEnvDefaultModel(),
  });
}
