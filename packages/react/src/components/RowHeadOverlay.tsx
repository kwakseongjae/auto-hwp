import { useWorkspaceMessages } from "../i18n";

/// RowHeadOverlay — 표의 **행 머리**(이슈 2). 스프레드시트처럼 표 왼쪽 바깥에 행마다 좁은 클릭 타깃을
/// 두어, 한 번 클릭하면 그 행 전체가 `kind:"range"` 앵커("표 8행 전체")로 마킹되고 shift-클릭하면 행
/// 범위로 자란다. 종전에는 표 위 클릭=표 전체 / 더블클릭=셀 하나 뿐이라 **행을 가리킬 방법이 없었고**,
/// 셀 마킹조차 더블클릭이라는 숨은 제스처에만 있었다(어포던스 0). 이 레이어가 그 두 구멍을 눈에 보이게
/// 만든다.
///
/// 좌표 계약은 다른 오버레이와 동일하다 — 입력은 own-render PAGE px, `scale` 로 클라이언트 px 로 간다
/// (SelectionOverlay/ColumnResizeOverlay 와 같은 프레임: `.hw-sheet-wrap`).

export interface RowHeadOverlayProps {
  /** The table fragment's `rows + 1` row-boundary y-positions in own-render PAGE px (page-local). */
  boundaries: number[];
  /** The table box's LEFT edge in own-render PAGE px — the heads sit just outside it. */
  left: number;
  /** MODEL-GLOBAL row index of the fragment's FIRST row (`TableBox.first_row`) — a split table's second
   *  fragment starts at a non-zero row, and the anchor must name the GLOBAL row. */
  firstRow: number;
  /** rendered px / viewBox px for this page. */
  scale: number;
  /** Width of the head strip in own-render PAGE px. */
  widthPx?: number;
  /** MODEL-GLOBAL rows currently marked (inclusive) — drawn as the active heads. */
  active?: [number, number] | null;
  /** Click a head: select that whole row (`extend` = shift-click → grow the row span). */
  onSelectRow: (row: number, extend: boolean) => void;
}

export function RowHeadOverlay({ boundaries, left, firstRow, scale, widthPx = 12, active, onSelectRow }: RowHeadOverlayProps) {
  const msg = useWorkspaceMessages();
  if (boundaries.length < 2) return null;
  return (
    <div className="hw-row-heads" data-testid="hw-row-heads">
      {boundaries.slice(0, -1).map((y, i) => {
        const row = firstRow + i;
        const on = !!active && row >= active[0] && row <= active[1];
        return (
          <button
            key={row}
            type="button"
            className={on ? "hw-row-head hw-row-head-active" : "hw-row-head"}
            data-testid={`hw-row-head-${row}`}
            aria-label={msg.table.rowHeadLabel(row + 1)}
            title={msg.table.rowHeadTitle}
            style={{
              left: (left - widthPx) * scale,
              top: y * scale,
              width: widthPx * scale,
              height: (boundaries[i + 1] - y) * scale,
            }}
            // A head click must never reach the sheet (that would re-mark the table under it).
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onSelectRow(row, e.shiftKey);
            }}
          >
            <span className="hw-row-head-n">{row + 1}</span>
          </button>
        );
      })}
    </div>
  );
}
