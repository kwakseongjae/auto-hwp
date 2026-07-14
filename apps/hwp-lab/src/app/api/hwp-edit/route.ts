import { NextResponse } from "next/server";
import {
  type Anchor,
  type Citation,
  type Intent,
  buildSystemPrompt,
  buildUserMessage,
  extractCitations,
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

/** 그리드 문자열(066)에서 셀 주소 토큰 `(r{행}c{열})<값>` 을 파싱한다 — `buildDocContext` 의 그리드
 *  렌더러가 넣은 형식. 각 셀의 (row, col) 과 빈칸(`_빈칸_`) 여부를 돌려준다. mock 이 "표 채워줘" 데모에서
 *  라벨칸이 아니라 빈 값칸을 겨냥하도록 쓴다(그리드 인지 실증). */
function parseGridCells(docContext: string): { row: number; col: number; empty: boolean }[] {
  const out: { row: number; col: number; empty: boolean }[] = [];
  const re = /\(r(\d+)c(\d+)\)([^|\n]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(docContext))) {
    out.push({ row: parseInt(m[1], 10), col: parseInt(m[2], 10), empty: m[3].trim() === "_빈칸_" });
  }
  return out;
}

/** 결정적 mock — anchors[0]을 겨냥해 "PoC ✔" 편집을 만든다(키 없이도 전체 플로우 완주).
 *  이슈 051: 구조 편집 어휘가 열렸으므로 mock 도 결정적 구조 제안을 만든다 —
 *  ① "N×M 표 …(삽입|넣|추가|만들)" → `InsertTableAt` (앵커 있으면 그 블록 위치, 없으면 구역 끝 = index:null),
 *  ② "…삭제" + 앵커 → `DeleteBlock` (프리뷰 카드의 원문 표시 + 명시 승인 게이트를 mock 으로도 완주),
 *  ③ "행 …추가" + 표/셀 앵커 → `TableAppendRow`. 나머지는 기존 채움 mock 그대로.
 *  이슈 066: ④ "표 …채워" + 표(전체) 앵커 + doc-context 그리드 → 빈 값칸마다 `SetTableCell` (라벨칸
 *  오타겟 방지를 그리드로 실증; 얇은 컨텍스트에서 intents 0 이던 증상 재현/해소). */
function mockIntents(instruction: string, anchors: Anchor[], docContext: string): Intent[] {
  const a = anchors[0];
  const text = instruction.trim();

  // ② 블록 삭제 (구조 편집 — 반드시 앵커를 겨냥; 앵커 없으면 제안하지 않는다: 자의적 삭제 금지).
  if (/삭제/.test(text) && a) {
    return [{ intent: "DeleteBlock", section: a.section, index: a.block }];
  }

  // ① 표 삽입: "3x4 표 넣어줘" 류. 크기 미지정이면 2×2. 앵커가 있으면 그 블록 위치에, 없으면 구역 끝.
  if (/표/.test(text) && /(삽입|넣|추가|만들)/.test(text) && !/행/.test(text)) {
    const m = text.match(/(\d+)\s*[x×]\s*(\d+)/);
    const rows = Math.max(1, Math.min(20, m ? parseInt(m[1], 10) : 2));
    const cols = Math.max(1, Math.min(20, m ? parseInt(m[2], 10) : 2));
    const grid = Array.from({ length: rows }, () => Array.from({ length: cols }, () => ({})));
    return [{ intent: "InsertTableAt", section: a?.section ?? 0, index: a ? a.block : null, rows: grid }];
  }

  // ③ 행 추가: 표/셀 앵커의 표 블록에 merge-safe 빈 행 1개.
  if (/행/.test(text) && /(추가|삽입|넣)/.test(text) && a && (a.kind === "table" || a.kind === "cell" || a.kind === "range")) {
    return [{ intent: "TableAppendRow", section: a.section, index: a.block }];
  }

  // ④ 표 채우기(066): 표/셀 앵커 + "채워"류 지시 + doc-context 그리드가 있으면 빈(_빈칸_) 값칸마다
  //    SetTableCell 을 만든다 — 그리드가 없던 얇은 컨텍스트에선 (0,0) 라벨칸을 겨냥하거나 intents 0
  //    이던 증상을 그리드 인지로 교정(라벨칸은 건드리지 않는다). 실제 값 매핑은 라이브 모델의 몫이고,
  //    mock 은 결정적 "PoC ✔" 로 빈칸 타겟팅이 그리드에서 나왔음을 실증한다. 빈칸이 없으면 아래 폴백.
  if (/(채워|채우|입력|작성)/.test(text) && a && (a.kind === "table" || a.kind === "cell")) {
    const blanks = parseGridCells(docContext).filter((c) => c.empty);
    if (blanks.length) {
      return blanks.map((c) => ({ intent: "SetTableCell", section: a.section, index: a.block, row: c.row, col: c.col, text: "PoC ✔" }));
    }
  }

  if (!a) return [];
  if (a.kind === "table" || a.kind === "range" || a.kind === "cell") {
    // 셀 앵커(023)면 클릭한 그 셀(rows/cols)을 겨냥한다 — row0/col0 고정 제거. 표/범위 앵커는 rows/cols
    // 가 없으므로 첫 칸(0,0)으로 폴백. (live SYSTEM_PROMPT 는 이미 앵커 좌표를 겨냥하도록 지시.)
    return [{ intent: "SetTableCell", section: a.section, index: a.block, row: a.rows?.[0] ?? 0, col: a.cols?.[0] ?? 0, text: "PoC ✔" }];
  }
  if (a.kind === "paragraph") {
    return [{ intent: "SetParagraphText", section: a.section, block: a.block, text: text.slice(0, 60) || "PoC ✔" }];
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

// OpenRouter default model(사용자 선택). env `TF_HWP_OPENROUTER_MODEL`로 언제든 override(정확한 슬러그).
const OPENROUTER_MODEL = process.env.TF_HWP_OPENROUTER_MODEL || "x-ai/grok-4.5";

/** OpenRouter(OpenAI 호환 Chat Completions) 경로. 키는 이 서버 핸들러 밖으로 나가지 않는다(R6).
 *  system/user 프롬프트(R5 펜스·화이트리스트·doc-context)는 Anthropic 경로와 동일하게 ai-protocol이 조립.
 *  Feature A: `webSearch`가 참이면 OpenRouter web 플러그인(`plugins:[{id:"web"}]`)을 켠다 — 서버가
 *  서버사이드로 웹을 검색해 컨텍스트에 주입하고(별도 검색 API·tool-calling 리팩터 불필요), 모델은 여전히
 *  우리 JSON intents를 반환한다. 응답 message.annotations의 `url_citation`을 근거(citations)로 파싱한다.
 *  매 편집마다 검색/과금하지 않도록 `webSearch` 옵트인일 때만 플러그인을 켠다. */
async function openRouterIntents(
  apiKey: string,
  instruction: string,
  anchors: Anchor[],
  docContext: string,
  webSearch: boolean,
): Promise<{ intents: Intent[]; citations: Citation[] }> {
  const body: Record<string, unknown> = {
    model: OPENROUTER_MODEL,
    max_tokens: 4096,
    messages: [
      { role: "system", content: buildSystemPrompt() },
      { role: "user", content: buildUserMessage({ instruction, anchors, docContext }) },
    ],
  };
  // 검색이 요구될 때만 web 플러그인을 켠다(옵트인) — 클라이언트의 "🔎 웹 검색" 토글이 이 플래그를 보낸다.
  if (webSearch) body.plugins = [{ id: "web" }];
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      // OpenRouter 권장(선택) — 랭킹/식별용, 키 노출 아님.
      "HTTP-Referer": "https://github.com/kwakseongjae/tf-hwp",
      "X-Title": "tf-hwp",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`OpenRouter ${res.status} (model=${OPENROUTER_MODEL}): ${errBody.slice(0, 300)}`);
  }
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string; annotations?: unknown } }> };
  const message = data.choices?.[0]?.message;
  const text = message?.content ?? "";
  // Anthropic 경로와 동일 검증(화이트리스트 + 구조). 드롭 사유는 서버 로그로. intents 검증은 불변.
  const intents = validateResponse(text, { onDrop: (reason) => console.warn(`[hwp-edit] ${reason}`) });
  // Feature A: 근거(출처)는 intents 레인과 별개로 annotations에서 파싱(표시 전용, R5/R6 보존).
  const citations = extractCitations(message?.annotations);
  return { intents, citations };
}

/** 프로바이더 우선순위: OpenRouter(있으면) → Anthropic → mock. */
function activeProvider(): "openrouter" | "anthropic" | "mock" {
  if (process.env.OPENROUTER_API_KEY) return "openrouter";
  if (process.env.ANTHROPIC_API_KEY) return "anthropic";
  return "mock";
}

export async function GET() {
  const provider = activeProvider();
  const model = provider === "openrouter" ? OPENROUTER_MODEL : provider === "anthropic" ? "claude-opus-4-8" : null;
  return NextResponse.json({ mode: provider === "mock" ? "mock" : "live", provider, model });
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
  // Feature A: 명시적 웹 검색 플래그(선택) — validateRequest 계약(instruction/anchors/docContext) 밖의
  // 부가 필드라 raw body에서 직접 읽는다(boolean 아니면 false). intents 스키마와 무관(요청 부가 옵션).
  const webSearch = typeof (body as { webSearch?: unknown }).webSearch === "boolean" ? (body as { webSearch: boolean }).webSearch : false;

  const provider = activeProvider();
  if (provider === "mock") {
    // mock 모드 — 결정적 편집 제안(키 없이 전체 플로우 완주 가능). mock은 웹 검색을 하지 않으므로 근거 없음.
    return NextResponse.json({ intents: mockIntents(instruction, anchors, docContext), citations: [], mode: "mock", provider: "mock" });
  }
  try {
    if (provider === "openrouter") {
      const { intents, citations } = await openRouterIntents(process.env.OPENROUTER_API_KEY!, instruction, anchors, docContext, webSearch);
      return NextResponse.json({ intents, citations, mode: "live", provider });
    }
    // Anthropic 경로는 내장 웹 검색이 없다(Grok과 달리) — 근거 없음(빈 배열)으로 형태만 additive 유지.
    const intents = await liveIntents(process.env.ANTHROPIC_API_KEY!, instruction, anchors, docContext);
    return NextResponse.json({ intents, citations: [], mode: "live", provider });
  } catch (e) {
    const detail = e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : String(e);
    console.error("[hwp-edit] live LLM call failed:", detail);
    return NextResponse.json({ error: `LLM 호출 실패: ${detail}` }, { status: 502 });
  }
}
