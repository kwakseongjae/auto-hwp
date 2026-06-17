/// A palette command. `run` maps 1:1 to a typed Intent (api.ts) — no prose parsing. The Hangul-
/// aware fuzzy match (초성/NFC·NFD/romaja) lands in P1; P0 uses substring over title+keywords.
export type Command = {
  id: string;
  title: string;
  group: string;
  /** Display shortcut hint, e.g. "⌘E". */
  keys?: string;
  /** Extra search terms (ko + en) the title may not contain. */
  keywords?: string;
  /** "ai" tints the row purple (the generative review lane). */
  tone?: "ai";
  disabled?: boolean;
  run: () => void | Promise<void>;
};

/** P0 match: case-insensitive substring over title + keywords. P1 upgrades to Hangul-aware. */
export function matchCommand(c: Command, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (c.title + " " + (c.keywords ?? "")).toLowerCase().includes(q);
}
