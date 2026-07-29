import { describe, expect, it, vi } from "vitest";
import { DEMO_AI_CONSENT_MESSAGE, ensureDemoAiConsent, type DemoAiConsentState } from "./demoAiConsent";

describe("public demo AI consent", () => {
  it("does not grant or suppress a later prompt after decline", () => {
    const state: DemoAiConsentState = { granted: false };
    const confirm = vi.fn(() => false);
    expect(ensureDemoAiConsent(state, confirm)).toBe(false);
    expect(state.granted).toBe(false);
    expect(confirm).toHaveBeenCalledWith(DEMO_AI_CONSENT_MESSAGE);
    expect(ensureDemoAiConsent(state, confirm)).toBe(false);
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it("asks once after acceptance for the lifetime of one mounted page", () => {
    const state: DemoAiConsentState = { granted: false };
    const confirm = vi.fn(() => true);
    expect(ensureDemoAiConsent(state, confirm)).toBe(true);
    expect(ensureDemoAiConsent(state, confirm)).toBe(true);
    expect(state.granted).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it("asks again for a newly mounted page state", () => {
    const confirm = vi.fn(() => true);
    expect(ensureDemoAiConsent({ granted: false }, confirm)).toBe(true);
    expect(ensureDemoAiConsent({ granted: false }, confirm)).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(2);
  });
});
