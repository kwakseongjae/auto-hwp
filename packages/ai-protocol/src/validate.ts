import { DEFAULT_ALLOWED_INTENTS } from "./prompt.js";
import { DEFAULT_LIMITS, type Anchor, type Attachment, type Citation, type EditRequest, type Intent, type RequestLimits } from "./types.js";

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
  const checkedAnchors = sanitizeAnchors(anchors, limits);
  if (!checkedAnchors.ok) return checkedAnchors;
  // docContext 는 프록시 계약상 string. 없으면 빈 문자열로 관대 처리.
  const ctx = typeof docContext === "string" ? docContext : "";
  if (ctx.length > limits.maxDocContext) return { ok: false, error: `docContext가 너무 깁니다(>${limits.maxDocContext}).` };
  // attachments(멀티모달)는 선택 필드 — 있으면 배열·개수·크기를 검증해 well-formed 항목만 통과시킨다.
  const att = sanitizeAttachments(b.attachments, limits);
  if (!att.ok) return { ok: false, error: att.error };
  const value: EditRequest = { instruction, anchors: checkedAnchors.value, docContext: ctx };
  if (att.value.length) value.attachments = att.value;
  return { ok: true, value };
}

const ANCHOR_KINDS = new Set(["cell", "range", "paragraph", "table"]);

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000;
}

function indexPair(value: unknown): [number, number] | null {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    !nonNegativeInteger(value[0]) ||
    !nonNegativeInteger(value[1]) ||
    value[0] > value[1]
  ) {
    return null;
  }
  return [value[0], value[1]];
}

/** Rebuild untrusted anchors from known scalar fields. This deliberately does not spread/cast input:
 *  an attacker cannot smuggle a large nested object through a harmless-looking anchor. */
function sanitizeAnchors(
  raw: unknown[],
  limits: RequestLimits,
): { ok: true; value: Anchor[] } | { ok: false; error: string } {
  const maxLabel = limits.maxAnchorLabel ?? DEFAULT_LIMITS.maxAnchorLabel ?? 512;
  const maxText = limits.maxAnchorText ?? DEFAULT_LIMITS.maxAnchorText ?? 4000;
  const maxPath = limits.maxAnchorPath ?? DEFAULT_LIMITS.maxAnchorPath ?? 16;
  const maxJson = limits.maxAnchorsJson ?? DEFAULT_LIMITS.maxAnchorsJson ?? 50_000;
  const out: Anchor[] = [];

  for (let i = 0; i < raw.length; i++) {
    const candidate = raw[i];
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      return { ok: false, error: `anchors[${i}]가 오브젝트가 아닙니다.` };
    }
    const r = candidate as Record<string, unknown>;
    if (typeof r.kind !== "string" || !ANCHOR_KINDS.has(r.kind)) {
      return { ok: false, error: `anchors[${i}].kind가 지원되지 않습니다.` };
    }
    if (!nonNegativeInteger(r.section) || !nonNegativeInteger(r.block)) {
      return { ok: false, error: `anchors[${i}]의 section/block은 0 이상의 안전한 정수여야 합니다.` };
    }

    const anchor: Anchor = {
      kind: r.kind,
      section: r.section,
      block: r.block,
    };
    if (r.rows !== undefined) {
      const rows = indexPair(r.rows);
      if (!rows) return { ok: false, error: `anchors[${i}].rows는 오름차순 정수 쌍이어야 합니다.` };
      anchor.rows = rows;
    }
    if (r.cols !== undefined) {
      const cols = indexPair(r.cols);
      if (!cols) return { ok: false, error: `anchors[${i}].cols는 오름차순 정수 쌍이어야 합니다.` };
      anchor.cols = cols;
    }
    if (r.label !== undefined) {
      if (typeof r.label !== "string" || r.label.length > maxLabel) {
        return { ok: false, error: `anchors[${i}].label이 문자열이 아니거나 너무 깁니다(>${maxLabel}).` };
      }
      anchor.label = r.label;
    }
    if (r.page !== undefined) {
      if (!nonNegativeInteger(r.page)) {
        return { ok: false, error: `anchors[${i}].page는 0 이상의 안전한 정수여야 합니다.` };
      }
      anchor.page = r.page;
    }
    if (r.text !== undefined) {
      if (typeof r.text !== "string" || r.text.length > maxText) {
        return { ok: false, error: `anchors[${i}].text가 문자열이 아니거나 너무 깁니다(>${maxText}).` };
      }
      anchor.text = r.text;
    }
    if (r.path !== undefined) {
      if (anchor.kind !== "cell") {
        return { ok: false, error: `anchors[${i}].path는 cell 앵커에만 허용됩니다.` };
      }
      if (!Array.isArray(r.path) || r.path.length === 0 || r.path.length > maxPath) {
        return { ok: false, error: `anchors[${i}].path 깊이가 올바르지 않습니다(1..${maxPath}).` };
      }
      const path: Array<{ block: number; row: number; col: number }> = [];
      for (let j = 0; j < r.path.length; j++) {
        const step = r.path[j];
        if (!step || typeof step !== "object" || Array.isArray(step)) {
          return { ok: false, error: `anchors[${i}].path[${j}]가 오브젝트가 아닙니다.` };
        }
        const s = step as Record<string, unknown>;
        if (!nonNegativeInteger(s.block) || !nonNegativeInteger(s.row) || !nonNegativeInteger(s.col)) {
          return { ok: false, error: `anchors[${i}].path[${j}] 주소가 올바르지 않습니다.` };
        }
        path.push({ block: s.block, row: s.row, col: s.col });
      }
      anchor.path = path;
    }
    out.push(anchor);
  }

  if (JSON.stringify(out).length > maxJson) {
    return { ok: false, error: `anchors 전체가 너무 큽니다(>${maxJson}자).` };
  }
  return { ok: true, value: out };
}

/** Validate + sanitize the OPTIONAL `attachments` array (multimodal chat input). Absent → `[]` (additive,
 *  no error). Rejects a non-array or an over-count set; per item keeps only well-formed
 *  `{ id, kind:'image'|'doc', name, mime }` and carries a size-checked `dataUrl` (image) / `text` (doc).
 *  Malformed items and oversized payloads are dropped/rejected so untrusted attachment content can never
 *  bloat the turn or smuggle a non-string field into the fence. Pure + isomorphic — no fetch, no I/O. */
function sanitizeAttachments(raw: unknown, limits: RequestLimits): { ok: true; value: Attachment[] } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, value: [] };
  if (!Array.isArray(raw)) return { ok: false, error: "attachments(배열)가 아닙니다." };
  const maxN = limits.maxAttachments ?? DEFAULT_LIMITS.maxAttachments ?? 8;
  if (raw.length > maxN) return { ok: false, error: `attachments가 너무 많습니다(>${maxN}).` };
  const maxText = limits.maxAttachmentText ?? DEFAULT_LIMITS.maxAttachmentText ?? 20000;
  const maxUrl = limits.maxImageDataUrl ?? DEFAULT_LIMITS.maxImageDataUrl ?? 8_000_000;
  const out: Attachment[] = [];
  for (const c of raw) {
    if (!c || typeof c !== "object") continue;
    const r = c as Record<string, unknown>;
    const kind = r.kind;
    if (kind !== "image" && kind !== "doc") continue;
    const id = typeof r.id === "string" ? r.id : "";
    const name = typeof r.name === "string" ? r.name : "";
    const mime = typeof r.mime === "string" ? r.mime : "";
    if (kind === "image") {
      if (typeof r.dataUrl !== "string" || !r.dataUrl.startsWith("data:")) continue; // image needs an inline data URL
      if (r.dataUrl.length > maxUrl) return { ok: false, error: `첨부 이미지가 너무 큽니다(>${maxUrl}B).` };
      out.push({ id, kind, name, mime, dataUrl: r.dataUrl });
    } else {
      if (typeof r.text !== "string" || r.text.length === 0) continue; // doc with no extracted text carries nothing
      if (r.text.length > maxText) return { ok: false, error: `첨부 문서 텍스트가 너무 깁니다(>${maxText}).` };
      out.push({ id, kind, name, mime, text: r.text });
    }
  }
  return { ok: true, value: out };
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

/** Sanitize a model message's `annotations` (OpenRouter web plugin) into display-only `{title, url}`
 *  citations. Keeps only well-formed `url_citation` entries with a string `url` (the title falls back to
 *  the url when missing). Pure + isomorphic — no fetch, no key. This is the citations "pass-through": the
 *  intents lane (`validateResponse`) is UNCHANGED; citations are transparency DATA parsed alongside it and
 *  NEVER fed back as Intents (R5/R6). Accepts either the OpenRouter nesting
 *  `{ type:"url_citation", url_citation:{url,title,content?} }` or a flat `{url,title}`. */
export function extractCitations(annotations: unknown): Citation[] {
  if (!Array.isArray(annotations)) return [];
  const out: Citation[] = [];
  for (const a of annotations) {
    if (!a || typeof a !== "object") continue;
    const rec = a as { type?: unknown; url_citation?: unknown; url?: unknown; title?: unknown };
    const nested =
      rec.type === "url_citation" && rec.url_citation && typeof rec.url_citation === "object"
        ? (rec.url_citation as { url?: unknown; title?: unknown })
        : rec;
    const url = typeof nested.url === "string" ? nested.url : null;
    if (!url) continue;
    const title = typeof nested.title === "string" && nested.title.trim() ? nested.title : url;
    out.push({ url, title });
  }
  return out;
}
