import { useState } from "react";
import { TableSizeGrid } from "./TableSizeGrid";

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
/// a host can drop it into any toolbar without HwpWorkspace. All copy is Korean. The picker grid itself
/// is the shared `TableSizeGrid` (issue 039: the same picker also powers the background context menu).
export function TableInsertButton({ maxRows = 8, maxCols = 8, disabled, onPick }: TableInsertButtonProps) {
  const [open, setOpen] = useState(false);

  const choose = (r: number, c: number) => {
    setOpen(false);
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
          <TableSizeGrid maxRows={maxRows} maxCols={maxCols} onPick={choose} />
        </div>
      )}
    </div>
  );
}
