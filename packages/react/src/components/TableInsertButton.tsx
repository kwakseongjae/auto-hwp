import { useState } from "react";

export interface TableInsertButtonProps {
  /** Max rows/cols the grid picker offers. Default 8×8. */
  maxRows?: number;
  maxCols?: number;
  /** Disable the button (no document open). */
  disabled?: boolean;
  /** Fired with the chosen `rows`/`cols` (1-based counts). The host calls `core.edit.insertTable`. */
  onPick: (rows: number, cols: number) => void;
}

/// TableInsertButton — the opt-in "표 추가" toolbar control (issue 027 step 2): a button that opens a
/// hover-highlight rows×cols grid picker (한글/Office style). Picking a cell fires `onPick(rows, cols)`;
/// the host appends an empty table via `core.edit.insertTable` (ApplyContent). Individually importable —
/// a host can drop it into any toolbar without HwpWorkspace. All copy is Korean.
export function TableInsertButton({ maxRows = 8, maxCols = 8, disabled, onPick }: TableInsertButtonProps) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState<{ r: number; c: number }>({ r: 0, c: 0 });

  const choose = (r: number, c: number) => {
    setOpen(false);
    setHover({ r: 0, c: 0 });
    onPick(r, c);
  };

  return (
    <div className="hw-tableins">
      <button
        className="hw-tool"
        disabled={disabled}
        title="표 추가"
        aria-haspopup="true"
        aria-expanded={open}
        data-testid="hw-table-insert"
        onClick={() => setOpen((o) => !o)}
      >
        표 추가
      </button>
      {open && (
        <div className="hw-tableins-pop" role="dialog" aria-label="표 크기 선택" data-testid="hw-table-picker">
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
        </div>
      )}
    </div>
  );
}
