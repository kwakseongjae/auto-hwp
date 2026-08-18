import { NextResponse } from "next/server";
import { fetchOpenRouterCatalog } from "@/lib/openrouter/oauth";
import { MissingOpenRouterKeyError, resolveOpenRouterKey } from "@/lib/openrouter/resolveKey";
import { rejectIfGated } from "../_guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const gated = rejectIfGated(req);
  if (gated) return gated;

  let resolved: ReturnType<typeof resolveOpenRouterKey>;
  try {
    resolved = resolveOpenRouterKey();
  } catch (e) {
    if (e instanceof MissingOpenRouterKeyError) {
      return NextResponse.json({ error: e.message }, { status: 409 });
    }
    throw e;
  }

  try {
    const models = await fetchOpenRouterCatalog(resolved.key);
    return NextResponse.json({ models, keySource: resolved.source });
  } catch {
    return NextResponse.json({ error: "OpenRouter model catalog could not be loaded." }, { status: 502 });
  }
}
