import type { PageBox } from "../coords";

/** A visible mark over a selected cell/range/table/paragraph on ONE page. `box` is in own-render PAGE
 *  px; the overlay scales it to client px by `scale` (= rendered px / viewBox px). */
export interface Mark {
  page: number;
  box: PageBox;
  label: string;
  kind: "cell" | "range" | "paragraph" | "table" | "image" | string;
}

/** The in-progress marquee (rubber-band) rectangle while the user drags over empty space. `box` is in
 *  own-render PAGE px on `page`; the overlay draws it as a dashed rectangle (Finder-style). v1 clips a
 *  marquee to the page it started on, so only that page's overlay ever draws it. */
export interface Marquee {
  page: number;
  box: PageBox;
}

export interface SelectionOverlayProps {
  /** All marks; the overlay renders only those whose `page === page`. */
  marks: Mark[];
  /** The page this overlay layer belongs to. */
  page: number;
  /** rendered px / viewBox px for this page (from HwpPageView). */
  scale: number;
  /** The active marquee rectangle (or null). Drawn only when `marquee.page === page`. */
  marquee?: Marquee | null;
  /** 072 — transient "위치 보기" flash: the AI card's target block box, drawn briefly (fade-out
   *  animation) so the user SEES which block an edit targets before applying. Same page-px→client-px
   *  scale as marks; null = no flash. */
  flash?: Mark | null;
}

/// SelectionOverlay — the cell/range/paragraph/table MARKING layer (issue 016 step 2) + the marquee
/// (rubber-band) rectangle (issue 021). It draws a box (page-px → client-px via `scale`, so it tracks
/// zoom) with a small label chip over exactly what the user marked, so "가리키기"(pointing) is tangible
/// and the marked spot rides along to the chat panel as an anchor. While dragging over empty space it
/// also draws the dashed marquee rectangle. This layer is `pointer-events: none` — pointer handling
/// lives on the page sheet (HwpPageView → HwpWorkspace); the overlay is purely visual.
export function SelectionOverlay({ marks, page, scale, marquee, flash }: SelectionOverlayProps) {
  const mine = marks.filter((m) => m.page === page);
  const rubber = marquee && marquee.page === page ? marquee : null;
  const glow = flash && flash.page === page ? flash : null;
  if (mine.length === 0 && !rubber && !glow) return null;
  return (
    <div className="hw-overlay" aria-hidden>
      {mine.map((m, i) => {
        // page px → client px is a uniform `scale` (rendered / viewBox), so multiply each edge.
        const left = m.box.x * scale;
        const top = m.box.y * scale;
        const width = m.box.w * scale;
        const height = m.box.h * scale;
        return (
          <div key={i} className={`hw-mark hw-mark-${m.kind}`} style={{ left, top, width, height }}>
            <span className="hw-mark-label">{m.label}</span>
          </div>
        );
      })}
      {glow && (
        <div
          className="hw-reveal-flash"
          data-testid="hw-reveal-flash"
          style={{ left: glow.box.x * scale, top: glow.box.y * scale, width: glow.box.w * scale, height: glow.box.h * scale }}
        >
          <span className="hw-mark-label">{glow.label}</span>
        </div>
      )}
      {rubber && (
        <div
          className="hw-marquee"
          style={{ left: rubber.box.x * scale, top: rubber.box.y * scale, width: rubber.box.w * scale, height: rubber.box.h * scale }}
        />
      )}
    </div>
  );
}
