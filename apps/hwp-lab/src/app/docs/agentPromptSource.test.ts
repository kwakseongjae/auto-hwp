import { describe, expect, it } from "vitest";
import { extractLaunchAgentPrompt } from "./agentPromptSource";

describe("launch agent prompt source", () => {
  it("첫 text fence를 복사용 원문으로 추출한다", () => {
    expect(extractLaunchAgentPrompt("# title\n\n```text\nline 1\nline 2\n```\n")).toBe("line 1\nline 2");
  });

  it("원문 fence가 없으면 빌드를 조용히 진행하지 않는다", () => {
    expect(() => extractLaunchAgentPrompt("# title\n")).toThrow(/text 프롬프트/);
  });
});
