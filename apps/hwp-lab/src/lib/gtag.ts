import { readAnalyticsConsent } from "./analyticsConsent";

export type GtagParams = Record<string, string | number | boolean>;

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
  }
}

export function event(name: string, params: GtagParams = {}): void {
  if (typeof window === "undefined" || readAnalyticsConsent() !== "granted" || typeof window.gtag !== "function") return;
  window.gtag("event", name, params);
}
