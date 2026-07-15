import { NextResponse } from "next/server";
import {
  AGENT_TOOL_EMIT_INTENTS,
  AGENT_TOOL_WEB_SEARCH,
  type AgentEvent,
  type Anchor,
  type Attachment,
  type ChatTurn,
  type Citation,
  type Intent,
  agentToolSchemas,
  buildAgentSystemPrompt,
  buildSystemPrompt,
  buildUserMessage,
  buildUserMessageParts,
  extractCitations,
  serializeAgentEvent,
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

  // ⑤ 데이터 차트(062-follow): "…를 막대/원/선 차트로 만들어" → 결정적 InsertChartAt. 엔진이 스펙을 SVG
  //    차트로 그려(hwp_ops::chart_gen) 이슈 062의 PaintOp::Image.svg 렌더 채널로 심는다 — 키 없이도 데모 완주.
  //    종류는 지시문 단어로 고른다(막대/원/선), 앵커 있으면 그 블록 위치, 없으면 구역 끝(index:null).
  if (/(차트|그래프)/.test(text) && /(만들|삽입|넣|그려|생성|추가)/.test(text)) {
    const type = /원|파이|pie/i.test(text) ? "pie" : /선|꺾은|라인|line/i.test(text) ? "line" : "bar";
    return [
      {
        intent: "InsertChartAt",
        section: a?.section ?? 0,
        index: a ? a.block : null,
        chart: {
          type,
          title: "연도별 매출",
          categories: ["2024", "2025", "2026"],
          series: [{ name: "매출", values: [10, 18, 30] }],
        },
      },
    ];
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
  attachments: Attachment[],
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
    // 멀티모달: 문서 첨부의 추출 텍스트는 buildUserMessage 가 <attachment> R5 펜스로 포함한다(이미지 vision
    // 은 OpenRouter content-parts 경로 — Anthropic 이미지 블록 규격은 다르므로 이 참조 경로에선 텍스트만).
    system: buildSystemPrompt(),
    messages: [{ role: "user", content: buildUserMessage({ instruction, anchors, docContext, attachments }) }],
  });

  // content 블록 중 text 블록만 이어붙인다(adaptive thinking 사용 시 thinking 블록은 무시).
  const text = message.content.map((b) => (b.type === "text" ? b.text : "")).join("");

  // 화이트리스트 + 구조 검증(ai-protocol). 드롭 사유는 서버 로그로.
  return validateResponse(text, { onDrop: (reason) => console.warn(`[hwp-edit] ${reason}`) });
}

// OpenRouter default model(사용자 선택). env `TF_HWP_OPENROUTER_MODEL`로 언제든 override(정확한 슬러그).
// x-ai/grok-4.5 는 OpenRouter 상 input_modalities = ["text","image","file"] — vision 지원(2026-07 실측).
// 그래서 이미지 첨부는 별도 vision 모델로 스왑하지 않고 이 모델로 곧장 content-parts 를 보낸다. 혹시
// 비전 미지원 모델로 override 한 경우를 대비해 `TF_HWP_OPENROUTER_VISION_MODEL` 로 이미지 요청 전용
// 모델을 지정할 수 있다(미지정이면 기본 모델 그대로 — 기본이 vision 이므로 안전).
const OPENROUTER_MODEL = process.env.TF_HWP_OPENROUTER_MODEL || "x-ai/grok-4.5";
const OPENROUTER_VISION_MODEL = process.env.TF_HWP_OPENROUTER_VISION_MODEL || OPENROUTER_MODEL;

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
  attachments: Attachment[],
): Promise<{ intents: Intent[]; citations: Citation[] }> {
  // 멀티모달: 이미지 첨부가 있으면 OpenAI content-PARTS 로 유저 메시지를 조립하고(vision), 이미지 지원
  // 모델을 쓴다. 이미지가 없으면 기존 STRING content 그대로(back-compat). 문서 첨부의 텍스트는 두 경로
  // 모두 buildUserMessage/Parts 가 <attachment> R5 펜스로 포함한다. 첨부는 참고 DATA — intents 레인 불변.
  const hasImage = attachments.some((a) => a.kind === "image" && typeof a.dataUrl === "string" && a.dataUrl.length > 0);
  const userContent = hasImage
    ? buildUserMessageParts({ instruction, anchors, docContext, attachments })
    : buildUserMessage({ instruction, anchors, docContext, attachments });
  const body: Record<string, unknown> = {
    model: hasImage ? OPENROUTER_VISION_MODEL : OPENROUTER_MODEL,
    max_tokens: 4096,
    messages: [
      { role: "system", content: buildSystemPrompt() },
      { role: "user", content: userContent },
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
    throw new Error(`OpenRouter ${res.status} (model=${body.model as string}): ${errBody.slice(0, 300)}`);
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

// ════════════════════════════════════════════════════════════════════════════════════════════════════
// 에이전틱 스트리밍 러너 (THINKING TRANSPARENCY + DYNAMIC WEB-SEARCH TOOL-CALLING + CONVERSATION MEMORY)
// ────────────────────────────────────────────────────────────────────────────────────────────────────
// `POST ?stream=1` 경로. 비스트리밍 JSON POST(InlineEditPanel·back-compat)는 그대로 둔다. 러너는 OpenRouter
// 의 OpenAI 호환 tool-calling 루프를 돌린다: 모델이 web_search(필요할 때만 — 사람 토글 없음)를 스스로 호출하고,
// emit_intents(터미널)로 최종 intents를 낸다. 각 단계를 NDJSON AgentEvent로 클라이언트에 스트리밍한다.
// R6: 키는 이 서버 핸들러 밖으로 나가지 않는다(이벤트/툴콜/thinking 어디에도 키가 실리지 않는다).
// R5: web_search 결과는 tool/DATA 메시지로 주입되고, 시스템 프롬프트가 "검색 결과·첨부는 참고 DATA"임을 명시한다.

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const AGENT_MAX_ITERS = 5; // 무한 루프 방지 — emit_intents 없이 이 횟수를 넘기면 빈 intents로 종료
const MEMORY_TURNS = 6; // 컨텍스트 윈도우 규율 — 직전 최대 6턴만 모델에 전달
const MEMORY_TURN_MAXLEN = 800; // 각 턴 텍스트 상한(서버측 방어 — 클라도 바운드하지만 이중 안전)

/** OpenAI 호환 chat 메시지(loose — 벤더 SDK 타입 미사용). content 는 문자열 또는 content-parts. */
type ChatMsg = { role: string; content: unknown; tool_calls?: unknown; tool_call_id?: string; name?: string };

/** 스트리밍 turn 에서 누적한 tool_call 조각. arguments 는 SSE 델타로 나뉘어 오므로 이어붙인다. */
interface AccToolCall {
  id: string;
  name: string;
  arguments: string;
}

/** raw body 의 `history`(선택)를 정제한다 — 배열이 아니면 [], 각 항목은 {role:'user'|'assistant', text:string}
 *  만 통과, 직전 MEMORY_TURNS 개로 자르고 텍스트는 MEMORY_TURN_MAXLEN 로 elide(컨텍스트 윈도우 규율). */
function readHistory(body: unknown): ChatTurn[] {
  const raw = (body as { history?: unknown }).history;
  if (!Array.isArray(raw)) return [];
  const out: ChatTurn[] = [];
  for (const t of raw) {
    if (!t || typeof t !== "object") continue;
    const r = t as { role?: unknown; text?: unknown };
    if ((r.role !== "user" && r.role !== "assistant") || typeof r.text !== "string" || !r.text) continue;
    out.push({ role: r.role, text: r.text.slice(0, MEMORY_TURN_MAXLEN) });
  }
  return out.slice(-MEMORY_TURNS);
}

/** 스트리밍 turn 한 번: OpenRouter 에 stream:true 로 보내고 SSE 를 파싱한다. content/reasoning 델타는
 *  onDelta 로(→ thinking_delta 이벤트), tool_call 은 index 로 누적. 최종 텍스트/추론/툴콜을 돌려준다.
 *  R6: 키는 헤더에만 실리고 반환값/델타 어디에도 나오지 않는다. mock 테스트는 res.body(ReadableStream) 스텁. */
async function streamOpenRouterTurn(
  apiKey: string,
  body: Record<string, unknown>,
  onDelta: (text: string) => void,
): Promise<{ content: string; toolCalls: AccToolCall[]; rawToolCalls: unknown[] }> {
  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://github.com/kwakseongjae/tf-hwp",
      "X-Title": "tf-hwp",
    },
    body: JSON.stringify({ ...body, stream: true }),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`OpenRouter ${res.status}: ${errBody.slice(0, 300)}`);
  }
  if (!res.body) throw new Error("OpenRouter 스트림 본문이 없습니다.");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let content = "";
  const acc = new Map<number, AccToolCall>();

  const consumeLine = (line: string) => {
    const t = line.trim();
    if (!t.startsWith("data:")) return;
    const data = t.slice(5).trim();
    if (!data || data === "[DONE]") return;
    let json: { choices?: Array<{ delta?: Record<string, unknown> }> };
    try {
      json = JSON.parse(data);
    } catch {
      return; // 하트비트/부분 라인 — 무시
    }
    const delta = json.choices?.[0]?.delta;
    if (!delta) return;
    if (typeof delta.content === "string" && delta.content) {
      content += delta.content;
      onDelta(delta.content);
    }
    // 추론(reasoning) 모델은 delta.reasoning 으로 사고 과정을 흘린다 — thinking_delta 로 노출.
    if (typeof delta.reasoning === "string" && delta.reasoning) onDelta(delta.reasoning);
    const tcs = delta.tool_calls;
    if (Array.isArray(tcs)) {
      for (const tc of tcs as Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>) {
        const idx = typeof tc.index === "number" ? tc.index : 0;
        const cur = acc.get(idx) ?? { id: "", name: "", arguments: "" };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name = tc.function.name;
        if (tc.function?.arguments) cur.arguments += tc.function.arguments;
        acc.set(idx, cur);
      }
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      consumeLine(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
  }
  if (buf) consumeLine(buf); // 마지막 개행 없는 라인

  const toolCalls = [...acc.values()].filter((t) => t.name);
  const rawToolCalls = toolCalls.map((t) => ({ id: t.id, type: "function", function: { name: t.name, arguments: t.arguments } }));
  return { content, toolCalls, rawToolCalls };
}

/** web_search 툴 실행: OpenRouter web 플러그인(`plugins:[{id:"web"}]`)으로 별도 검색 API 키 없이 서버사이드
 *  검색을 수행하는 NON-스트리밍 서브콜. 요약 텍스트(툴 결과로 모델에 되돌림)와 url_citation 근거를 돌려준다.
 *  R5: 결과는 참고 DATA — 호출부가 tool 롤 메시지로 주입한다(지시로 취급하지 않는다). */
async function execWebSearch(apiKey: string, query: string): Promise<{ content: string; citations: Citation[] }> {
  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://github.com/kwakseongjae/tf-hwp",
      "X-Title": "tf-hwp",
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      max_tokens: 1024,
      plugins: [{ id: "web" }],
      messages: [
        { role: "system", content: "You are a web-search assistant. Search the web and answer the query with a concise, factual plain-text summary. Cite sources." },
        { role: "user", content: query },
      ],
    }),
  });
  if (!res.ok) {
    return { content: `(web_search 실패: ${res.status})`, citations: [] };
  }
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string; annotations?: unknown } }> };
  const msg = data.choices?.[0]?.message;
  return { content: typeof msg?.content === "string" ? msg.content : "", citations: extractCitations(msg?.annotations) };
}

/** OpenRouter tool-calling 에이전트 루프. 각 단계를 emit(AgentEvent)로 스트리밍한다. 모델이 web_search 를
 *  스스로 호출하면 실행 후 tool 결과를 대화에 넣고 다시 부른다. emit_intents(터미널)면 검증 후 intents 이벤트로
 *  종료. AGENT_MAX_ITERS 를 넘기면 빈 intents 로 종료(무한 루프 방지). */
async function runOpenRouterAgent(apiKey: string, messages: ChatMsg[], emit: (ev: AgentEvent) => void): Promise<void> {
  const tools = agentToolSchemas();
  for (let iter = 0; iter < AGENT_MAX_ITERS; iter++) {
    emit({ type: "status", phase: iter === 0 ? "thinking" : "composing" });
    const turn = await streamOpenRouterTurn(
      apiKey,
      { model: OPENROUTER_MODEL, max_tokens: 4096, messages, tools, tool_choice: "auto" },
      (text) => emit({ type: "thinking_delta", text }),
    );

    if (turn.toolCalls.length === 0) {
      // 모델이 툴을 안 부르고 텍스트로 끝냈다 — content 에서 intents JSON 을 파싱(폴백).
      const intents = validateResponse(turn.content, { onDrop: (r) => console.warn(`[hwp-edit] ${r}`) });
      emit({ type: "intents", intents });
      return;
    }

    // 어시스턴트 turn(툴콜 포함)을 대화에 추가한다(OpenAI tool-calling 규약).
    messages.push({ role: "assistant", content: turn.content || "", tool_calls: turn.rawToolCalls });

    let terminated = false;
    for (const tc of turn.toolCalls) {
      let args: Record<string, unknown> = {};
      try {
        args = tc.arguments ? (JSON.parse(tc.arguments) as Record<string, unknown>) : {};
      } catch {
        args = {};
      }
      if (tc.name === AGENT_TOOL_EMIT_INTENTS) {
        const intents = validateResponse(args.intents, { onDrop: (r) => console.warn(`[hwp-edit] ${r}`) });
        emit({ type: "intents", intents });
        terminated = true;
        break;
      } else if (tc.name === AGENT_TOOL_WEB_SEARCH) {
        const query = typeof args.query === "string" ? args.query : "";
        emit({ type: "status", phase: "searching" });
        emit({ type: "tool_call", tool: "web_search", args: { query } });
        const { content, citations } = await execWebSearch(apiKey, query);
        emit({ type: "tool_result", tool: "web_search", citations });
        messages.push({ role: "tool", tool_call_id: tc.id, name: "web_search", content });
      } else {
        // 미지 툴 — 빈 결과로 되돌려 루프가 진행되게 한다.
        messages.push({ role: "tool", tool_call_id: tc.id, name: tc.name, content: "" });
      }
    }
    if (terminated) return;
  }
  // 반복 소진 — emit_intents 없이 끝났다면 빈 제안.
  emit({ type: "intents", intents: [] });
}

/** Anthropic 경로 스트리밍(내장 웹 검색 없음): 사고 상태 → 비스트리밍 liveIntents 호출 → intents 이벤트.
 *  타임라인은 최소지만(1 status + intents) 계약은 동일하다(back-compat 우아한 격하). */
async function runAnthropicAgent(
  apiKey: string,
  instruction: string,
  anchors: Anchor[],
  docContext: string,
  attachments: Attachment[],
  emit: (ev: AgentEvent) => void,
): Promise<void> {
  emit({ type: "status", phase: "thinking" });
  const intents = await liveIntents(apiKey, instruction, anchors, docContext, attachments);
  emit({ type: "intents", intents });
}

/** mock 경로 스트리밍(키 없음): 결정적 타임라인(thinking → composing → intents)으로 데모가 키 없이도 완주한다.
 *  mockIntents 를 그대로 재사용해 비스트리밍 mock 과 제안이 일치한다(회귀 방지). 웹 검색 없음. */
function runMockAgent(instruction: string, anchors: Anchor[], docContext: string, emit: (ev: AgentEvent) => void): void {
  emit({ type: "status", phase: "thinking" });
  emit({ type: "thinking_delta", text: "요청을 이해하고 편집을 구성합니다 (데모 모드 — 실제 이해 없음)." });
  emit({ type: "status", phase: "composing" });
  emit({ type: "intents", intents: mockIntents(instruction, anchors, docContext) });
}

/** 에이전틱 스트림 응답을 만든다: NDJSON(AgentEvent per line)의 ReadableStream. start 콜백이 러너를 돌리고
 *  emit 은 각 이벤트를 컨트롤러에 enqueue 한다. 예외는 error 이벤트로 감싸 스트림을 정상 종료한다(500 대신). */
function buildAgentStream(
  provider: "openrouter" | "anthropic" | "mock",
  instruction: string,
  anchors: Anchor[],
  docContext: string,
  attachments: Attachment[],
  history: ChatTurn[],
): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (ev: AgentEvent) => controller.enqueue(enc.encode(serializeAgentEvent(ev)));
      try {
        if (provider === "mock") {
          runMockAgent(instruction, anchors, docContext, emit);
        } else if (provider === "anthropic") {
          await runAnthropicAgent(process.env.ANTHROPIC_API_KEY!, instruction, anchors, docContext, attachments, emit);
        } else {
          // OpenRouter tool-calling 루프. 시스템(에이전트 프롬프트) + 메모리(직전 턴) + 유저 turn 을 조립한다.
          const hasImage = attachments.some((a) => a.kind === "image" && typeof a.dataUrl === "string" && a.dataUrl.length > 0);
          const userContent = hasImage
            ? buildUserMessageParts({ instruction, anchors, docContext, attachments })
            : buildUserMessage({ instruction, anchors, docContext, attachments });
          const messages: ChatMsg[] = [{ role: "system", content: buildAgentSystemPrompt() }];
          for (const turn of history) messages.push({ role: turn.role, content: turn.text });
          messages.push({ role: "user", content: userContent });
          await runOpenRouterAgent(process.env.OPENROUTER_API_KEY!, messages, emit);
        }
      } catch (e) {
        const detail = e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : String(e);
        console.error("[hwp-edit] agent stream failed:", detail);
        emit({ type: "error", message: `에이전트 실패: ${detail}` });
      } finally {
        controller.close();
      }
    },
  });
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
  // 멀티모달: validateRequest 가 sanitize 한 첨부(이미지 dataUrl / 문서 text, well-formed 만). 없으면 [].
  const attachments = check.value.attachments ?? [];
  // Feature A: 명시적 웹 검색 플래그(선택) — validateRequest 계약(instruction/anchors/docContext) 밖의
  // 부가 필드라 raw body에서 직접 읽는다(boolean 아니면 false). intents 스키마와 무관(요청 부가 옵션).
  const webSearch = typeof (body as { webSearch?: unknown }).webSearch === "boolean" ? (body as { webSearch: boolean }).webSearch : false;

  const provider = activeProvider();

  // ── 에이전틱 스트리밍 경로(?stream=1): NDJSON AgentEvent 스트림 ────────────────────────────────────
  // 채팅 타임라인(onEvent)이 이 경로를 탄다. 모델이 web_search 를 스스로 결정하고 emit_intents 로 마친다.
  // 대화 메모리(history, 바운드)를 모델 messages 에 접는다. 비스트리밍 JSON POST(아래)는 그대로 둔다.
  if (new URL(req.url).searchParams.get("stream") === "1") {
    const history = readHistory(body);
    const stream = buildAgentStream(provider, instruction, anchors, docContext, attachments, history);
    return new Response(stream, {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no", // 프록시 버퍼링 비활성(즉시 플러시)
      },
    });
  }

  if (provider === "mock") {
    // mock 모드 — 결정적 편집 제안(키 없이 전체 플로우 완주 가능). mock은 웹 검색을 하지 않으므로 근거 없음.
    return NextResponse.json({ intents: mockIntents(instruction, anchors, docContext), citations: [], mode: "mock", provider: "mock" });
  }
  try {
    if (provider === "openrouter") {
      const { intents, citations } = await openRouterIntents(process.env.OPENROUTER_API_KEY!, instruction, anchors, docContext, webSearch, attachments);
      return NextResponse.json({ intents, citations, mode: "live", provider });
    }
    // Anthropic 경로는 내장 웹 검색이 없다(Grok과 달리) — 근거 없음(빈 배열)으로 형태만 additive 유지.
    const intents = await liveIntents(process.env.ANTHROPIC_API_KEY!, instruction, anchors, docContext, attachments);
    return NextResponse.json({ intents, citations: [], mode: "live", provider });
  } catch (e) {
    const detail = e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : String(e);
    console.error("[hwp-edit] live LLM call failed:", detail);
    return NextResponse.json({ error: `LLM 호출 실패: ${detail}` }, { status: 502 });
  }
}
