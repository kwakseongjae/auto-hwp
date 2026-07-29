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
// 비용 방어선: GLM 5.2($0.76/$2.42 per M) + 입력 위주 작업 → 요청당 ~$0.0038. DAILY_CAP를 예산에서
// 역산해 설정한다(예: $5 / $0.0038 ≈ 1315 → 여유 두고 1200). PER_IP_CAP로 한 명이 독식 못 하게.
// (Gemini Flash-Lite가 더 싸지만 Cloudflare Worker 출구 리전을 구글이 지역 차단 — DEFAULT_MODEL 주석 참조.)

import { buildSystemPrompt, buildUserMessage, validateRequest, validateResponse, type Intent } from "@auto-hwp/ai-protocol";

interface Env {
  OPENROUTER_API_KEY: string; // wrangler secret
  RATELIMIT: KVNamespace; // 일일 카운터
  ALLOWED_ORIGIN: string; // 예: https://kwakseongjae.github.io (여러 개면 콤마)
  MODEL?: string; // 기본 z-ai/glm-5.2 (DEFAULT_MODEL)
  DAILY_CAP?: string; // 전체 일일 요청 방어선(KV eventual consistency라 절대 상한은 아님)
  PER_IP_CAP?: string; // IP별 일일 요청 상한
  MAX_TOKENS?: string; // 출력 상한(Intent JSON은 작다)
}

// 기본 모델: GLM 5.2. Gemini Flash-Lite가 더 싸지만 Cloudflare Worker 출구 리전을 구글이 지역
// 차단("not available in your region")해 GLM으로 전환. 모델은 wrangler.toml MODEL로 오버라이드.
const DEFAULT_MODEL = "z-ai/glm-5.2";
const MAX_REQUEST_BYTES = 128 * 1024;
const MAX_UPSTREAM_TEXT_BYTES = 128 * 1024;
const DEMO_REQUEST_LIMITS = {
  maxInstruction: 2000,
  maxDocContext: 20000,
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
    const maxTokens = positiveConfigInt(env.MAX_TOKENS, 1024, 1024);
    if (dailyCap === null || perIpCap === null || maxTokens === null || perIpCap > dailyCap) {
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
          // 문서 프로필/본문 발췌/표에는 PII가 있을 수 있다. ZDR endpoint가 없는 모델/route는
          // OpenRouter가 오류로 거부하게 해 조용한 개인정보 정책 완화를 막는다(079 계약).
          provider: { zdr: true },
          messages,
        }),
      });
    } catch (e) {
      return json({ error: `upstream fetch 실패: ${String(e).slice(0, 200)}` }, 502, cors);
    }
    if (!orRes.ok) {
      const t = await orRes.text().catch(() => "");
      return json({ error: `OpenRouter ${orRes.status}: ${t.slice(0, 200)}` }, 502, cors);
    }
    const data = (await orRes.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = data.choices?.[0]?.message?.content ?? "";
    // 앱과 동일 검증(화이트리스트 19종 + 구조). 통과한 Intent만 반환 — 클라는 그대로 적용한다.
    const intents: Intent[] = validateResponse(text, {});
    return json({ intents }, 200, cors);
  },
};
