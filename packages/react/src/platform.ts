/// Platform detection for the selection UX (issue 021): the additive/toggle modifier is ⌘ on macOS
/// and Ctrl elsewhere. We DETECT for the DISPLAY label only — the handlers always accept BOTH
/// `metaKey` and `ctrlKey` (so a Mac user on an external PC keyboard, or vice-versa, still works).

/** True on macOS/iOS (best-effort; SSR-safe → false when there's no navigator). */
export function isMac(): boolean {
  if (typeof navigator === "undefined") return false;
  const s = `${navigator.platform ?? ""} ${navigator.userAgent ?? ""}`;
  return /Mac|iPhone|iPad|iPod/i.test(s);
}

/** The human label for the additive/toggle modifier key: "⌘" on macOS, "Ctrl" elsewhere. */
export function modLabel(): string {
  return isMac() ? "⌘" : "Ctrl";
}

/** Whether a pointer/keyboard event carries the additive/toggle modifier (⌘ on macOS, Ctrl elsewhere).
 *  Accepts BOTH regardless of platform so the interaction never depends on correct OS detection. */
export function hasMod(e: { metaKey?: boolean; ctrlKey?: boolean }): boolean {
  return !!(e.metaKey || e.ctrlKey);
}
