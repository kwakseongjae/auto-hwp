import { useState } from "react";

export interface TableSizeGridProps {
  /** Max rows/cols the grid picker offers. Default 8×8. */
  maxRows?: number;
  maxCols?: number;
  /** Fired with the chosen `rows`/`cols` (1-based counts). */
  onPick: (rows: number, cols: number) => void;
}

/// TableSizeGrid — the hover-highlight rows×cols grid picker (한글/Office style), EXTRACTED from
/// TableInsertButton (issue 027) so BOTH the top-toolbar 표 추가 button AND the issue-039 background
/// context menu drive the SAME picker (no duplicated grid/label markup). It owns only its own hover
/// highlight; the host wraps it in whatever popover chrome it needs and closes on pick. Every testid /
/// class is byte-identical to the original so 027 tests/e2e stay green.
export function TableSizeGrid({ maxRows = 8, maxCols = 8, onPick }: TableSizeGridProps) {
  const [hover, setHover] = useState<{ r: number; c: number }>({ r: 0, c: 0 });

  const choose = (r: number, c: number) => {
    setHover({ r: 0, c: 0 });
    onPick(r, c);
  };

  return (
    <>
      <div className="hw-tableins-grid" onMouseLeave={() => setHover({ r: 0, c: 0 })}>
        {Array.from({ length: maxRows }, (_, r) =>
          Array.from({ length: maxCols }, (_, c) => {
            const on = r < hover.r && c < hover.c;
            return (
              <button
                key={`${r}-${c}`}
                type="button"
                className={`hw-tableins-cell${on ? " hw-tableins-on" : ""}`}
                data-testid={`hw-table-cell-${r + 1}-${c + 1}`}
                aria-label={`${r + 1}행 ${c + 1}열`}
                onMouseEnter={() => setHover({ r: r + 1, c: c + 1 })}
                onFocus={() => setHover({ r: r + 1, c: c + 1 })}
                onClick={() => choose(r + 1, c + 1)}
              />
            );
          }),
        )}
      </div>
      <div className="hw-tableins-label" data-testid="hw-table-picker-label">
        {hover.r > 0 ? `${hover.r} × ${hover.c} 표` : "행 × 열 선택"}
      </div>
    </>
  );
}
