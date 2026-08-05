// 오토한글 정적 데모용 AI 프록시 (Cloudflare Worker).
//
// 왜 있나: 정적 데모(GitHub Pages)는 서버가 없어 OpenRouter 키를 담을 데가 없다. 클라이언트에 키를
// 넣으면 공개돼 긁혀 나간다. 이 워커가 유일하게 키를 쥐고, ① 모델·max_tokens를 서버에서 고정하고
// ② IP별 + 전체 일일 한도로 하루 비용을 방어하고 ③ CORS를 데모 도메인으로 잠근다.
//
// 남용 저항: 클라이언트는 {instruction, docContext, anchors}만 보낸다. 시스템/유저 프롬프트는 워커가
// @auto-hwp/ai-protocol로 조립하므로(서버가 프롬프트를 통제) 출력은 우리 JSON Intent 형식으로 제한되고,
// 프롬프트 계약이 앱과 드리프트하지 않는다(wrangler가 ai-protocol을 번들).
//
// 비용 방어선: GPT-5.6 Luna($0.10/M 입력 · $0.60/M 출력). 요청당 상한을 MAX_TOKENS·입력 상한에서
// 역산해 DAILY_CAP와 곱한 값이 $5를 넘지 않게 유지한다 — 실제 수치는 MAX_TOKENS_CEILING 주석 참조.
// PER_IP_CAP로 한 명이 독식 못 하게. 모델을 바꾸면 캡을 새 단가로 반드시 재계산한다.
// (Gemini Flash-Lite가 더 싸지만 Cloudflare Worker 출구 리전을 구글이 지역 차단 — DEFAULT_MODEL 주석 참조.)

import {
  buildSystemPrompt,
  buildUserMessage,
  salvageJsonArrayItems,
  validateRequest,
  validateResponse,
  type EditFailureReason,
  type Intent,
} from "@auto-hwp/ai-protocol";

interface Env {
  OPENROUTER_API_KEY: string; // wrangler secret
  RATELIMIT: KVNamespace; // 일일 카운터
  ALLOWED_ORIGIN: string; // 예: https://kwakseongjae.github.io (여러 개면 콤마)
  MODEL?: string; // 기본 openai/gpt-5.6-luna (DEFAULT_MODEL)
  DAILY_CAP?: string; // 전체 일일 요청 방어선(KV eventual consistency라 절대 상한은 아님)
  PER_IP_CAP?: string; // IP별 일일 요청 상한
  MAX_TOKENS?: string; // 출력 상한(추론 토큰 포함 — MAX_TOKENS_CEILING 참조)
  REASONING_EFFORT?: string; // "minimal"|"low"|"medium"|"high" — 빈 문자열이면 상류에 안 보냄(롤백 스위치)
}

// 기본 모델: GPT-5.6 Luna(base — luna-pro 아님). 이전 GLM 5.2 대비 요청당 비용 약 1/7이라 같은
// 예산에서 DAILY_CAP를 올릴 수 있다. Gemini Flash-Lite가 더 싸지만 Cloudflare Worker 출구 리전을
// 구글이 지역 차단("not available in your region")해 구글 계열은 제외. 모델은 wrangler.toml MODEL로
// 오버라이드하며, 바꾸면 거기 DAILY_CAP도 새 단가로 재계산한다.
const DEFAULT_MODEL = "openai/gpt-5.6-luna";
const MAX_REQUEST_BYTES = 128 * 1024;
const MAX_UPSTREAM_TEXT_BYTES = 128 * 1024;

/** 출력 토큰 상한(기본값 = 허용 최대값). **이 값을 바꾸면 아래 예산 계산도 같이 고쳐라.**
 *
 *  왜 1024 → 2048 (이슈 1-(1) 실사용 실패):
 *  gpt-5.6-luna는 추론(reasoning) 토큰이 `max_tokens`에 함께 계산된다. 8쪽 샘플 "일반현황" 표에
 *  다중 필드를 채우라는 실요청(창업아이템명+산출물+팀 3행)은 SetTableCell 약 10건 ≒ 출력 JSON
 *  400~500토큰인데, 추론까지 1024 안에서 끝나지 않아 `finish_reason: "length"`로 잘렸고 잘린
 *  JSON은 파싱 실패 → **전량 드롭(제안 0건)**. 라이브 워커 대조 실측(2026-08-05):
 *    1필드 → 1건 OK(6.4s) · 2필드 → 2건 OK(7.8s) · 5필드(팀 3행) → 0건(12.5s)
 *    같은 5필드를 컨텍스트 758자로 줄여도 0건(10.3s) — 입력이 아니라 **출력 예산**이 벽이었다.
 *
 *  예산 재계산(단가 $0.10/M 입력 · $0.60/M 출력, DAILY_CAP 2000 유지). 토큰 환산은 자수 × 계수로
 *  보수적으로 잡는다(영문 0.25 tok/자 · 한글 0.7 · 혼합 0.6 · 구조 JSON 0.4):
 *    출력  2,048 tok × $0.60/M                                        = $0.001229
 *    입력  시스템 13,022자(영문)          → 3,256 tok
 *          instruction  1,500자(한글)     → 1,050 tok
 *          docContext   8,000자(혼합)     → 4,800 tok
 *          anchors JSON 8,192자(구조)     → 3,277 tok
 *          펜스/고정 문구                 →   100 tok
 *          합계 12,483 tok × $0.10/M                                  = $0.001248
 *    요청당 최악 ≈ $0.00248 → × DAILY_CAP 2000 = **$4.95/일 (< $5)** ✓
 *  실측 시나리오(docContext 3,259자 · 입력 ≈ 4,800 tok)는 요청당 ≈ $0.0017이고, 대부분의 요청은
 *  출력 상한을 다 쓰지 않는다(2필드 요청은 수백 토큰) → 실제 일예산은 $1~2 수준.
 *  ⚠ 위 최악 계산은 DEMO_REQUEST_LIMITS의 입력 상한(아래)에 의존한다 — 어느 쪽을 바꾸든 같이 고쳐라. */
const MAX_TOKENS_CEILING = 2048;

/** 추론 노력 기본값. 이 작업은 "구조화 추출"이라 깊은 추론이 필요 없고, 추론 토큰이 출력 예산을
 *  먹어 절단을 유발한 장본인이다(위 참조) → 기본 "low". OpenRouter가 프로바이더별로 정규화하며,
 *  wrangler.toml의 REASONING_EFFORT를 빈 문자열로 두면 필드 자체를 안 보낸다(롤백 스위치). */
const DEFAULT_REASONING_EFFORT = "low";
const REASONING_EFFORTS = new Set(["minimal", "low", "medium", "high"]);

/** 데모 입력 상한. 위 예산 계산의 입력 항(≈12.5k tok)이 이 값들에서 나온다 — **함께 고쳐라.**
 *  1-(1)에서 조인 것은 두 개뿐이고 둘 다 실사용 무회귀다:
 *   - maxDocContext 20000 → 8000: 클라의 `buildDocContext` 기본 maxLen이 **8000자**라 더 긴 값은
 *     애초에 만들어지지 않는다(실측 8쪽 샘플 요청 = 3,259자). 서버가 자르지 않고 거절하므로 그리드가
 *     조용히 잘려 나가는 일도 없다.
 *   - maxInstruction 2000 → 1500: 채팅 한 턴 기준으로도 여유(20명 명단 지시문이 ~600자).
 *  anchor text 2000 · anchors JSON 8192는 **그대로** 둔다 — 긴 문단 앵커가 새로 400을 맞는 회귀를
 *  만들지 않기 위해서다(예산은 위 계수로 이미 닫힌다). */
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

function corsHeaders(origin: string | null, allowed: string[]): Record<string, string> {
  // 허용 목록에 있을 때만 오리진을 반사한다. 설정 누락/불일치에는 ACAO 자체를 내지 않는다.
  const ok = origin && allowed.includes(origin);
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  if (ok) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

function json(body: unknown, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...cors } });
}

/** UTC 날짜 키 — 매일 0시(UTC)에 카운터가 자연 리셋되도록 키에 날짜를 박는다(별도 청소 불필요, TTL 25h). */
function dayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function positiveConfigInt(raw: string | undefined, fallback: number, max: number): number | null {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 && value <= max ? value : null;
}

type BodyRead = { ok: true; value: unknown } | { ok: false; status: 400 | 413 | 415; error: string };

/** Read an untrusted request body with a hard byte ceiling, including chunked bodies without a
 *  Content-Length header. `Request.json()` alone would allocate an attacker-sized body first. */
async function readJsonLimited(req: Request, maxBytes: number): Promise<BodyRead> {
  const contentType = req.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    return { ok: false, status: 415, error: "content-type must be application/json" };
  }

  const declaredRaw = req.headers.get("content-length");
  if (declaredRaw !== null) {
    const declared = Number(declaredRaw);
    if (!Number.isSafeInteger(declared) || declared < 0) {
      return { ok: false, status: 400, error: "invalid content-length" };
    }
    if (declared > maxBytes) {
      return { ok: false, status: 413, error: `request body too large (>${maxBytes} bytes)` };
    }
  }

  if (!req.body) return { ok: false, status: 400, error: "invalid JSON" };
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
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

async function bump(kv: KVNamespace, key: string, cap: number): Promise<{ ok: boolean; count: number }> {
  const cur = parseInt((await kv.get(key)) ?? "0", 10) || 0;
  if (cur >= cap) return { ok: false, count: cur };
  // TTL 25시간: 하루 지나면 자동 소멸. KV read-modify-write는 비원자적이므로 이 값은 방어선이며,
  // 절대 상한이 필요해지는 운영 단계에서는 Durable Object transaction으로 옮긴다.
  await kv.put(key, String(cur + 1), { expirationTtl: 90000 });
  return { ok: true, count: cur + 1 };
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const allowed = (env.ALLOWED_ORIGIN || "").split(",").map((s) => s.trim()).filter(Boolean);
    const origin = req.headers.get("Origin");
    const cors = corsHeaders(origin, allowed);

    if (allowed.length === 0) return json({ error: "proxy CORS is not configured" }, 503, {});
    if (!origin || !allowed.includes(origin)) return json({ error: "origin not allowed" }, 403, cors);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (req.method !== "POST") return json({ error: "POST only" }, 405, cors);
    if (!env.OPENROUTER_API_KEY?.trim()) return json({ error: "AI provider is not configured" }, 503, cors);

    const dailyCap = positiveConfigInt(env.DAILY_CAP, 1200, 100_000);
    const perIpCap = positiveConfigInt(env.PER_IP_CAP, 20, 10_000);
    const maxTokens = positiveConfigInt(env.MAX_TOKENS, MAX_TOKENS_CEILING, MAX_TOKENS_CEILING);
    if (dailyCap === null || perIpCap === null || maxTokens === null || perIpCap > dailyCap) {
      return json({ error: "proxy limits are misconfigured" }, 503, cors);
    }
    // 설정 오타로 예산 계산 밖의 추론 노력이 나가지 않게 화이트리스트로 잠근다(빈 값 = 미전송).
    const effortRaw = (env.REASONING_EFFORT ?? DEFAULT_REASONING_EFFORT).trim();
    if (effortRaw && !REASONING_EFFORTS.has(effortRaw)) {
      return json({ error: "proxy limits are misconfigured" }, 503, cors);
    }

    // ── 요청 파싱·검증 ──────────────────────────────────────────────────────────────────────────
    // 잘못된 요청이 유효 사용자의 일일 쿼터를 태우지 않도록 비용 카운터보다 먼저 검증한다.
    const body = await readJsonLimited(req, MAX_REQUEST_BYTES);
    if (!body.ok) return json({ error: body.error }, body.status, cors);
    const checked = validateRequest(body.value, DEMO_REQUEST_LIMITS);
    if (!checked.ok) return json({ error: checked.error }, 400, cors);
    const { instruction, docContext, anchors } = checked.value;
    if (!instruction.trim()) return json({ error: "instruction 이 비어 있습니다" }, 400, cors);
    const systemPrompt = buildSystemPrompt();
    const userPrompt = buildUserMessage({ instruction, anchors, docContext, attachments: [] });
    const upstreamBytes = new TextEncoder().encode(systemPrompt).byteLength + new TextEncoder().encode(userPrompt).byteLength;
    if (upstreamBytes > MAX_UPSTREAM_TEXT_BYTES) {
      return json({ error: `AI context too large (>${MAX_UPSTREAM_TEXT_BYTES} bytes)` }, 413, cors);
    }

    // ── 일일 한도(비용 상한의 방어선) ───────────────────────────────────────────────────────────
    // Workers KV는 eventual consistency라 동시 요청에 대한 절대 상한은 아니다. 원자적 상한은
    // Durable Object 카운터로 승격한다(고도화 이슈에서 추적). 여기서는 정상 요청만 카운트한다.
    const day = dayKey();
    const ip = req.headers.get("CF-Connecting-IP") ?? "unknown";

    const ipHit = await bump(env.RATELIMIT, `ip:${day}:${ip}`, perIpCap);
    if (!ipHit.ok) return json({ error: "오늘 이 브라우저의 데모 사용 한도를 다 썼습니다. 내일 다시 시도하거나, 레포를 클론해 로컬(BYOK)에서 무제한으로 쓰세요." }, 429, cors);
    const dayHit = await bump(env.RATELIMIT, `all:${day}`, dailyCap);
    if (!dayHit.ok) return json({ error: "오늘 데모 전체 사용 한도를 다 썼습니다(예산 보호). 내일 다시 열립니다." }, 429, cors);

    // ── 프롬프트 조립(서버 통제 — 앱과 같은 ai-protocol) ────────────────────────────────────────
    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ];
    const model = env.MODEL || DEFAULT_MODEL;

    let orRes: Response;
    try {
      orRes = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://github.com/kwakseongjae/auto-hwp",
          "X-Title": "auto-hwp demo",
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          temperature: 0.2, // 결정성 우선(구조화 Intent 추출)
          // 추론 토큰은 max_tokens에 함께 계산된다 — 이 작업은 구조화 추출이라 깊은 추론이 필요 없고,
          // 그냥 두면 추론이 출력 예산을 먹어 다중 Intent JSON이 잘렸다(MAX_TOKENS_CEILING 주석).
          ...(effortRaw ? { reasoning: { effort: effortRaw } } : {}),
          // 문서 프로필/본문 발췌/표에는 PII가 있을 수 있다. ZDR endpoint가 없는 모델/route는
          // OpenRouter가 오류로 거부하게 해 조용한 개인정보 정책 완화를 막는다(079 계약).
          provider: { zdr: true },
          messages,
        }),
      });
    } catch (e) {
      return json({ error: `upstream fetch 실패: ${String(e).slice(0, 200)}`, reason: "upstream_error" }, 502, cors);
    }
    if (!orRes.ok) {
      const t = await orRes.text().catch(() => "");
      return json({ error: `OpenRouter ${orRes.status}: ${t.slice(0, 200)}`, reason: "upstream_error" }, 502, cors);
    }
    const data = (await orRes.json()) as {
      choices?: Array<{ message?: { content?: string }; finish_reason?: string; native_finish_reason?: string }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const choice = data.choices?.[0];
    const text = choice?.message?.content ?? "";
    // 절단 판정: OpenRouter 표준 finish_reason("length") 또는 프로바이더 원본 값. 절단이면 JSON이
    // 배열 중간에서 끊겨 있어 아래 파싱이 통째로 실패한다 — 그래서 "왜 0건인지"를 반드시 실어 보낸다.
    const truncated = choice?.finish_reason === "length" || choice?.native_finish_reason === "length";
    const drops: string[] = [];
    const onDrop = (r: string) => drops.push(r);
    // 앱과 동일 검증(화이트리스트 19종 + 구조). 통과한 Intent만 반환 — 클라는 그대로 적용한다.
    let intents: Intent[] = validateResponse(text, { onDrop });
    let salvaged = 0;
    if (intents.length === 0 && truncated) {
      // 절단 응답 구제: 이미 닫힌 Intent만 회수하고 반쪽은 버린다(deny_unknown 규율 유지). 화이트리스트
      // 검증은 그대로 통과시킨다 — 구제 경로가 검증을 우회하지 않는다.
      intents = validateResponse(salvageJsonArrayItems(text), { onDrop });
      salvaged = intents.length;
    }
    // 관측(요청 내용은 로그하지 않는다 — 카운트/사유만). wrangler tail로 절단 여부를 바로 본다.
    if (truncated || intents.length === 0) {
      console.warn(
        JSON.stringify({
          event: "empty_or_truncated",
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
    const payload: { intents: Intent[]; reason?: EditFailureReason; message?: string } = { intents };
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
    return json(payload, 200, cors);
  },
};
