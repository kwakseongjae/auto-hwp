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
//  ④ IP 캡(상시) + 일일 전체 캡(기본 400회, env 로 더 낮출 수 있음).
//     Upstash(REST)가 있으면 durable, 없으면 인메모리 best-effort.
//  ⑤ Origin same-origin 검증(브라우저 교차 출처 사용 차단).

import {
  buildSystemPrompt,
  buildUserMessage,
  extractJsonArray,
  salvageJsonArrayItems,
  validateRequest,
  validateResponse,
  type EditFailureReason,
  type Intent,
} from "@auto-hwp/ai-protocol";

/** 기본 모델: GPT-5.6 Luna(base — luna-pro 아님). 2026-08-08 실전 docContext(6,082 token) 청구
 *  실측은 요청당 약 $0.0124였다. ZDR 라우팅 가능 · Intent JSON 형식 준수 확인됨. Gemini 계열은 서버리스 출구 리전 차단 이력이 있어
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
 *  ⚠️ 공급자 표면 단가만으로 역산한 과거 $0.0037 상한은 실제 청구를 설명하지 못했다. 2026-08-08
 *  실전 요청은 약 $0.0124였으므로 운영 예산은 **실측값**을 사용한다. 기본 전역 400회면 약 $4.96/일
 *  (과금 재시도 전)이다. 모델·프롬프트·재시도 정책이 바뀌면 실제 usage를 다시 재고 기본 캡을 조정한다. */
const MAX_TOKENS_CEILING = 4096;
const DEFAULT_DAILY_CAP = 400;

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

/** IP 캡(기본 20/일). 전역 캡과 함께 한 사용자가 전체 예산을 독점하지 못하게 한다.
 *
 *  20 을 그대로 둔 근거: (a) Worker 시절부터 쓰던 값이고 이 값이 막았다는 사용자 신고나 실사용 분포
 *  측정치가 **아직 없다** — 근거 없이 올리면 방어선만 헐거워진다. (b) 실제 청구 평균 $0.0124 기준
 *  한 IP가 20회를 모두 쓰면 약 $0.25다. 올릴 때는 반드시 실사용 분포(요청/세션 p95)를 먼저 재고,
 *  IP별 예산을 다시 계산한 뒤 `DEMO_AI_PER_IP_CAP` 로 올려라(코드 기본값보다 env 가 되돌리기 쉽다).
 *  ⚠️ 정직하게: IP 캡은 NAT/공유망(회사·학교·모바일 캐리어)에서는 **여러 사람이 한 몫을 나눠 쓰고**,
 *  반대로 IPv6·모바일 로밍처럼 주소가 자주 바뀌는 환경에서는 우회된다. 인증이 아니라 저지선이다. */
const DEFAULT_PER_IP_CAP = 20;
/** 카운터 TTL — 키에 UTC 날짜가 박혀 있어 25시간이면 자연 소멸(별도 청소 불필요). */
const COUNTER_TTL_SECONDS = 90_000;

/** 상류 재시도 정책 (2026-08-08 프로덕션 장애 실측 — "다중 셀 채움이 조용히 0건").
 *
 *  무슨 일이 있었나: OpenRouter 는 프로바이더가 혼잡하면 **HTTP 200 본문에**
 *  `{"error":{"code":429,"message":"… is temporarily rate-limited upstream …"}}` 를 실어 보낸다.
 *  `res.ok` 가 true 라 오류 분기를 그냥 통과했고, `choices` 가 없어 content 가 `""` 가 되었으며,
 *  빈 문자열은 파싱되지 않아 intents 0 · drops 0 → **`no_valid_intents`**("이 요청에서 적용할 편집을
 *  찾지 못했습니다")로 둔갑했다. 즉 상류 장애가 사용자에게는 "당신 지시가 잘못됐다"로 보였다.
 *  실측(동일 payload): 1회차 = 위 429 봉투, **2회차 = 16건 정상 반환**(finish_reason=stop).
 *
 *  그래서 두 가지를 한다: ① 200-본문-오류를 **오류로 판정**하고(침묵 금지) ② 일시적 무과금 실패는
 *  최대 3회, 모델이 답했지만 형식이 깨진 과금 실패는 1회만 자동 재시도한다.
 *
 *  ⚠️ 비용: IP/전역 캡은 **사용자 요청**을 세고 상류 재시도는 세지 않는다. 과금 호출은 최대 2회라
 *  실측 평균의 약 2배까지 갈 수 있다. 재시도 횟수를 올리기 전 usage와 기본 400회 캡을 함께 재산정한다. */
const MAX_UPSTREAM_ATTEMPTS = 4;
/** **과금된** 시도(모델이 실제로 답을 생성한 호출)의 상한. 위 4회는 혼잡 실패를 넘기기 위한 것이고,
 *  이 2회가 비용의 실제 상한이다 — 혼잡(429) 응답은 토큰을 생성하지 않아 **$0** 이기 때문이다
 *  (실측: 429 봉투는 usage 없이 ~300ms 에 돌아온다). 그래서 "혼잡은 넉넉히, 과금은 딱 한 번 더". */
const MAX_BILLED_ATTEMPTS = 2;
/** 재시도 백오프 기반값 — n회차 실패 후 `기반값 × n` 만큼 쉰다(1s → 2s → 3s, 합계 6초).
 *  실측 근거(2026-08-08 로컬): 600ms 고정도, 800ms×n(합 2.4초)도 같은 혼잡 창에 다시 걸렸다.
 *  혼잡 재시도는 공짜라 시간만 있으면 더 기다리는 편이 사용자에게 이득이다(아래 DEADLINE 이 상한). */
const DEFAULT_RETRY_DELAY_MS = 1000;
/** 백오프 기반값을 env 로 조정한다(운영 튜닝 + 테스트에서 0 으로 낮추기). 잘못된 값이면 기본값. */
function retryDelayMs(): number {
  const raw = Number(process.env.DEMO_AI_RETRY_DELAY_MS);
  return Number.isSafeInteger(raw) && raw >= 0 && raw <= 5000 ? raw : DEFAULT_RETRY_DELAY_MS;
}
/** 이 시각을 넘겨서는 2회차를 **시작하지 않는다**. 함수 실행 시간(route.ts `maxDuration`) 안에서
 *  끝나지 못할 재시도는 사용자에게 504(무응답)로 보이므로, 차라리 1회차의 정직한 오류를 돌려준다. */
const RETRY_DEADLINE_MS = 15_000;

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

/** 일일 전역 캡 — 미설정/빈 값도 안전 기본값 400. 양의 env 값으로 더 낮추거나 명시 조정할 수 있고,
 *  잘못된 값은 `undefined`(설정 오류 → 503)다. 공개 데모에서 무제한 모드는 제공하지 않는다.
 *  ⚠️ Upstash가 없으면 서버 인스턴스별 best-effort이므로 durable 절대 상한이 아니다. */
function readDailyCap(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return DEFAULT_DAILY_CAP;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 && value <= 1_000_000 ? value : undefined;
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
type UpstashProbeCache = { url: string; reachable: boolean; expiresAt: number };
let upstashProbeCache: UpstashProbeCache | null = null;
const UPSTASH_PROBE_TTL_MS = 60_000;

/** 테스트/운영 점검용 — 인메모리 카운터를 비운다(프로세스 로컬). */
export function resetMemoryCounters(): void {
  memoryCounters.clear();
  upstashProbeCache = null;
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

/** 비밀을 응답에 싣지 않고 실제 Redis REST 경로까지 확인한다. 공개 GET의 남용으로 저장소 호출이
 *  늘지 않도록 warm instance마다 결과를 60초 캐시한다. */
async function canReachUpstash(url: string, token: string): Promise<boolean> {
  const now = Date.now();
  if (upstashProbeCache?.url === url && upstashProbeCache.expiresAt > now) return upstashProbeCache.reachable;
  let reachable = false;
  try {
    const res = await fetch(`${url.replace(/\/+$/, "")}/pipeline`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify([["PING"]]),
      cache: "no-store",
    });
    if (res.ok) {
      const data = (await res.json()) as Array<{ result?: unknown; error?: unknown }>;
      reachable = Array.isArray(data) && data[0]?.result === "PONG";
    }
  } catch {
    reachable = false;
  }
  upstashProbeCache = { url, reachable, expiresAt: now + UPSTASH_PROBE_TTL_MS };
  return reachable;
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

// ── 상류 호출(1회) ──────────────────────────────────────────────────────────────────────────────────

/** 상류 1회 호출의 결과. `retryable` 은 "같은 요청을 그대로 다시 보내면 달라질 수 있는가"다
 *  (혼잡/일시 장애 = true, 잘못된 모델명·인증 실패 = false — 재시도해 봐야 돈만 쓴다). */
type UpstreamResult =
  | { ok: true; text: string; truncated: boolean; completionTokens: number | null }
  | { ok: false; status: 502; error: string; retryable: boolean };

/** OpenRouter 가 **HTTP 200 본문에** 실어 보내는 오류 봉투를 읽는다(2026-08-08 실측 — 프로바이더 혼잡 시
 *  `{"error":{"code":429,…}}` 가 200 으로 온다). 오류가 아니면 null. */
function readUpstreamErrorEnvelope(data: unknown): { message: string; retryable: boolean } | null {
  const err = (data as { error?: unknown } | null)?.error;
  if (!err || typeof err !== "object") return null;
  const rec = err as { message?: unknown; code?: unknown };
  const codeNum = typeof rec.code === "number" ? rec.code : Number(rec.code);
  const code = Number.isFinite(codeNum) ? codeNum : null;
  const message = typeof rec.message === "string" && rec.message.trim() ? rec.message.slice(0, 200) : "알 수 없는 상류 오류";
  // 알 수 없는 코드는 **재시도 가능**으로 본다: 이 경로의 재시도는 토큰을 생성하지 않아 공짜고
  // (MAX_BILLED_ATTEMPTS 가 과금 상한을 따로 쥔다), 조용한 0건보다 한 번 더 물어보는 쪽이 낫다.
  const retryable = code === null || code === 429 || code === 408 || code >= 500;
  return { message: `OpenRouter ${code ?? "오류"}: ${message}`, retryable };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 상류를 **한 번** 부른다(모델·상한·zdr 전부 서버 고정). 재시도 판단은 호출부가 한다. */
async function callUpstream(
  apiKey: string,
  cfg: DemoConfig,
  systemPrompt: string,
  userPrompt: string,
): Promise<UpstreamResult> {
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
        model: cfg.model,
        max_tokens: cfg.maxTokens,
        temperature: 0.2, // 결정성 우선(구조화 Intent 추출)
        ...(cfg.effort ? { reasoning: { effort: cfg.effort } } : {}),
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
    return { ok: false, status: 502, error: `upstream fetch 실패: ${String(e).slice(0, 200)}`, retryable: true };
  }
  if (!orRes.ok) {
    const t = await orRes.text().catch(() => "");
    // 429(한도)·5xx(장애)는 일시적일 수 있다. 4xx(잘못된 요청/인증)는 다시 보내도 같다.
    const retryable = orRes.status === 429 || orRes.status === 408 || orRes.status >= 500;
    return { ok: false, status: 502, error: `OpenRouter ${orRes.status}: ${t.slice(0, 200)}`, retryable };
  }

  let data: {
    error?: unknown;
    choices?: Array<{ message?: { content?: string }; finish_reason?: string; native_finish_reason?: string }>;
    usage?: { completion_tokens?: number };
  };
  try {
    data = (await orRes.json()) as typeof data;
  } catch {
    return { ok: false, status: 502, error: "OpenRouter 응답을 JSON 으로 읽지 못했습니다.", retryable: true };
  }
  // ⚠️ 200 인데 본문이 오류 봉투인 경우 — 여기서 끊지 않으면 content 가 "" 가 되어 "모델이 편집을
  // 못 찾았다"로 둔갑한다(위 MAX_UPSTREAM_ATTEMPTS 주석의 실제 프로덕션 장애).
  const envelope = readUpstreamErrorEnvelope(data);
  if (envelope) return { ok: false, status: 502, error: envelope.message, retryable: envelope.retryable };
  const choice = data.choices?.[0];
  if (!choice) return { ok: false, status: 502, error: "OpenRouter 응답에 choices 가 없습니다.", retryable: true };

  return {
    ok: true,
    text: choice.message?.content ?? "",
    // 절단 판정: OpenRouter 표준 finish_reason("length") 또는 프로바이더 원본 값. 절단이면 JSON 이
    // 배열 중간에서 끊겨 파싱이 통째로 실패한다 — 그래서 "왜 0건인지"를 반드시 실어 보낸다.
    truncated: choice.finish_reason === "length" || choice.native_finish_reason === "length",
    completionTokens: data.usage?.completion_tokens ?? null,
  };
}

/** 모델 텍스트 → Intent 들. `arrayShaped` = 모델이 **JSON 배열 자체는** 냈는가(빈 배열 `[]` 포함).
 *  이 구분이 재시도 정책의 핵심이다: 모델이 의도적으로 `[]`(바꿀 것 없음)를 낸 것과, 아예 배열을
 *  못 낸 것(빈 본문·산문·코드펜스 깨짐)은 전혀 다른 사건이다. */
function parseIntents(text: string, truncated: boolean): { intents: Intent[]; drops: string[]; salvaged: number; arrayShaped: boolean } {
  const drops: string[] = [];
  const onDrop = (r: string) => drops.push(r);
  const parsed = extractJsonArray(text);
  const arrayShaped = Array.isArray(parsed);
  let intents = validateResponse(parsed, { onDrop });
  let salvaged = 0;
  if (intents.length === 0 && truncated) {
    // 절단 응답 구제: 이미 닫힌 Intent 만 회수하고 반쪽은 버린다(deny_unknown 규율 유지). 화이트리스트
    // 검증은 그대로 통과시킨다 — 구제 경로가 검증을 우회하지 않는다.
    intents = validateResponse(salvageJsonArrayItems(text), { onDrop });
    salvaged = intents.length;
  }
  return { intents, drops, salvaged, arrayShaped };
}

/** 모델이 응답은 했지만 **쓸 게 하나도 없을 때** 한 번 더 물어볼 가치가 있는가.
 *  - 배열 자체를 못 냄(빈 본문·산문) → 재시도(확률적 형식 이탈).
 *  - 배열은 냈는데 전부 드롭됨(없는 intent 이름 등) → 재시도.
 *  - 의도적으로 `[]` → **재시도 안 함**("바꿀 것 없음"은 정답이다 — 다시 물어도 같고 돈만 든다).
 *  - 절단 → 재시도 안 함(더 짧게 나눠 달라고 안내하는 게 맞다. 같은 요청은 또 잘린다). */
function worthRetrying(parsed: { intents: Intent[]; drops: string[]; arrayShaped: boolean }, truncated: boolean): boolean {
  if (truncated || parsed.intents.length > 0) return false;
  return !parsed.arrayShaped || parsed.drops.length > 0;
}

// ── 핸들러 ──────────────────────────────────────────────────────────────────────────────────────────

export interface DemoConfig {
  model: string;
  maxTokens: number;
  /** 하루 전체 상한. 기본 400회이며 공개 데모에서 무제한 값은 허용하지 않는다. */
  dailyCap: number;
  perIpCap: number;
  effort: string;
}

type ConfigRead = { ok: true; value: DemoConfig } | { ok: false; error: string };

export function readDemoConfig(): ConfigRead {
  const dailyCap = readDailyCap(process.env.DEMO_AI_DAILY_CAP);
  const perIpCap = positiveConfigInt(process.env.DEMO_AI_PER_IP_CAP, DEFAULT_PER_IP_CAP, 100_000);
  const maxTokens = positiveConfigInt(process.env.DEMO_AI_MAX_TOKENS, MAX_TOKENS_CEILING, MAX_TOKENS_CEILING);
  if (dailyCap === undefined || perIpCap === null || maxTokens === null || perIpCap > dailyCap) {
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
  // 모델·상한·effort 는 상류 호출부(callUpstream)가 cfg 째로 받는다 — 여기서는 캡만 꺼내 쓴다.
  const { dailyCap, perIpCap } = cfg.value;

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
  // IP 캡과 전역 캡을 항상 함께 센다. Upstash가 없으면 둘 다 인메모리 best-effort이므로 런칭 전
  // durable rate-limit 게이트를 별도로 닫아야 한다.
  const day = dayKey();
  const ipCount = await bumpCounter(`ah:demo:ip:${day}:${clientIp(req)}`);
  if (ipCount > perIpCap) {
    // 정직하게: 이건 브라우저가 아니라 **IP(네트워크) 단위** 한도다 — 같은 공유망을 쓰는 다른 사람과
    // 몫을 나눠 쓰고, 시크릿 창이나 다른 브라우저로 바꿔도 리셋되지 않는다. 리셋 시점(UTC 자정 =
    // 한국시간 오전 9시)도 "내일"로 얼버무리지 않고 그대로 적는다.
    return jsonRes(
      {
        error:
          `오늘 이 네트워크(IP)에서 쓸 수 있는 데모 AI 편집 횟수(${perIpCap}회)를 다 썼습니다. ` +
          "한국시간 매일 오전 9시(UTC 0시)에 초기화되며, 레포를 클론해 로컬(BYOK)에서 실행하면 한도 없이 쓸 수 있습니다.",
      },
      429,
    );
  }
  const dayCount = await bumpCounter(`ah:demo:all:${day}`);
  if (dayCount > dailyCap) {
    return jsonRes(
      { error: "오늘 데모 전체 사용 한도를 다 썼습니다(예산 보호). 한국시간 매일 오전 9시(UTC 0시)에 다시 열립니다." },
      429,
    );
  }

  // ── 상류 호출 + **자동 재시도**(혼잡 최대 3회 · 과금 최대 2회) ─────────────────────────────────
  // 재시도가 도는 두 경우(둘 다 "같은 요청을 다시 보내면 달라질 수 있다"):
  //   ① 상류가 일시 실패(200-본문-오류 봉투 · 429/5xx · 네트워크) — 프로덕션 장애의 실제 원인.
  //      토큰이 생성되지 않아 **공짜**라 넉넉히 재시도한다(MAX_UPSTREAM_ATTEMPTS).
  //   ② 모델이 응답은 했으나 배열을 아예 못 냈거나 전부 드롭됨(확률적 형식 이탈).
  //      이건 **과금된** 호출이므로 딱 한 번만 더 묻는다(MAX_BILLED_ATTEMPTS).
  // IP 쿼터는 위에서 이미 1회만 증가했다 — 재시도는 사용자 몫을 두 번 먹지 않는다.
  const startedAt = Date.now();
  const cfgForCall: DemoConfig = cfg.value;
  let attempts = 0;
  let billed = 0; // 모델이 실제로 답을 생성한(=토큰이 나간) 호출 수
  let up: UpstreamResult;
  let parsed = { intents: [] as Intent[], drops: [] as string[], salvaged: 0, arrayShaped: false };
  let retryReason: "upstream" | "empty" | null = null;
  for (;;) {
    attempts += 1;
    up = await callUpstream(apiKey, cfgForCall, systemPrompt, userPrompt);
    // 남은 시간이 없으면 시작하지 않는다 — 끝내지 못할 재시도는 사용자에게 504(무응답)다.
    const timeLeft = Date.now() - startedAt < RETRY_DEADLINE_MS && attempts < MAX_UPSTREAM_ATTEMPTS;
    if (up.ok) {
      billed += 1;
      parsed = parseIntents(up.text, up.truncated);
      if (!timeLeft || billed >= MAX_BILLED_ATTEMPTS || !worthRetrying(parsed, up.truncated)) break;
      retryReason = "empty";
    } else {
      if (!timeLeft || !up.retryable) break;
      retryReason = "upstream";
    }
    console.warn(JSON.stringify({ event: "demo_retry", why: retryReason, attempt: attempts, detail: up.ok ? null : up.error }));
    await sleep(retryDelayMs() * attempts); // 1s → 2s → 3s (같은 혼잡 창에 다시 걸리지 않게)
  }

  if (!up.ok) {
    // 침묵 금지: 상류 장애를 "편집을 찾지 못했습니다"로 둔갑시키지 않는다(그 둔갑이 이 버그였다).
    console.warn(JSON.stringify({ event: "demo_upstream_error", attempts, retryable: up.retryable, detail: up.error }));
    const hint = up.retryable
      ? " (자동 재시도도 실패했습니다 — 모델 제공자가 일시적으로 혼잡합니다. 잠시 후 다시 시도해 주세요.)"
      : "";
    return jsonRes({ error: `${up.error}${hint}`, reason: "upstream_error" as EditFailureReason }, up.status);
  }

  const { text, truncated } = up;
  const { intents, drops, salvaged, arrayShaped } = parsed;
  // 관측(요청 내용은 로그하지 않는다 — 카운트/사유만).
  if (truncated || intents.length === 0) {
    console.warn(
      JSON.stringify({
        event: "demo_empty_or_truncated",
        truncated,
        attempts,
        completion_tokens: up.completionTokens,
        content_len: text.length,
        array_shaped: arrayShaped,
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
    // 0건의 **이유를 갈라서** 말한다(같은 문구로 뭉뚱그리면 사용자는 자기 지시를 의심한다):
    //  · drops>0        → 모델이 없는 intent 이름을 냈다(서버가 드롭).
    //  · 배열 자체 없음  → 형식 이탈/빈 응답 — 재시도까지 했는데도 실패했음을 밝힌다.
    //  · 온전한 `[]`     → 모델이 "바꿀 것 없음"이라고 답한 것(진짜 no-op).
    payload.reason = "no_valid_intents";
    payload.message = drops.length
      ? "모델이 지원하지 않는 형식으로 답해 적용할 편집을 만들지 못했습니다. 다시 시도하거나 지시를 더 구체적으로 적어 주세요."
      : !arrayShaped
        ? `모델이 형식에 맞는 응답을 내지 못했습니다(자동 재시도 ${attempts}회 포함). 잠시 후 다시 시도해 주세요.`
        : "이 요청에서 적용할 편집을 찾지 못했습니다. 편집할 표/문단을 선택하고 지시를 더 구체적으로 적어 주세요.";
  }
  return jsonRes(payload, 200);
}

/** 데모 모드의 GET(프로브). 키가 없으면 `mode:"static"` — 클라가 "AI 없음"으로 정직하게 표시한다
 *  (mock 이 아니다: mock 은 결정적 가짜 편집이 **동작하는** 상태다). */
export async function demoProbe(): Promise<Response> {
  const configured = Boolean(process.env.OPENROUTER_API_KEY?.trim());
  const limits = readDemoConfig();
  const upstashUrl = process.env.UPSTASH_REDIS_REST_URL?.trim() ?? "";
  const upstashToken = process.env.UPSTASH_REDIS_REST_TOKEN?.trim() ?? "";
  const upstashConfigured = Boolean(upstashUrl && upstashToken);
  const upstashReachable = upstashConfigured && (await canReachUpstash(upstashUrl, upstashToken));
  return jsonRes(
    {
      mode: configured ? "live" : "static",
      provider: "demo",
      model: configured ? demoModel() : null,
      configured,
      rate_limit: {
        store: upstashReachable ? "upstash" : "memory",
        durable: upstashReachable,
        store_configured: upstashConfigured,
        daily_cap: limits.ok ? limits.value.dailyCap : null,
        per_ip_cap: limits.ok ? limits.value.perIpCap : null,
        configuration_valid: limits.ok && (!upstashConfigured || upstashReachable),
      },
      ...(configured ? {} : { message: UNCONFIGURED_MESSAGE }),
    },
    200,
  );
}
