import type { PageBox } from "../coords";

/** The preset background swatches (mirrors the desktop R7 배경색 palette / RANGE_BG). */
const SWATCHES = ["#D8D8D8", "#CCCCCC", "#EEEEEE", "#E3F2FD", "#E8F5E9", "#FFF9C4", "#FCE4EC"] as const;

export interface CellShadePaletteProps {
  /** The EDITING cell's box in own-render PAGE px (the palette anchors just above/below it). */
  box: PageBox;
  /** rendered px / viewBox px for the page (page px × scale = client px) — the SAME scale the editor uses. */
  scale: number;
  /** Apply a background shade (`"#RRGGBB"`) or clear it (`null`) to the editing cell. The host applies it as
   *  a 1-cell `SetCellRangeShade` on the CURRENTLY-edited cell while the editor stays open (issue 047 목표 3
   *  — 편집 중 셀음영). */
  onPick: (hex: string | null) => void;
}

/// CellShadePalette — the issue-047 편집 중 셀음영 control: a tiny swatch bar shown WHILE the in-place cell
/// editor is open, so the current cell's background can be set without leaving edit mode (desktop R7-Part1
/// parity). THE CRITICAL DETAIL: every control `preventDefault`s its mousedown so clicking a swatch does NOT
/// blur the contentEditable editor — a blur would fire the editor's commit (교훈: "배경색 안 열려 during
/// edit"). The host wires `onPick` to a shielded shade apply that keeps the editor open (the shade op does
/// not touch the cell's text runs, so the uncommitted edit survives — see the op-bus SetTableCell note). It
/// sits over the editor's cell rect at the same page `scale`, flipping below the cell when it's near the top.
export function CellShadePalette({ box, scale, onPick }: CellShadePaletteProps) {
  const left = box.x * scale;
  const topOfCell = box.y * scale;
  // Place the bar ABOVE the cell; if there's no room (near the page top) flip it just BELOW the cell.
  const above = topOfCell >= 34;
  const top = above ? topOfCell - 30 : topOfCell + box.h * scale + 4;
  // Keep the editor focused: a mousedown that reaches the document would blur→commit the contentEditable.
  const keepFocus = (e: React.MouseEvent) => e.preventDefault();

  return (
    <div
      className="hw-cellshade"
      data-testid="hw-cell-shade-palette"
      style={{ left, top }}
      // Swallow pointerdown so the sheet's selection handlers don't fire beneath the palette.
      onPointerDown={(e) => e.stopPropagation()}
    >
      {SWATCHES.map((c) => (
        <button
          key={c}
          type="button"
          className="hw-cellshade-swatch"
          data-testid={`hw-cell-shade-${c}`}
          title={c}
          style={{ backgroundColor: c }}
          onMouseDown={keepFocus}
          onClick={() => onPick(c)}
        />
      ))}
      {/* 사용자 지정 — OS color picker (continuous spectrum). */}
      <label className="hw-cellshade-custom" title="사용자 지정 색" onMouseDown={keepFocus}>
        <input
          type="color"
          data-testid="hw-cell-shade-custom"
          defaultValue="#ffff00"
          onChange={(e) => onPick(e.target.value)}
        />
      </label>
      <button
        type="button"
        className="hw-cellshade-clear"
        data-testid="hw-cell-shade-clear"
        title="배경색 지움"
        onMouseDown={keepFocus}
        onClick={() => onPick(null)}
      >
        지움
      </button>
    </div>
  );
}
