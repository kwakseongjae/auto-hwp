// @tf-hwp/ai-protocol — vendor-neutral, ISOMORPHIC LLM protocol for tf-hwp chat-editing (SDK-LAYERS L2').
// Pure data transforms + validation. NO fetch, NO LLM client, NO keys — a host wires its own model over
// these shapes; the server proxy AND the browser client import the SAME module. See the README for the
// "bring your own vendor" integration.

export { INTENT_VERSION, DEFAULT_LIMITS } from "./types";
export type { Anchor, DocMeta, EditRequest, EditResponse, Intent, RequestLimits } from "./types";

export { buildDocContext, buildUserMessage } from "./context";
export { buildSystemPrompt, DEFAULT_ALLOWED_INTENTS } from "./prompt";
export { validateRequest, validateResponse, extractJsonArray } from "./validate";
export type { RequestCheck, ValidateResponseOptions } from "./validate";
