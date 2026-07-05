import { useEffect, useRef } from "react";

export interface FindBarProps {
  /** The current 찾을 내용 value (controlled by the workspace). */
  query: string;
  /** The current 바꿀 내용 value. */
  replaceValue: string;
  /** Case-sensitivity toggle state. */
  caseSensitive: boolean;
  /** Total matches from the last search, or null when no search has run for the current query (the "n/m"
   *  readout is hidden until a search runs — typing invalidates it, matching the desktop bar). */
  count: number | null;
  /** 1-based ordinal of the current match (0 when none). */
  ordinal: number;
  /** A search / replace is in flight (shows a spinner, disables submit). */
  busy?: boolean;
  /** Whether the backend supports find at all (a lean build may omit it → an inline "지원하지 않음" note). */
  supported: boolean;
  /** Whether the document is editable (gates the 바꾸기 field + buttons). */
  canReplace: boolean;
  /** Whether match geometry is resolvable (drives a subtle "위치 표시 불가" hint when false + matches>0). */
  canLocate: boolean;
  /** Bumped by the workspace on every ⌘F press so a re-press RE-focuses + selects the query field. */
  focusToken?: number;
  onQueryChange: (v: string) => void;
  onReplaceChange: (v: string) => void;
  onCaseToggle: (v: boolean) => void;
  /** Run a fresh search (the 찾기 button / Enter when the query changed). */
  onSearch: () => void;
  /** Go to the next / previous match (Enter / Shift+Enter / the chevrons). */
  onNext: () => void;
  onPrev: () => void;
  /** Replace the first match / every match. */
  onReplaceOne: () => void;
  onReplaceAll: () => void;
  /** Close the bar (Esc / the ✕). */
  onClose: () => void;
}

/// FindBar — the ⌘F 찾기/바꾸기 capsule (issue 045), a top-right overlay over the document (it owns the
/// keyboard-effect + top-area surface; it never touches the 046 sidebar/status-bar containers). Purely
/// presentational: the workspace owns the FindController + the match geometry/scroll; this renders the
/// state and forwards intent. Enter = 다음, Shift+Enter = 이전, Esc = 닫기; the "n/m" readout appears once a
/// search has run for the current query.
export function FindBar(props: FindBarProps) {
  const {
    query, replaceValue, caseSensitive, count, ordinal, busy, supported, canReplace, canLocate, focusToken,
    onQueryChange, onReplaceChange, onCaseToggle, onSearch, onNext, onPrev, onReplaceOne, onReplaceAll, onClose,
  } = props;
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus + select the query field on mount AND on every ⌘F re-press (focusToken bump), so the user types
  // immediately and a re-press re-selects the current query.
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusToken]);

  const hasMatches = (count ?? 0) > 0;
  const searched = count !== null;

  // Enter in the 찾을 내용 field: go to the next match when the current query is already searched, else run a
  // fresh search. Shift+Enter steps back. Esc closes the bar — stopPropagation so it doesn't bubble to the
  // window Esc-clears-selection listener (021).
  const onFindKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) {
        if (hasMatches) onPrev();
      } else if (searched && hasMatches) {
        onNext();
      } else {
        onSearch();
      }
    }
  };

  const onReplaceKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (canReplace) onReplaceOne();
    }
  };

  return (
    <div className="hw-find" role="search" aria-label="찾기 및 바꾸기" data-testid="hw-find">
      <div className="hw-find-row">
        <input
          ref={inputRef}
          className="hw-find-input"
          data-testid="hw-find-input"
          value={query}
          placeholder="찾을 내용"
          aria-label="찾을 내용"
          onChange={(e) => onQueryChange(e.currentTarget.value)}
          onKeyDown={onFindKeyDown}
        />
        <span className="hw-find-count" data-testid="hw-find-count" aria-live="polite">
          {busy ? "찾는 중…" : !searched ? "" : hasMatches ? `${ordinal}/${count}` : "결과 없음"}
        </span>
        <button className="hw-find-nav" data-testid="hw-find-prev" title="이전 (Shift+Enter)" disabled={!hasMatches} onClick={onPrev} aria-label="이전 일치">
          ↑
        </button>
        <button className="hw-find-nav" data-testid="hw-find-next" title="다음 (Enter)" disabled={!hasMatches} onClick={onNext} aria-label="다음 일치">
          ↓
        </button>
        <label className="hw-find-case" title="대소문자 구분">
          <input type="checkbox" checked={caseSensitive} onChange={(e) => onCaseToggle(e.currentTarget.checked)} />
          Aa
        </label>
        <button className="hw-find-close" data-testid="hw-find-close" title="닫기 (Esc)" onClick={onClose} aria-label="닫기">
          ✕
        </button>
      </div>
      <div className="hw-find-row">
        <input
          className="hw-find-input"
          data-testid="hw-find-replace-input"
          value={replaceValue}
          placeholder="바꿀 내용"
          aria-label="바꿀 내용"
          disabled={!canReplace}
          onChange={(e) => onReplaceChange(e.currentTarget.value)}
          onKeyDown={onReplaceKeyDown}
        />
        <button className="hw-find-btn" data-testid="hw-find-replace-one" disabled={!canReplace || !hasMatches || busy} title="문서의 첫 일치 항목을 바꿉니다" onClick={onReplaceOne}>
          바꾸기
        </button>
        <button className="hw-find-btn" data-testid="hw-find-replace-all" disabled={!canReplace || !hasMatches || busy} onClick={onReplaceAll}>
          모두 바꾸기
        </button>
      </div>
      {!supported && <p className="hw-find-note">이 문서에서는 찾기를 사용할 수 없습니다.</p>}
      {supported && searched && hasMatches && !canLocate && (
        <p className="hw-find-note">일치 항목 위치 강조는 이 백엔드에서 지원되지 않습니다 (개수·이동은 동작).</p>
      )}
    </div>
  );
}
