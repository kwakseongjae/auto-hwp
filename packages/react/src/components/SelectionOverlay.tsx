import type { PageBox } from "../coords";

/** A visible mark over a selected cell/range/table/paragraph on ONE page. `box` is in own-render PAGE
 *  px; the overlay scales it to client px by `scale` (= rendered px / viewBox px). */
export interface Mark {
  page: number;
  box: PageBox;
  label: string;
  kind: "cell" | "range" | "paragraph" | "table" | "image" | string;
}

export interface SelectionOverlayProps {
  /** All marks; the overlay renders only those whose `page === page`. */
  marks: Mark[];
  /** The page this overlay layer belongs to. */
  page: number;
  /** rendered px / viewBox px for this page (from HwpPageView). */
  scale: number;
}

/// SelectionOverlay — the cell/range/paragraph/table MARKING layer (issue 016 step 2). It draws a box
/// (page-px → client-px via coords.ts, so it tracks zoom) with a small label chip over exactly what the
/// user marked, so "가리키기"(pointing) is tangible and the marked spot rides along to the chat panel as
/// an anchor. The v1 package deliberately EXCLUDES the desktop app's batch-format toolbar (shade/align
/// buttons) — marking only.
export function SelectionOverlay({ marks, page, scale }: SelectionOverlayProps) {
  const mine = marks.filter((m) => m.page === page);
  if (mine.length === 0) return null;
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
    </div>
  );
}
