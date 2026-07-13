import { DEFAULT_ALLOWED_INTENTS } from "./prompt.js";
import { DEFAULT_LIMITS, type Anchor, type EditRequest, type Intent, type RequestLimits } from "./types.js";

/// Request + response validation (SDK-LAYERS: "validateResponse(json) — 화이트리스트+스키마 검증"). PROMOTED
/// verbatim from apps/hwp-lab's route.ts (`validate`, `extractJsonArray`, `whitelist`) so the server proxy
/// and any host enforce the SAME contract. Pure + isomorphic — no fetch, no I/O, no key. Logging is a
/// caller concern: pass `onDrop` to observe rejected candidates (the reference proxy passes console.warn).

/** The parsed, length-checked request, or a human-readable error. Mirrors the reference proxy's guard. */
export type RequestCheck = { ok: true; value: EditRequest } | { ok: false; error: string };

/** Validate an untrusted request body: `instruction` (string, ≤ cap), `anchors` (array, ≤ cap), and a
 *  lenient `docContext` (coerced to "" when absent, ≤ cap). Returns the typed EditRequest or an error. */
export function validateRequest(body: unknown, limits: RequestLimits = DEFAULT_LIMITS): RequestCheck {
  if (!body || typeof body !== "object") return { ok: false, error: "요청 본문이 JSON 오브젝트가 아닙니다." };
  const b = body as Record<string, unknown>;
  const instruction = b.instruction;
  const anchors = b.anchors;
  const docContext = b.docContext;
  if (typeof instruction !== "string") return { ok: false, error: "instruction(string)이 필요합니다." };
  if (instruction.length > limits.maxInstruction) return { ok: false, error: `instruction이 너무 깁니다(>${limits.maxInstruction}).` };
  if (!Array.isArray(anchors)) return { ok: false, error: "anchors(배열)가 필요합니다." };
  if (anchors.length > limits.maxAnchors) return { ok: false, error: `anchors가 너무 많습니다(>${limits.maxAnchors}).` };
  // docContext 는 프록시 계약상 string. 없으면 빈 문자열로 관대 처리.
  const ctx = typeof docContext === "string" ? docContext : "";
  if (ctx.length > limits.maxDocContext) return { ok: false, error: `docContext가 너무 깁니다(>${limits.maxDocContext}).` };
  return { ok: true, value: { instruction, anchors: anchors as Anchor[], docContext: ctx } };
}

/** Robustly extract the first JSON array from LLM text (tolerates prose/markdown around it). Returns the
 *  parsed value (usually an array) or null when nothing parseable is found. */
export function extractJsonArray(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    /* prose가 섞였을 수 있음 → 대괄호 범위 추출 */
  }
  const start = trimmed.indexOf("[");
  const end = trimmed.lastIndexOf("]");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      /* 파싱 실패 */
    }
  }
  return null;
}

/** Options for `validateResponse`. `allowedIntents` defaults to the frozen whitelist; `onDrop` observes
 *  each rejected candidate (the reference proxy passes `console.warn`). */
export interface ValidateResponseOptions {
  allowedIntents?: readonly string[];
  onDrop?: (reason: string) => void;
}

/** Whitelist + structure-check candidate Intents. Accepts either an already-parsed array/value OR raw LLM
 *  text (which it runs through `extractJsonArray` first). Keeps only well-formed, internally-tagged
 *  objects whose `intent` is in the allowed set; drops (and reports via `onDrop`) everything else. */
export function validateResponse(input: unknown, opts: ValidateResponseOptions = {}): Intent[] {
  const allowed = new Set(opts.allowedIntents ?? DEFAULT_ALLOWED_INTENTS);
  const candidates = typeof input === "string" ? extractJsonArray(input) : input;
  if (!Array.isArray(candidates)) return [];
  const out: Intent[] = [];
  for (const c of candidates) {
    if (c && typeof c === "object" && typeof (c as { intent?: unknown }).intent === "string") {
      const intent = (c as { intent: string }).intent;
      if (allowed.has(intent)) {
        out.push(c as Intent);
      } else {
        opts.onDrop?.(`dropped non-whitelisted intent: ${intent}`);
      }
    } else {
      opts.onDrop?.("dropped malformed intent candidate");
    }
  }
  return out;
}
