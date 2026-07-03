import { NextResponse } from "next/server";
import {
  type Anchor,
  type Intent,
  buildSystemPrompt,
  buildUserMessage,
  validateRequest,
  validateResponse,
} from "@tf-hwp/ai-protocol";

// @anthropic-ai/sdk 는 route handler(Node.js 런타임)에서만 사용. edge 런타임 선언 금지(이슈 §함정).
// API 키/LLM 코드는 이 서버 전용 모듈에만 존재 — 클라이언트 번들에 절대 포함되지 않는다(R6).
export const runtime = "nodejs";
// GET 이 요청 시점의 env(키 유무)를 읽도록 정적 최적화를 끈다.
export const dynamic = "force-dynamic";

// ── 프로토콜은 @tf-hwp/ai-protocol 로 승격됨(이슈 026) ─────────────────────────
// SYSTEM_PROMPT/화이트리스트/입력검증/R5 펜스/doc-context 조립은 이제 벤더 중립 패키지가 소유하며,
// 서버(이 프록시)와 클라이언트(LabWorkspace)가 같은 모듈을 import 한다(계약 드리프트 방지).
// 이 파일에 남는 것은 "참조 프록시" — 벤더(Anthropic)·키·모델 선택뿐. 다른 벤더로 복사해 쓰면 된다.

function badRequest(error: string) {
  return NextResponse.json({ error }, { status: 400 });
}

/** 결정적 mock — anchors[0]을 겨냥해 "PoC ✔" 편집을 만든다(키 없이도 전체 플로우 완주). */
function mockIntents(instruction: string, anchors: Anchor[]): Intent[] {
  const a = anchors[0];
  if (!a) return [];
  if (a.kind === "table" || a.kind === "range" || a.kind === "cell") {
    // 셀 앵커(023)면 클릭한 그 셀(rows/cols)을 겨냥한다 — row0/col0 고정 제거. 표/범위 앵커는 rows/cols
    // 가 없으므로 첫 칸(0,0)으로 폴백. (live SYSTEM_PROMPT 는 이미 앵커 좌표를 겨냥하도록 지시.)
    return [{ intent: "SetTableCell", section: a.section, index: a.block, row: a.rows?.[0] ?? 0, col: a.cols?.[0] ?? 0, text: "PoC ✔" }];
  }
  if (a.kind === "paragraph") {
    const text = instruction.trim().slice(0, 60) || "PoC ✔";
    return [{ intent: "SetParagraphText", section: a.section, block: a.block, text }];
  }
  return [];
}

async function liveIntents(
  apiKey: string,
  instruction: string,
  anchors: Anchor[],
  docContext: string,
): Promise<Intent[]> {
  // 서버 전용 동적 import — 클라이언트 번들 분석 경로에 절대 들어오지 않는다.
  const AnthropicMod = await import("@anthropic-ai/sdk");
  const Anthropic = AnthropicMod.default;
  const client = new Anthropic({ apiKey });

  const message = await client.messages.create({
    model: "claude-opus-4-8",
    max_tokens: 4096,
    thinking: { type: "adaptive" },
    // system 프롬프트/유저 메시지(R5 펜스 포함)는 ai-protocol 이 조립 — 클라와 동일 규격.
    system: buildSystemPrompt(),
    messages: [{ role: "user", content: buildUserMessage({ instruction, anchors, docContext }) }],
  });

  // content 블록 중 text 블록만 이어붙인다(adaptive thinking 사용 시 thinking 블록은 무시).
  const text = message.content.map((b) => (b.type === "text" ? b.text : "")).join("");

  // 화이트리스트 + 구조 검증(ai-protocol). 드롭 사유는 서버 로그로.
  return validateResponse(text, { onDrop: (reason) => console.warn(`[hwp-edit] ${reason}`) });
}

export async function GET() {
  const mode = process.env.ANTHROPIC_API_KEY ? "live" : "mock";
  return NextResponse.json({ mode });
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return badRequest("요청 본문 JSON 파싱 실패.");
  }
  const check = validateRequest(body);
  if (!check.ok) return badRequest(check.error);
  const { instruction, anchors, docContext } = check.value;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // mock 모드 — 결정적 편집 제안(전체 플로우 완주 가능).
    return NextResponse.json({ intents: mockIntents(instruction, anchors), mode: "mock" });
  }
  try {
    const intents = await liveIntents(apiKey, instruction, anchors, docContext);
    return NextResponse.json({ intents, mode: "live" });
  } catch (e) {
    const detail = e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : String(e);
    console.error("[hwp-edit] live LLM call failed:", detail);
    return NextResponse.json({ error: `LLM 호출 실패: ${detail}` }, { status: 502 });
  }
}
