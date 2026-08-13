export const ANALYTICS_CONSENT_STORAGE_KEY = "auto-hwp:analytics-consent:v1";
export const ANALYTICS_CONSENT_EVENT = "auto-hwp:analytics-consent-change";

export type AnalyticsConsent = "granted" | "denied" | null;

export interface AnalyticsConsentStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function defaultStorage(): AnalyticsConsentStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function readAnalyticsConsent(storage: AnalyticsConsentStorage | null = defaultStorage()): AnalyticsConsent {
  const value = storage?.getItem(ANALYTICS_CONSENT_STORAGE_KEY);
  return value === "granted" || value === "denied" ? value : null;
}

export function writeAnalyticsConsent(
  consent: Exclude<AnalyticsConsent, null>,
  storage: AnalyticsConsentStorage | null = defaultStorage(),
): void {
  storage?.setItem(ANALYTICS_CONSENT_STORAGE_KEY, consent);
  if (typeof window !== "undefined") window.dispatchEvent(new Event(ANALYTICS_CONSENT_EVENT));
}

export function clearAnalyticsConsent(storage: AnalyticsConsentStorage | null = defaultStorage()): void {
  storage?.removeItem(ANALYTICS_CONSENT_STORAGE_KEY);
  if (typeof window !== "undefined") window.dispatchEvent(new Event(ANALYTICS_CONSENT_EVENT));
}
