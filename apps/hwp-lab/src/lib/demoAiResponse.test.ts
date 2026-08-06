// 빈/부분 제안의 **정직한 표시** 계약(클라 쪽). 서버가 실어 보낸 reason/message 가 화면 결정으로
// 어떻게 바뀌는지를 잠근다 — 어제까지는 이 배선이 없어 채팅이 조용히 "제안 0건"으로 끝났다.
import { describe, expect, it } from "vitest";
import { demoAiHttpError, readDemoAiResponse } from "./demoAiResponse";

describe("readDemoAiResponse", () => {
  it("reason 이 없으면 예전 그대로 — intents 만 통과(회귀 0)", () => {
    const out = readDemoAiResponse<{ intent: string }>({ intents: [{ intent: "SetTableCell" }] });
    expect(out.intents).toHaveLength(1);
    expect(out.error).toBeUndefined();
    expect(out.warning).toBeUndefined();
  });

  it("제안 0건 + reason → 오류 문구로 이유를 말한다(침묵 금지)", () => {
    const out = readDemoAiResponse({ intents: [], reason: "truncated", message: "모델 응답이 잘렸습니다." });
    expect(out.intents).toEqual([]);
    expect(out.error).toBe("모델 응답이 잘렸습니다.");
    expect(out.warning).toBeUndefined();
  });

  it("부분 제안(절단 구제) → 카드는 살리고 '일부만' 경고를 붙인다", () => {
    const out = readDemoAiResponse({ intents: [{ a: 1 }], reason: "truncated", message: "온전한 1건만 제안합니다." });
    expect(out.intents).toHaveLength(1);
    expect(out.error).toBeUndefined();
    expect(out.warning).toContain("온전한 1건만 제안합니다.");
    expect(out.warning).toContain("일부만 반영");
  });

  it("message 가 없는 구버전 프록시에서도 reason 별 폴백 문구가 나온다", () => {
    expect(readDemoAiResponse({ intents: [], reason: "no_valid_intents" }).error).toContain("적용할 편집을 찾지 못했습니다");
    expect(readDemoAiResponse({ intents: [], reason: "upstream_error" }).error).toContain("AI 제공자");
  });

  it("모르는 reason 값·비배열 intents 는 안전하게 무시한다(additive 계약)", () => {
    expect(readDemoAiResponse({ intents: [], reason: "banana" }).error).toBeUndefined();
    expect(readDemoAiResponse({ intents: "nope" }).intents).toEqual([]);
    expect(readDemoAiResponse(null).intents).toEqual([]);
  });
});

describe("demoAiHttpError", () => {
  it("429/503 은 서버 문구를 접두 없이 그대로 띄운다(이미 완성된 안내)", () => {
    expect(demoAiHttpError(429, { error: "오늘 한도를 다 썼습니다." })).toBe("오늘 한도를 다 썼습니다.");
    expect(demoAiHttpError(503, { error: "데모 AI가 아직 구성되지 않았습니다." })).toBe("데모 AI가 아직 구성되지 않았습니다.");
  });

  it("upstream_error 는 제공자 실패임을 밝힌다", () => {
    expect(demoAiHttpError(502, { error: "OpenRouter 500", reason: "upstream_error" })).toContain("AI 제공자 호출이 실패");
  });

  it("본문을 못 읽은 오류도 상태코드로 정직하게 노출한다", () => {
    expect(demoAiHttpError(500, null)).toBe("AI 데모 오류: 500");
  });
});
