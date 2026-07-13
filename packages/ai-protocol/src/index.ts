// @tf-hwp/ai-protocol — vendor-neutral, ISOMORPHIC LLM protocol for tf-hwp chat-editing (SDK-LAYERS L2').
// Pure data transforms + validation. NO fetch, NO LLM client, NO keys — a host wires its own model over
// these shapes; the server proxy AND the browser client import the SAME module. See the README for the
// "bring your own vendor" integration.

export { INTENT_VERSION, DEFAULT_LIMITS } from "./types.js";
export type { Anchor, DocMeta, EditRequest, EditResponse, GridCell, Intent, RequestLimits, TableGrid } from "./types.js";

export { buildDocContext, buildUserMessage } from "./context.js";
export { buildSystemPrompt, DEFAULT_ALLOWED_INTENTS } from "./prompt.js";
export { validateRequest, validateResponse, extractJsonArray } from "./validate.js";
export type { RequestCheck, ValidateResponseOptions } from "./validate.js";
