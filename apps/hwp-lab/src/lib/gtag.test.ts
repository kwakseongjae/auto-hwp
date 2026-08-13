import { afterEach, describe, expect, it, vi } from "vitest";
import { ANALYTICS_CONSENT_STORAGE_KEY } from "./analyticsConsent";
import { event } from "./gtag";

afterEach(() => {
  Reflect.deleteProperty(globalThis, "window");
});

function installWindow(consent: string | null) {
  const gtag = vi.fn();
  const localStorage = {
    getItem: (key: string) => (key === ANALYTICS_CONSENT_STORAGE_KEY ? consent : null),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { gtag, localStorage },
  });
  return gtag;
}

describe("gtag privacy gate", () => {
  it.each([null, "denied", "unexpected"])("does not emit without granted consent (%s)", (consent) => {
    const gtag = installWindow(consent);
    event("ws_export", { format: "pdf" });
    expect(gtag).not.toHaveBeenCalled();
  });

  it("emits the finite event payload after explicit consent", () => {
    const gtag = installWindow("granted");
    event("ws_export", { format: "pdf", result: "success" });
    expect(gtag).toHaveBeenCalledWith("event", "ws_export", { format: "pdf", result: "success" });
  });
});
