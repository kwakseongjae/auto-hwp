import { describe, expect, it, vi } from "vitest";
import {
  DEMO_AI_CONSENT_MESSAGE,
  DEMO_AI_CONSENT_STORAGE_KEY,
  demoAiConsentMessage,
  demoAiConsentParagraphs,
  ensureDemoAiConsent,
  hasDemoAiConsent,
  revokeDemoAiConsent,
  type DemoAiConsentState,
  type DemoAiConsentStorage,
} from "./demoAiConsent";

/** localStorage 대역(vitest 는 node 환경 — 실제 저장소가 없다). */
function memoryStorage(seed: Record<string, string> = {}): DemoAiConsentStorage & { map: Map<string, string> } {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

describe("public demo AI consent", () => {
  it("does not grant or suppress a later prompt after decline", async () => {
    const state: DemoAiConsentState = { granted: false };
    const store = memoryStorage();
    const ask = vi.fn(async () => false);
    expect(await ensureDemoAiConsent(state, ask, "worker", store)).toBe(false);
    expect(state.granted).toBe(false);
    expect(store.map.size).toBe(0); // 거부는 **아무 것도 기록하지 않는다**
    expect(ask).toHaveBeenCalledWith(DEMO_AI_CONSENT_MESSAGE);
    expect(await ensureDemoAiConsent(state, ask, "worker", store)).toBe(false);
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it("asks once, then remembers the grant in storage (다음 요청·다음 방문 모두 묻지 않는다)", async () => {
    const store = memoryStorage();
    const ask = vi.fn(async () => true);
    const state: DemoAiConsentState = { granted: false };
    expect(await ensureDemoAiConsent(state, ask, "worker", store)).toBe(true);
    expect(await ensureDemoAiConsent(state, ask, "worker", store)).toBe(true);
    expect(state.granted).toBe(true);
    expect(store.map.get(DEMO_AI_CONSENT_STORAGE_KEY)).toBe("1");
    expect(ask).toHaveBeenCalledTimes(1);

    // 새 페이지(=새 state, 같은 브라우저 저장소)에서도 다시 묻지 않는다 — 최초 1회 계약의 본체.
    const fresh: DemoAiConsentState = { granted: false };
    expect(await ensureDemoAiConsent(fresh, ask, "worker", store)).toBe(true);
    expect(fresh.granted).toBe(true);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("저장소가 비면(새 브라우저/동의 철회) 다시 묻는다", async () => {
    const store = memoryStorage();
    const ask = vi.fn(async () => true);
    await ensureDemoAiConsent({ granted: false }, ask, "worker", store);
    expect(hasDemoAiConsent(store)).toBe(true);

    revokeDemoAiConsent(store);
    expect(hasDemoAiConsent(store)).toBe(false);
    expect(await ensureDemoAiConsent({ granted: false }, ask, "worker", store)).toBe(true);
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it("저장소가 없어도(프라이빗 모드) 게이트는 동작하고, 동의는 그 페이지 수명 동안만 유지된다", async () => {
    const ask = vi.fn(async () => true);
    const state: DemoAiConsentState = { granted: false };
    expect(await ensureDemoAiConsent(state, ask, "route", null)).toBe(true);
    expect(await ensureDemoAiConsent(state, ask, "route", null)).toBe(true);
    expect(ask).toHaveBeenCalledTimes(1);
    // 새 페이지에서는(메모리 state 가 리셋되므로) 다시 묻는다 — 조용한 영구 승인 없음.
    expect(await ensureDemoAiConsent({ granted: false }, ask, "route", null)).toBe(true);
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it("잘못된 저장 값은 동의로 치지 않는다", () => {
    expect(hasDemoAiConsent(memoryStorage({ [DEMO_AI_CONSENT_STORAGE_KEY]: "0" }))).toBe(false);
    expect(hasDemoAiConsent(memoryStorage({ [DEMO_AI_CONSENT_STORAGE_KEY]: "true" }))).toBe(false);
    expect(hasDemoAiConsent(memoryStorage({ [DEMO_AI_CONSENT_STORAGE_KEY]: "1" }))).toBe(true);
  });

  it("게이트가 이미 동의한 브라우저에서는 묻지 않고 통과한다(요청 지연 0)", async () => {
    const store = memoryStorage({ [DEMO_AI_CONSENT_STORAGE_KEY]: "1" });
    const ask = vi.fn(async () => false); // 불려서는 안 된다
    expect(await ensureDemoAiConsent({ granted: false }, ask, "route", store)).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });

  it("모달 문단은 동의 문구 원문 그대로다(프라이버시 계약 드리프트 금지)", () => {
    for (const transport of ["worker", "route"] as const) {
      const paragraphs = demoAiConsentParagraphs(transport);
      const source = demoAiConsentMessage(transport);
      // 문단은 원문 줄들의 부분집합이 아니라 **전부**이며(빈 줄 제외), 순서·글자가 같다.
      expect(paragraphs).toEqual(source.split("\n").filter((l) => l.trim()));
      for (const p of paragraphs) expect(source).toContain(p);
    }
    // 전송 대상·경로 서술이 그대로 실려 있는지(문구를 요약하거나 잘라 쓰지 않았는지) 확인.
    const route = demoAiConsentParagraphs("route").join(" ");
    expect(route).toContain("오토한글 데모 서버(Vercel)를 거쳐");
    expect(route).toContain("OpenRouter");
    expect(route).toContain("파일 원본 전체는 업로드하지 않습니다");
    expect(route).toContain("되돌릴 수 있습니다");
    expect(demoAiConsentParagraphs("worker").join(" ")).toContain("Cloudflare Worker를 거쳐");
  });

  it("동기 confirm 콜백도 그대로 받는다(계약 하위호환)", async () => {
    const store = memoryStorage();
    const confirm = vi.fn(() => true);
    expect(await ensureDemoAiConsent({ granted: false }, confirm, "worker", store)).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(1);
  });
});
