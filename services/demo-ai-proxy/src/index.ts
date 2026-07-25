// 오토한글 정적 데모용 AI 프록시 (Cloudflare Worker).
//
// 왜 있나: 정적 데모(GitHub Pages)는 서버가 없어 OpenRouter 키를 담을 데가 없다. 클라이언트에 키를
// 넣으면 공개돼 긁혀 나간다. 이 워커가 유일하게 키를 쥐고, ① 모델·max_tokens를 서버에서 고정하고
// ② IP별 + 전체 일일 한도로 하루 비용을 강제하고 ③ CORS를 데모 도메인으로 잠근다.
//
// 남용 저항: 클라이언트는 {instruction, docContext, anchors}만 보낸다. 시스템/유저 프롬프트는 워커가
// @auto-hwp/ai-protocol로 조립하므로(서버가 프롬프트를 통제) 출력은 우리 JSON Intent 형식으로 제한되고,
// 프롬프트 계약이 앱과 드리프트하지 않는다(wrangler가 ai-protocol을 번들).
//
// 비용 상한: GLM 5.2($0.76/$2.42 per M) + 입력 위주 작업 → 요청당 ~$0.0038. DAILY_CAP를 예산에서
// 역산해 설정한다(예: $5 / $0.0038 ≈ 1315 → 여유 두고 1200). PER_IP_CAP로 한 명이 독식 못 하게.
// (Gemini Flash-Lite가 더 싸지만 Cloudflare Worker 출구 리전을 구글이 지역 차단 — DEFAULT_MODEL 주석 참조.)

import { buildSystemPrompt, buildUserMessage, validateResponse, type Anchor, type Intent } from "@auto-hwp/ai-protocol";

interface Env {
  OPENROUTER_API_KEY: string; // wrangler secret
  RATELIMIT: KVNamespace; // 일일 카운터
  ALLOWED_ORIGIN: string; // 예: https://kwakseongjae.github.io (여러 개면 콤마)
  MODEL?: string; // 기본 z-ai/glm-5.2 (DEFAULT_MODEL)
  DAILY_CAP?: string; // 전체 일일 요청 상한(비용 상한의 실질 강제)
  PER_IP_CAP?: string; // IP별 일일 요청 상한
  MAX_TOKENS?: string; // 출력 상한(Intent JSON은 작다)
}

interface EditBody {
  instruction?: unknown;
  docContext?: unknown;
  anchors?: unknown;
}

// 기본 모델: GLM 5.2. Gemini Flash-Lite가 더 싸지만 Cloudflare Worker 출구 리전을 구글이 지역
// 차단("not available in your region")해 GLM으로 전환. 모델은 wrangler.toml MODEL로 오버라이드.
const DEFAULT_MODEL = "z-ai/glm-5.2";

function corsHeaders(origin: string | null, allowed: string[]): Record<string, string> {
  // 허용 목록에 있으면 그 오리진을 반사, 아니면 첫 허용 오리진(프리플라이트에서 브라우저가 차단).
  const ok = origin && allowed.includes(origin);
  return {
    "Access-Control-Allow-Origin": ok ? origin : allowed[0] ?? "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(body: unknown, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...cors } });
}

/** UTC 날짜 키 — 매일 0시(UTC)에 카운터가 자연 리셋되도록 키에 날짜를 박는다(별도 청소 불필요, TTL 25h). */
function dayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

async function bump(kv: KVNamespace, key: string, cap: number): Promise<{ ok: boolean; count: number }> {
  const cur = parseInt((await kv.get(key)) ?? "0", 10) || 0;
  if (cur >= cap) return { ok: false, count: cur };
  // TTL 25시간: 하루 지나면 자동 소멸. (동시성 경합은 데모 규모에서 무시 가능 — 정확한 원자성 불필요.)
  await kv.put(key, String(cur + 1), { expirationTtl: 90000 });
  return { ok: true, count: cur + 1 };
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const allowed = (env.ALLOWED_ORIGIN || "").split(",").map((s) => s.trim()).filter(Boolean);
    const origin = req.headers.get("Origin");
    const cors = corsHeaders(origin, allowed);

    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (req.method !== "POST") return json({ error: "POST only" }, 405, cors);
    if (allowed.length && (!origin || !allowed.includes(origin))) return json({ error: "origin not allowed" }, 403, cors);

    // ── 일일 한도(비용 상한의 실질 강제) ────────────────────────────────────────────────────────
    const day = dayKey();
    const dailyCap = parseInt(env.DAILY_CAP ?? "2000", 10);
    const perIpCap = parseInt(env.PER_IP_CAP ?? "20", 10);
    const ip = req.headers.get("CF-Connecting-IP") ?? "unknown";

    const ipHit = await bump(env.RATELIMIT, `ip:${day}:${ip}`, perIpCap);
    if (!ipHit.ok) return json({ error: "오늘 이 브라우저의 데모 사용 한도를 다 썼습니다. 내일 다시 시도하거나, 레포를 클론해 로컬(BYOK)에서 무제한으로 쓰세요." }, 429, cors);
    const dayHit = await bump(env.RATELIMIT, `all:${day}`, dailyCap);
    if (!dayHit.ok) return json({ error: "오늘 데모 전체 사용 한도를 다 썼습니다(예산 보호). 내일 다시 열립니다." }, 429, cors);

    // ── 요청 파싱 ────────────────────────────────────────────────────────────────────────────────
    let body: EditBody;
    try {
      body = (await req.json()) as EditBody;
    } catch {
      return json({ error: "invalid JSON" }, 400, cors);
    }
    const instruction = typeof body.instruction === "string" ? body.instruction.slice(0, 2000) : "";
    const docContext = typeof body.docContext === "string" ? body.docContext.slice(0, 20000) : "";
    const anchors = Array.isArray(body.anchors) ? (body.anchors.slice(0, 20) as Anchor[]) : [];
    if (!instruction.trim()) return json({ error: "instruction 이 비어 있습니다" }, 400, cors);

    // ── 프롬프트 조립(서버 통제 — 앱과 같은 ai-protocol) ────────────────────────────────────────
    const messages = [
      { role: "system", content: buildSystemPrompt() },
      { role: "user", content: buildUserMessage({ instruction, anchors, docContext, attachments: [] }) },
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
          max_tokens: parseInt(env.MAX_TOKENS ?? "1024", 10),
          temperature: 0.2, // 결정성 우선(구조화 Intent 추출)
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
