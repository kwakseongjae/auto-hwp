import { useEffect, useRef } from "react";
import { useWorkspaceMessages } from "../i18n";
import { ChevronDown, ChevronUp, X } from "../icons";

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
  const msg = useWorkspaceMessages();
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
    <div className="hw-find" role="search" aria-label={msg.find.label} data-testid="hw-find">
      <div className="hw-find-row">
        <input
          ref={inputRef}
          className="hw-find-input"
          data-testid="hw-find-input"
          value={query}
          placeholder={msg.find.queryPlaceholder}
          aria-label={msg.find.queryPlaceholder}
          onChange={(e) => onQueryChange(e.currentTarget.value)}
          onKeyDown={onFindKeyDown}
        />
        <span className="hw-find-count" data-testid="hw-find-count" aria-live="polite">
          {busy ? msg.find.searching : !searched ? "" : hasMatches ? `${ordinal}/${count}` : msg.find.noResults}
        </span>
        <button className="hw-find-nav" data-testid="hw-find-prev" title={msg.find.prevTitle} disabled={!hasMatches} onClick={onPrev} aria-label={msg.find.prevLabel}>
          <ChevronUp />
        </button>
        <button className="hw-find-nav" data-testid="hw-find-next" title={msg.find.nextTitle} disabled={!hasMatches} onClick={onNext} aria-label={msg.find.nextLabel}>
          <ChevronDown />
        </button>
        <label className="hw-find-case" title={msg.find.caseSensitive}>
          <input type="checkbox" checked={caseSensitive} onChange={(e) => onCaseToggle(e.currentTarget.checked)} />
          Aa
        </label>
        <button className="hw-find-close" data-testid="hw-find-close" title={msg.find.closeTitle} onClick={onClose} aria-label={msg.find.closeLabel}>
          <X />
        </button>
      </div>
      <div className="hw-find-row">
        <input
          className="hw-find-input"
          data-testid="hw-find-replace-input"
          value={replaceValue}
          placeholder={msg.find.replacePlaceholder}
          aria-label={msg.find.replacePlaceholder}
          disabled={!canReplace}
          onChange={(e) => onReplaceChange(e.currentTarget.value)}
          onKeyDown={onReplaceKeyDown}
        />
        <button className="hw-find-btn" data-testid="hw-find-replace-one" disabled={!canReplace || !hasMatches || busy} title={msg.find.replaceOneTitle} onClick={onReplaceOne}>
          {msg.find.replaceOne}
        </button>
        <button className="hw-find-btn" data-testid="hw-find-replace-all" disabled={!canReplace || !hasMatches || busy} onClick={onReplaceAll}>
          {msg.find.replaceAll}
        </button>
      </div>
      {!supported && <p className="hw-find-note">{msg.find.unsupported}</p>}
      {supported && searched && hasMatches && !canLocate && (
        <p className="hw-find-note">{msg.find.locateUnsupported}</p>
      )}
    </div>
  );
}
