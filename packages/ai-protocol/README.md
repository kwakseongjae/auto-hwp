# @auto-hwp/ai-protocol

The **vendor-neutral, isomorphic** LLM protocol for auto-hwp chat-editing — the L2' of the
[SDK layers](../../docs/SDK-LAYERS.md). It is **types + pure transforms + validation only**: the doc-context
builder, the system prompt (an excerpt of [INTENT-SCHEMA](../../docs/INTENT-SCHEMA.md)), and the
request/response validators. The **server proxy and the browser client import the SAME module**, so the
wire contract can never drift between them.

> **Zero fetch. Zero LLM client. Zero keys.** Which model, which vendor, streaming or not — all the
> host's choice (R6). This package never talks to a network.

```ts
// ── server proxy (your key lives here) ──────────────────────────────
import { buildSystemPrompt, buildUserMessage, validateRequest, validateResponse } from "@auto-hwp/ai-protocol";

const check = validateRequest(await req.json());
if (!check.ok) return badRequest(check.error);

const text = await callYourModel({                 // ← YOUR vendor, YOUR key
  system: buildSystemPrompt(),                      // INTENT-SCHEMA excerpt; pass { allowedIntents } to narrow
  user: buildUserMessage(check.value),              // R5 <document-content> fence applied here
});
return json({ intents: validateResponse(text, { onDrop: console.warn }) }); // whitelist + structure

// ── browser client (no key, no model) ───────────────────────────────
import { buildDocContext } from "@auto-hwp/ai-protocol";
const docContext = buildDocContext(meta, anchors); // the string POSTed to your proxy
```

## API

| Export | Role |
|--------|------|
| `EditRequest` / `EditResponse` / `Intent` / `Anchor` / `INTENT_VERSION` | the wire types (schema v0). |
| `buildDocContext(meta, anchors, { maxLen? })` | the doc-context string (header + anchor lines; anchor text is untrusted). |
| `buildUserMessage(req)` | the LLM user turn with the **R5 `<document-content>` fence**. |
| `buildSystemPrompt({ allowedIntents? })` | the system prompt — an **excerpt of INTENT-SCHEMA** (source-line comments preserved), optionally a subset. |
| `validateRequest(body, limits?)` | input guard (length/count caps). |
| `validateResponse(textOrArray, { allowedIntents?, onDrop? })` | parse LLM text → **whitelist + structure check**. |
| `DEFAULT_ALLOWED_INTENTS` / `DEFAULT_LIMITS` | the frozen whitelist + caps. |

## Bring your own vendor

The only host-specific glue is *the model call itself*. Everything before it (prompt + user message) and
after it (parse + whitelist) is here and shared. `apps/hwp-lab/src/app/api/hwp-edit/route.ts` is a
**documented reference proxy** (Anthropic) — copy it for any vendor.

## Develop

```bash
npm run build       # tsc → dist (JS + .d.ts)
npm run typecheck   # tsc --noEmit
npm test            # vitest (node env): context/prompt/validate — isomorphic
```
