import { describe, expect, it } from "vitest";
import {
  ANALYTICS_CONSENT_STORAGE_KEY,
  clearAnalyticsConsent,
  readAnalyticsConsent,
  writeAnalyticsConsent,
  type AnalyticsConsentStorage,
} from "./analyticsConsent";

function memoryStorage(seed?: string): AnalyticsConsentStorage & { value: string | null } {
  const storage: AnalyticsConsentStorage & { value: string | null } = {
    value: seed ?? null,
    getItem: () => storage.value,
    setItem: (_key, value) => {
      storage.value = value;
    },
    removeItem: () => {
      storage.value = null;
    },
  };
  return storage;
}

describe("analytics consent", () => {
  it("treats missing and unknown values as undecided", () => {
    expect(readAnalyticsConsent(memoryStorage())).toBeNull();
    expect(readAnalyticsConsent(memoryStorage("yes"))).toBeNull();
  });

  it("persists only the explicit granted or denied decision", () => {
    const storage = memoryStorage();
    writeAnalyticsConsent("granted", storage);
    expect(storage.value).toBe("granted");
    expect(readAnalyticsConsent(storage)).toBe("granted");
    writeAnalyticsConsent("denied", storage);
    expect(readAnalyticsConsent(storage)).toBe("denied");
  });

  it("can forget the choice so the banner asks again", () => {
    const storage = memoryStorage("granted");
    clearAnalyticsConsent(storage);
    expect(storage.value).toBeNull();
  });

  it("uses a versioned, product-scoped key", () => {
    expect(ANALYTICS_CONSENT_STORAGE_KEY).toBe("auto-hwp:analytics-consent:v1");
  });
});
