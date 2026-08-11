import { readFileSync } from "node:fs";
import path from "node:path";

const PROMPT_PATH = path.join(process.cwd(), "..", "..", "docs", "launch", "AGENT-PROMPT.md");

/** AGENT-PROMPT.md의 첫 text fence가 README·사이트·게시물이 공유하는 한국어 원문이다. */
export function extractLaunchAgentPrompt(markdown: string): string {
  const match = markdown.match(/```text\r?\n([\s\S]*?)\r?\n```/);
  if (!match?.[1]?.trim()) throw new Error("docs/launch/AGENT-PROMPT.md에 text 프롬프트가 없습니다.");
  return match[1].trim();
}

/** /docs 정적 생성 시 레포 정본을 읽는다. 런타임 요청이나 클라이언트 번들에서는 실행되지 않는다. */
export function readLaunchAgentPrompt(): string {
  return extractLaunchAgentPrompt(readFileSync(PROMPT_PATH, "utf8"));
}
