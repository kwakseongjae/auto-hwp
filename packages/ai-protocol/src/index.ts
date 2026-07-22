// @auto-hwp/ai-protocol — vendor-neutral, ISOMORPHIC LLM protocol for auto-hwp chat-editing (SDK-LAYERS L2').
// Pure data transforms + validation. NO fetch, NO LLM client, NO keys — a host wires its own model over
// these shapes; the server proxy AND the browser client import the SAME module. See the README for the
// "bring your own vendor" integration.

export { INTENT_VERSION, DEFAULT_LIMITS } from "./types.js";
export type { AgentEvent, Anchor, Attachment, ChatTurn, Citation, DocMeta, EditRequest, EditResponse, GridCell, Intent, RequestLimits, TableGrid, UserContentPart } from "./types.js";

export { buildDocContext, buildUserMessage, buildUserMessageParts } from "./context.js";
export { buildSystemPrompt, buildAgentSystemPrompt, DEFAULT_ALLOWED_INTENTS } from "./prompt.js";
export { validateRequest, validateResponse, extractJsonArray, extractCitations } from "./validate.js";
export type { RequestCheck, ValidateResponseOptions } from "./validate.js";
export {
  AGENT_TOOL_WEB_SEARCH,
  AGENT_TOOL_EMIT_INTENTS,
  agentToolSchemas,
  serializeAgentEvent,
  parseAgentEvent,
  createAgentEventParser,
} from "./agent.js";
export type { AgentToolSchema } from "./agent.js";
