// 공개 데모 AI 모드 (Vercel full-Next 이전 — services/demo-ai-proxy 의 Cloudflare Worker 하드닝 포팅).
//
// 왜 있나: 정적 데모(GitHub Pages)는 서버가 없어 키를 담을 데가 없었고, 그래서 별도 Worker 가 키를
// 쥐고 남용/비용을 막았다. Vercel(full Next)로 옮기면 **같은 오리진의 라우트 핸들러**가 그 역할을
// 할 수 있다 — 그 하드닝을 여기로 옮긴다. 이 파일이 데모 경로의 전부이고, 기존 BYOK 경로(route.ts 의
// mock/openrouter/anthropic + 스트리밍)는 **한 줄도 바뀌지 않는다**: 데모 모드는 `DEMO_AI_MODE=1`
// 이 명시적으로 켜졌을 때만 POST 를 가로챈다.
//
// ⚠️ 운영 함정(정직하게): `OPENROUTER_API_KEY` 를 공개 배포에 넣으면서 `DEMO_AI_MODE=1` 을 빠뜨리면
// BYOK 경로(모델 grok-4.5 · max_tokens 4096 · 웹검색 툴콜 · 한도 없음)가 **인증 없이 공개**된다.
// 공개 배포에서 키를 넣는다면 DEMO_AI_MODE=1 은 선택이 아니라 필수다.
//
// 남용 저항(Worker 와 동일 계약):
//  ① 클라이언트는 {instruction, docContext, anchors} 만 보낸다 — 시스템/유저 프롬프트는 서버가
//     @auto-hwp/ai-protocol 로 조립한다(모델 출력이 우리 JSON Intent 형식으로 제한되고, 프롬프트
//     계약이 앱과 드리프트하지 않는다).
//  ② known-field 검증(validateRequest + 데모 상한) · 본문 바이트 상한 · 상류 텍스트 상한.
//  ③ 모델·max_tokens·reasoning effort·zdr 은 **서버 고정**(env 로만 오버라이드).
//  ④ 일일 전체 캡 + IP 캡. Upstash(REST)가 있으면 durable, 없으면 인메모리 best-effort.
//  ⑤ Origin same-origin 검증(브라우저 교차 출처 사용 차단).

import {
  buildSystemPrompt,
  buildUserMessage,
  salvageJsonArrayItems,
  validateRequest,
  validateResponse,
  type EditFailureReason,
  type Intent,
} from "@auto-hwp/ai-protocol";

/** 기본 모델: GPT-5.6 Luna(base — luna-pro 아님). Worker 실측에서 요청당 ~$0.0005(최악 $0.001) ·
 *  ZDR 라우팅 가능 · Intent JSON 형식 준수 확인됨. Gemini 계열은 서버리스 출구 리전 차단 이력이 있어
 *  기본에서 제외한다. `DEMO_AI_MODEL`(또는 Worker 와 같은 이름의 `MODEL`)로만 바꾼다 — 바꾸면 아래
 *  예산 계산을 **반드시** 새 단가로 다시 한다. */
const DEFAULT_MODEL = "openai/gpt-5.6-luna";

const MAX_REQUEST_BYTES = 128 * 1024;
const MAX_UPSTREAM_TEXT_BYTES = 128 * 1024;

/** 출력 토큰 상한(기본값 = 허용 최대값).
 *
 *  Worker 는 2048 이었다(추론 토큰이 max_tokens 에 합산돼 1024 에서 다중 셀 채움이 절단 → 전량 드롭).
 *  라우트는 4096 으로 올린다(BYOK 경로와 같은 값 — 8쪽 표 다중 채움에서 절단 여유).
 *
 *  ⚠️ 예산 재계산(단가 $0.10/M 입력 · $0.60/M 출력):
 *    출력 4,096 tok × $0.60/M                    = $0.00246
 *    입력 ≈12,483 tok × $0.10/M (아래 상한 역산)  = $0.00125
 *    요청당 최악 ≈ $0.0037 → × DAILY 2000 = **$7.4/일**.
 *  즉 Worker 시절의 "$5/일" 방어선은 4096 에서 그대로는 성립하지 않는다. 실사용은 출력 상한을 거의
 *  다 쓰지 않아(2필드 요청 수백 토큰) 실제 일예산은 $1~2 수준이지만, **최악을 $5 아래로 잠그고 싶으면
 *  `DEMO_AI_DAILY_CAP=1300`** 으로 내려라(1300 × $0.0037 ≈ $4.8). 기본값은 태스크 지시대로 2000. */
const MAX_TOKENS_CEILING = 4096;

/** 추론 노력 기본값. 구조화 추출 작업이라 깊은 추론이 필요 없고, 추론 토큰이 출력 예산을 먹어 절단을
 *  유발한 장본인이다 → "low". `DEMO_AI_REASONING_EFFORT=""`(빈 문자열)이면 필드 자체를 안 보낸다(롤백). */
const DEFAULT_REASONING_EFFORT = "low";
const REASONING_EFFORTS = new Set(["minimal", "low", "medium", "high"]);

/** 데모 입력 상한(Worker 와 동일 — 위 예산 계산의 입력 항이 여기서 나온다. 어느 쪽을 바꾸든 같이 고쳐라).
 *  maxDocContext 8000 = 클라 `buildDocContext` 기본 maxLen 과 같은 값이라 정상 요청은 절대 걸리지 않고,
 *  서버가 조용히 자르는 대신 거절하므로 그리드가 소리 없이 잘려 나가지 않는다. 첨부(attachments)는 데모에서
 *  0 — 이미지/문서 첨부는 비용·PII 표면이 커서 BYOK 전용이다. */
const DEMO_REQUEST_LIMITS = {
  maxInstruction: 1500,
  maxDocContext: 8000,
  maxAnchors: 20,
  maxAnchorLabel: 200,
  maxAnchorText: 2000,
  maxAnchorPath: 8,
  maxAnchorsJson: 8192,
  maxAttachments: 0,
  maxAttachmentText: 0,
  maxImageDataUrl: 0,
} as const;

const DEFAULT_DAILY_CAP = 2000;
const DEFAULT_PER_IP_CAP = 20;
/** 카운터 TTL — 키에 UTC 날짜가 박혀 있어 25시간이면 자연 소멸(별도 청소 불필요). */
const COUNTER_TTL_SECONDS = 90_000;

/** `DEMO_AI_MODE=1` 일 때만 데모 경로가 POST 를 가로챈다(BYOK 계약 보호 — 기본값은 항상 꺼짐). */
export function isDemoAiMode(): boolean {
  return process.env.DEMO_AI_MODE === "1";
}

export function demoModel(): string {
  return (process.env.DEMO_AI_MODEL || process.env.MODEL || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
}

function positiveConfigInt(raw: string | undefined, fallback: number, max: number): number | null {
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 && value <= max ? value : null;
}

function jsonRes(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/** UTC 날짜 키 — 매일 0시(UTC)에 카운터가 자연 리셋되도록 키에 날짜를 박는다. */
function dayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

// ── Origin(same-origin) 검증 ────────────────────────────────────────────────────────────────────────
// 데모 라우트는 **우리 페이지에서만** 불린다. 브라우저는 교차 출처 POST 에 Origin 을 반드시 실으므로,
// Origin 의 호스트가 이 요청의 호스트와 다르면 거절한다(CORS 헤더를 내지 않으므로 브라우저가 응답을
// 읽지도 못하지만, 서버 비용은 이미 나간 뒤다 — 그래서 상류 호출 전에 끊는다).
// `DEMO_AI_ALLOWED_ORIGIN`(콤마 구분)으로 추가 오리진을 명시 허용할 수 있다(프리뷰 도메인 등).
// ⚠️ 정직하게: 이건 브라우저 남용을 막는 저지선이지 인증이 아니다 — curl 은 Origin 을 위조할 수 있다.
// 비용의 절대 방어선은 아래 일일/IP 캡이다.
export function originAllowed(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return false; // 브라우저 POST 는 항상 Origin 을 싣는다 — 없으면 우리 UI 가 아니다.
  const extra = (process.env.DEMO_AI_ALLOWED_ORIGIN || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (extra.includes(origin)) return true;
  // 이 요청이 도착한 호스트는 셋 중 하나로 읽힌다: Host 헤더 · Vercel 의 x-forwarded-host(커스텀
  // 도메인 리라이트) · 프레임워크가 재조립한 req.url. 어느 하나와 맞으면 same-origin 이다.
  const targets = new Set<string>();
  for (const h of [req.headers.get("host"), req.headers.get("x-forwarded-host")]) {
    if (h) targets.add(h.trim());
  }
  try {
    targets.add(new URL(req.url).host);
  } catch {
    /* 상대 URL — 무시 */
  }
  try {
    return targets.has(new URL(origin).host);
  } catch {
    return false;
  }
}

// ── 본문 읽기(바이트 상한) ──────────────────────────────────────────────────────────────────────────

type BodyRead = { ok: true; value: unknown } | { ok: false; status: 400 | 413 | 415; error: string };

/** 신뢰 불가 본문을 **바이트 상한과 함께** 읽는다(Content-Length 없는 chunked 포함). `req.json()` 만
 *  쓰면 공격자 크기의 본문을 먼저 할당하게 된다. */
export async function readJsonLimited(req: Request, maxBytes: number = MAX_REQUEST_BYTES): Promise<BodyRead> {
  const contentType = req.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    return { ok: false, status: 415, error: "content-type must be application/json" };
  }
  const declaredRaw = req.headers.get("content-length");
  if (declaredRaw !== null) {
    const declared = Number(declaredRaw);
    if (!Number.isSafeInteger(declared) || declared < 0) return { ok: false, status: 400, error: "invalid content-length" };
    if (declared > maxBytes) return { ok: false, status: 413, error: `request body too large (>${maxBytes} bytes)` };
  }
  if (!req.body) return { ok: false, status: 400, error: "invalid JSON" };
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("request body too large").catch(() => undefined);
        return { ok: false, status: 413, error: `request body too large (>${maxBytes} bytes)` };
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, status: 400, error: "invalid JSON" };
  } finally {
    reader.releaseLock();
  }
}

// ── 일일/IP 캡 ──────────────────────────────────────────────────────────────────────────────────────
// Worker 는 KV 를 썼다. 서버리스에는 그런 게 없으므로 두 저장소를 지원한다:
//   ① Upstash Redis REST (UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN) — durable. 인스턴스가
//      몇 개로 늘어나도 카운터가 하나다. 공개 배포라면 이걸 켜라.
//   ② 인메모리 폴백 — **정직하게: 서버리스 인스턴스마다 별도 카운터다.** Vercel 은 트래픽에 따라
//      람다를 여러 개 띄우고 유휴 시 얼려 버리므로, 실제 허용량은 "캡 × 살아 있는 인스턴스 수"까지
//      새어 나갈 수 있고 인스턴스가 재활용되면 카운터가 0 으로 돌아간다. 즉 이 폴백은 **비용의 절대
//      상한이 아니라 사고 방지용 best-effort**다. 예산이 실제로 걸린 배포에는 Upstash 를 붙여라.

type Counter = { count: number; resetAt: number };
const memoryCounters = new Map<string, Counter>();

/** 테스트/운영 점검용 — 인메모리 카운터를 비운다(프로세스 로컬). */
export function resetMemoryCounters(): void {
  memoryCounters.clear();
}

function bumpMemory(key: string, ttlMs: number): number {
  const now = Date.now();
  // 게으른 청소: 만료된 키를 훑어 지운다(키 공간은 날짜×IP 라 자연히 작다).
  if (memoryCounters.size > 5000) {
    for (const [k, v] of memoryCounters) if (v.resetAt <= now) memoryCounters.delete(k);
  }
  const cur = memoryCounters.get(key);
  if (!cur || cur.resetAt <= now) {
    memoryCounters.set(key, { count: 1, resetAt: now + ttlMs });
    return 1;
  }
  cur.count += 1;
  return cur.count;
}

/** Upstash REST 파이프라인으로 INCR + EXPIRE 를 한 번에. 실패하면 null(호출부가 인메모리로 격하). */
async function bumpUpstash(url: string, token: string, key: string, ttl: number): Promise<number | null> {
  try {
    const res = await fetch(`${url.replace(/\/+$/, "")}/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify([
        ["INCR", key],
        ["EXPIRE", key, String(ttl)],
      ]),
      cache: "no-store",
    });
    if (!res.ok) return null;
    const data = (await res.json()) as Array<{ result?: unknown; error?: unknown }>;
    const n = Array.isArray(data) ? data[0]?.result : undefined;
    return typeof n === "number" ? n : null;
  } catch {
    return null;
  }
}

/** 카운터 1 증가 후 현재 값. Upstash 가 설정돼 있으면 durable, 아니면(또는 호출 실패면) 인메모리. */
export async function bumpCounter(key: string): Promise<number> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) {
    const n = await bumpUpstash(url, token, key, COUNTER_TTL_SECONDS);
    // Upstash 장애 시 조용히 무제한이 되지 않도록 인메모리로 격하한다(둘 다 실패는 없다).
    if (n !== null) return n;
  }
  return bumpMemory(key, COUNTER_TTL_SECONDS * 1000);
}

/** 요청자 식별 — Vercel 은 `x-forwarded-for` 첫 항목이 클라이언트 IP다(x-real-ip 폴백). */
function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim() || "unknown";
  return req.headers.get("x-real-ip")?.trim() || "unknown";
}

// ── 핸들러 ──────────────────────────────────────────────────────────────────────────────────────────

export interface DemoConfig {
  model: string;
  maxTokens: number;
  dailyCap: number;
  perIpCap: number;
  effort: string;
}

type ConfigRead = { ok: true; value: DemoConfig } | { ok: false; error: string };

export function readDemoConfig(): ConfigRead {
  const dailyCap = positiveConfigInt(process.env.DEMO_AI_DAILY_CAP, DEFAULT_DAILY_CAP, 1_000_000);
  const perIpCap = positiveConfigInt(process.env.DEMO_AI_PER_IP_CAP, DEFAULT_PER_IP_CAP, 100_000);
  const maxTokens = positiveConfigInt(process.env.DEMO_AI_MAX_TOKENS, MAX_TOKENS_CEILING, MAX_TOKENS_CEILING);
  if (dailyCap === null || perIpCap === null || maxTokens === null || perIpCap > dailyCap) {
    return { ok: false, error: "데모 AI 한도 설정이 잘못되었습니다(서버 env 확인 필요)." };
  }
  // 설정 오타로 예산 계산 밖의 추론 노력이 나가지 않게 화이트리스트로 잠근다(빈 값 = 미전송).
  const effort = (process.env.DEMO_AI_REASONING_EFFORT ?? DEFAULT_REASONING_EFFORT).trim();
  if (effort && !REASONING_EFFORTS.has(effort)) {
    return { ok: false, error: "데모 AI 한도 설정이 잘못되었습니다(reasoning effort 값 확인 필요)." };
  }
  return { ok: true, value: { model: demoModel(), maxTokens, dailyCap, perIpCap, effort } };
}

/** 데모 AI 가 켜졌지만 키가 없을 때의 **정직한** 응답(500 금지). 프리뷰 배포처럼 env 를 아직 안 넣은
 *  상태에서 채팅이 조용히 죽지 않고 "무엇이 없는지"를 말한다. */
const UNCONFIGURED_MESSAGE =
  "데모 AI가 아직 구성되지 않았습니다(서버에 OPENROUTER_API_KEY 없음). 문서 열기·수동 편집·HTML/PDF 저장은 그대로 동작합니다.";

/** 데모 모드 POST 핸들러. route.ts 의 POST 가 `isDemoAiMode()` 일 때 가장 먼저 위임한다. */
export async function handleDemoEdit(req: Request): Promise<Response> {
  if (!originAllowed(req)) return jsonRes({ error: "origin not allowed" }, 403);

  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) return jsonRes({ error: UNCONFIGURED_MESSAGE, reason: "upstream_error" as EditFailureReason }, 503);

  const cfg = readDemoConfig();
  if (!cfg.ok) return jsonRes({ error: cfg.error }, 503);
  const { model, maxTokens, dailyCap, perIpCap, effort } = cfg.value;

  // ── 요청 파싱·검증 ────────────────────────────────────────────────────────────────────────────
  // 잘못된 요청이 유효 사용자의 일일 쿼터를 태우지 않도록 비용 카운터보다 **먼저** 검증한다.
  const body = await readJsonLimited(req, MAX_REQUEST_BYTES);
  if (!body.ok) return jsonRes({ error: body.error }, body.status);
  const checked = validateRequest(body.value, DEMO_REQUEST_LIMITS);
  if (!checked.ok) return jsonRes({ error: checked.error }, 400);
  const { instruction, docContext, anchors } = checked.value;
  if (!instruction.trim()) return jsonRes({ error: "instruction 이 비어 있습니다" }, 400);

  // 프롬프트는 **서버가** 조립한다(앱과 같은 ai-protocol — 계약 드리프트 없음 + 프롬프트 주입 표면 축소).
  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserMessage({ instruction, anchors, docContext, attachments: [] });
  const enc = new TextEncoder();
  const upstreamBytes = enc.encode(systemPrompt).byteLength + enc.encode(userPrompt).byteLength;
  if (upstreamBytes > MAX_UPSTREAM_TEXT_BYTES) {
    return jsonRes({ error: `AI context too large (>${MAX_UPSTREAM_TEXT_BYTES} bytes)` }, 413);
  }

  // ── 한도 ──────────────────────────────────────────────────────────────────────────────────────
  const day = dayKey();
  const ipCount = await bumpCounter(`ah:demo:ip:${day}:${clientIp(req)}`);
  if (ipCount > perIpCap) {
    return jsonRes(
      { error: "오늘 이 브라우저의 데모 사용 한도를 다 썼습니다. 내일 다시 시도하거나, 레포를 클론해 로컬(BYOK)에서 무제한으로 쓰세요." },
      429,
    );
  }
  const dayCount = await bumpCounter(`ah:demo:all:${day}`);
  if (dayCount > dailyCap) {
    return jsonRes({ error: "오늘 데모 전체 사용 한도를 다 썼습니다(예산 보호). 내일 다시 열립니다." }, 429);
  }

  // ── 상류 호출(모델·상한·zdr 전부 서버 고정) ────────────────────────────────────────────────────
  let orRes: Response;
  try {
    orRes = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/kwakseongjae/auto-hwp",
        "X-Title": "auto-hwp demo",
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        temperature: 0.2, // 결정성 우선(구조화 Intent 추출)
        ...(effort ? { reasoning: { effort } } : {}),
        // 문서 프로필/본문 발췌/표에는 PII 가 있을 수 있다. ZDR endpoint 가 없는 모델/route 는
        // OpenRouter 가 오류로 거부하게 해 조용한 개인정보 정책 완화를 막는다(079 계약).
        provider: { zdr: true },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
    });
  } catch (e) {
    return jsonRes({ error: `upstream fetch 실패: ${String(e).slice(0, 200)}`, reason: "upstream_error" as EditFailureReason }, 502);
  }
  if (!orRes.ok) {
    const t = await orRes.text().catch(() => "");
    return jsonRes({ error: `OpenRouter ${orRes.status}: ${t.slice(0, 200)}`, reason: "upstream_error" as EditFailureReason }, 502);
  }

  const data = (await orRes.json()) as {
    choices?: Array<{ message?: { content?: string }; finish_reason?: string; native_finish_reason?: string }>;
    usage?: { completion_tokens?: number };
  };
  const choice = data.choices?.[0];
  const text = choice?.message?.content ?? "";
  // 절단 판정: OpenRouter 표준 finish_reason("length") 또는 프로바이더 원본 값. 절단이면 JSON 이
  // 배열 중간에서 끊겨 파싱이 통째로 실패한다 — 그래서 "왜 0건인지"를 반드시 실어 보낸다.
  const truncated = choice?.finish_reason === "length" || choice?.native_finish_reason === "length";
  const drops: string[] = [];
  const onDrop = (r: string) => drops.push(r);
  let intents: Intent[] = validateResponse(text, { onDrop });
  let salvaged = 0;
  if (intents.length === 0 && truncated) {
    // 절단 응답 구제: 이미 닫힌 Intent 만 회수하고 반쪽은 버린다(deny_unknown 규율 유지). 화이트리스트
    // 검증은 그대로 통과시킨다 — 구제 경로가 검증을 우회하지 않는다.
    intents = validateResponse(salvageJsonArrayItems(text), { onDrop });
    salvaged = intents.length;
  }
  // 관측(요청 내용은 로그하지 않는다 — 카운트/사유만).
  if (truncated || intents.length === 0) {
    console.warn(
      JSON.stringify({
        event: "demo_empty_or_truncated",
        finish_reason: choice?.finish_reason ?? null,
        truncated,
        completion_tokens: data.usage?.completion_tokens ?? null,
        content_len: text.length,
        intents: intents.length,
        salvaged,
        drops: drops.length,
      }),
    );
  }

  const payload: { intents: Intent[]; citations: never[]; mode: "live"; provider: "demo"; reason?: EditFailureReason; message?: string } = {
    intents,
    citations: [], // 데모는 웹 검색을 쓰지 않는다 — 형태만 additive 유지(클라 계약 불변)
    mode: "live",
    provider: "demo",
  };
  if (truncated) {
    payload.reason = "truncated";
    payload.message = salvaged
      ? `모델 응답이 길이 제한에 걸려 잘렸습니다 — 온전한 ${salvaged}건만 제안합니다. 나머지는 요청을 나눠서 다시 시도해 주세요.`
      : "모델 응답이 길이 제한에 걸려 잘렸습니다(제안 0건). 한 번에 채울 항목 수를 줄여 다시 시도해 주세요.";
  } else if (intents.length === 0) {
    payload.reason = "no_valid_intents";
    payload.message = drops.length
      ? "모델이 지원하지 않는 형식으로 답해 적용할 편집을 만들지 못했습니다. 다시 시도하거나 지시를 더 구체적으로 적어 주세요."
      : "이 요청에서 적용할 편집을 찾지 못했습니다. 편집할 표/문단을 선택하고 지시를 더 구체적으로 적어 주세요.";
  }
  return jsonRes(payload, 200);
}

/** 데모 모드의 GET(프로브). 키가 없으면 `mode:"static"` — 클라가 "AI 없음"으로 정직하게 표시한다
 *  (mock 이 아니다: mock 은 결정적 가짜 편집이 **동작하는** 상태다). */
export function demoProbe(): Response {
  const configured = Boolean(process.env.OPENROUTER_API_KEY?.trim());
  return jsonRes(
    {
      mode: configured ? "live" : "static",
      provider: "demo",
      model: configured ? demoModel() : null,
      configured,
      ...(configured ? {} : { message: UNCONFIGURED_MESSAGE }),
    },
    200,
  );
}
