import type { MatchBox } from "@tf-hwp/editor-core";

export interface FindMatchOverlayProps {
  /** Located match boxes, index-aligned with the FindController's matches (null = geometry unavailable). */
  boxes: (MatchBox | null)[];
  /** Index of the current match (the emphasized one), or −1 when none. */
  current: number;
  /** The page this layer belongs to (only boxes on this page draw). */
  page: number;
  /** rendered px / viewBox px for this page (own-render PAGE px → client px). */
  scale: number;
}

/// FindMatchOverlay — the 찾기 하이라이트 layer (issue 045), a SelectionOverlay twin: pointer-events:none,
/// draws each match's box (own-render PAGE px → client px via `scale`) on its page. The CURRENT match gets
/// `hw-find-current` (강조색); the rest get `hw-find-hit` (옅게), visually distinct from the selection marks.
/// Boxes come pre-resolved from the FindController (caretRect geometry); a null entry (no geometry) draws
/// nothing.
export function FindMatchOverlay({ boxes, current, page, scale }: FindMatchOverlayProps) {
  const mine = boxes
    .map((b, i) => ({ b, i }))
    .filter((e): e is { b: MatchBox; i: number } => !!e.b && e.b.page === page);
  if (mine.length === 0) return null;
  return (
    <div className="hw-find-overlay" aria-hidden>
      {mine.map(({ b, i }) => (
        <div
          key={i}
          className={`hw-find-hit${i === current ? " hw-find-current" : ""}`}
          style={{ left: b.box.x * scale, top: b.box.y * scale, width: b.box.w * scale, height: b.box.h * scale }}
        />
      ))}
    </div>
  );
}
