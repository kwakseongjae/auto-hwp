import { NextResponse } from "next/server";
import { isOpenRouterModelSlug } from "@/lib/openrouter/oauth";
import { setSelectedOpenRouterModel } from "@/lib/openrouter/session";
import { rejectIfGated } from "../_guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const gated = rejectIfGated(req);
  if (gated) return gated;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "요청 본문 JSON 파싱 실패." }, { status: 400 });
  }
  const raw = body && typeof body === "object" ? (body as { model?: unknown }).model : undefined;
  const model = typeof raw === "string" ? raw.trim() : "";
  if (!isOpenRouterModelSlug(model)) {
    return NextResponse.json({ error: "유효한 OpenRouter 모델 슬러그가 필요합니다." }, { status: 400 });
  }
  setSelectedOpenRouterModel(model);
  return NextResponse.json({ selectedModel: model });
}
