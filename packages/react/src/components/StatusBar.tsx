export interface StatusBarProps {
  /** The page currently at the top of the viewport (0-based) — the SAME scroll-position value the outline
   *  panel highlights (issue 046). Rendered 1-based. */
  currentPage: number;
  /** Total page count of the live document (re-queried after edits re-paginate). */
  pageCount: number;
  /** A short summary of the current selection (reuses the anchor label — e.g. "3행 2열" or "2개 선택"),
   *  or null when nothing is selected. */
  selectionSummary?: string | null;
  /** Whether the manual editing chrome is enabled — drives the 편집/읽기 badge (issue 046). */
  editing: boolean;
  /** Whether the open document is editable at all (a binary .hwp with no anchor is read-only). */
  canEdit: boolean;
}

/// StatusBar — the thin bottom bar (issue 046, TAURI-CONVERGENCE U1 승격): current page / total (a
/// scroll-position readout), the selection summary (reusing the anchor label — no new arithmetic), and the
/// edit-mode badge. The ZOOM % is deliberately ABSENT — it is owned by the top toolbar (issue 046: 중복
/// 금지). Pure presentational (SDK-LAYERS L3): the parent passes the resolved values.
export function StatusBar(props: StatusBarProps) {
  const { currentPage, pageCount, selectionSummary, editing, canEdit } = props;
  const page = pageCount > 0 ? Math.min(currentPage, pageCount - 1) + 1 : 0;
  const badge = !canEdit ? "읽기 전용" : editing ? "편집 모드" : "보기 모드";
  return (
    <div className="hw-statusbar" data-testid="hw-statusbar" role="status">
      <span className="hw-statusbar-page" data-testid="hw-statusbar-page">
        {pageCount > 0 ? `${page} / ${pageCount}쪽` : "문서 없음"}
      </span>
      {selectionSummary && (
        <span className="hw-statusbar-sel" data-testid="hw-statusbar-selection">
          {selectionSummary}
        </span>
      )}
      <span className="hw-statusbar-spacer" />
      <span
        className={`hw-statusbar-mode${canEdit && editing ? " hw-statusbar-mode-on" : ""}`}
        data-testid="hw-statusbar-mode"
      >
        {badge}
      </span>
    </div>
  );
}
