import { useEffect, useRef, useState } from "react";
import { modLabel } from "../platform";
import type { Anchor, Box, DocContext, Intent, IntentCard, OnAiRequest } from "../types";

/// InlineEditPanel — the per-element INLINE vibe-edit surface (issue 06x): an alternative to the right-hand
/// CHAT that happens directly ON the selected element. The user opens it via a small "✨ 여기서 편집"
/// affordance on the selection, types ONE instruction, and on submit the change is APPLIED IMMEDIATELY as
/// ONE undo batch — the element re-renders in place and the panel switches to an "applied" state that
/// summarizes what changed with two buttons: 적용 유지 (keep, close) and 되돌리기 (revert = pop that one
/// batch, close). This is the user's "apply-then-revert" model.
///
/// It reuses the CHAT's exact machinery so the two surfaces stay behaviorally identical (R6): the host
/// `onAiRequest(instruction, [anchor], docContext)` turns the instruction into Intents (same grid/context
/// as the chat — the host builds the 066 table grid from the passed anchor), and `onApply` commits them as
/// ONE batch via `session.applyBatch` (the parent supplies the applied CARDS for the summary, mapped by the
/// SAME `describeIntent` renderer the chat cards use). REVERT calls `core.session.undo()` — the batch is the
/// top of the undo stack immediately after apply.
///
/// It is a pure, individually-importable overlay over own-render PAGE px + a `scale` (same contract as
/// SelectionOverlay/ImageOverlay), anchored directly BELOW the element's box. The revert GUARD (close+keep
/// on any external edit/selection change while the panel is open) lives in the PARENT (HwpWorkspace) — this
/// component only renders the flow and calls back.

export interface InlineEditPanelProps {
  /** The selected element's own-render PAGE px box; the panel anchors directly BELOW it. */
  box: Box;
  /** rendered px / viewBox px for this page — page px × scale = client px (same contract as the overlays). */
  scale: number;
  /** A short human label of the target element (the selection's chip label), shown in the header. */
  targetLabel: string;
  /** The single structural anchor this inline edit targets — rides to `onAiRequest` as `[anchor]` so the
   *  host builds the SAME doc-context/grid the chat would for this spot. */
  anchor: Anchor;
  /** The host AI bridge (R6) — the SAME callback the chat uses. Returns the Intents to apply. */
  onAiRequest: OnAiRequest;
  /** The read-only doc context (built for THIS anchor), passed verbatim to `onAiRequest`. */
  docContext: DocContext;
  /** Apply the returned Intents as ONE undo batch; resolves to the preview cards for the applied summary. */
  onApply: (intents: Intent[]) => Promise<IntentCard[]>;
  /** Revert the applied batch (pops exactly this batch: `core.session.undo`). The panel closes after. */
  onRevert: () => Promise<void>;
  /** Close the panel KEEPING the applied change (적용 유지 / Esc / ✕). */
  onClose: () => void;
  /** Label for the ⌘/Ctrl hint (defaults to a platform-detected label). */
  modLabel?: string;
}

type Phase =
  | { state: "compose" }
  | { state: "busy" }
  | { state: "applied"; cards: IntentCard[] }
  | { state: "error"; text: string };

export function InlineEditPanel(props: InlineEditPanelProps) {
  const [input, setInput] = useState("");
  const [phase, setPhase] = useState<Phase>({ state: "compose" });
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const reverting = useRef(false);
  const mod = props.modLabel ?? modLabel();

  // Focus the composer on open so the user types immediately (like the chat's focus-on-mark).
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Anchor: page px → client px is a uniform `scale` (same as SelectionOverlay). The panel's top-left sits
  // at the element's bottom-left; a small gap is added by CSS so it reads as attached BELOW the element.
  const left = props.box.x * props.scale;
  const top = (props.box.y + props.box.h) * props.scale;

  const busy = phase.state === "busy";

  async function submit() {
    const trimmed = input.trim();
    if (!trimmed || busy) return;
    setPhase({ state: "busy" });
    try {
      // SAME bridge as the chat — anchors = [this selection's anchor] so the grid/context is identical.
      const intents = await props.onAiRequest(trimmed, [props.anchor], props.docContext);
      if (!intents || intents.length === 0) {
        setPhase({ state: "error", text: "제안된 편집이 없습니다." });
        return;
      }
      // APPLY IMMEDIATELY (apply-then-revert): the parent commits ONE undo batch and hands back the cards.
      const cards = await props.onApply(intents);
      setPhase({ state: "applied", cards });
    } catch (e) {
      setPhase({ state: "error", text: `${e}` });
    }
  }

  async function revert() {
    if (reverting.current) return;
    reverting.current = true;
    try {
      await props.onRevert(); // pops exactly this batch (top of the undo stack)
    } finally {
      props.onClose(); // close either way — a failed undo is surfaced by the parent's trap/toast
    }
  }

  return (
    <div
      className="hw-inline-edit"
      data-testid="hw-inline-edit"
      style={{ left, top }}
      // Own every pointer gesture so a click inside the panel never reaches the page sheet (which would
      // deselect / re-select and close the panel via the parent's click-away guard).
      onPointerDown={(e) => e.stopPropagation()}
      role="dialog"
      aria-label="여기서 편집"
    >
      <div className="hw-inline-head">
        <span className="hw-inline-title">✨ 여기서 편집</span>
        <span className="hw-inline-target" title="이 위치만 편집됩니다">
          {props.targetLabel}
        </span>
        <button className="hw-inline-x" onClick={props.onClose} title="닫기 (Esc)" aria-label="닫기">
          ✕
        </button>
      </div>

      {(phase.state === "compose" || phase.state === "busy") && (
        <>
          <textarea
            ref={inputRef}
            className="hw-inline-textarea"
            value={input}
            disabled={busy}
            spellCheck={false}
            placeholder="이 위치를 어떻게 바꿀까요?"
            onChange={(e) => setInput(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                props.onClose();
                return;
              }
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void submit();
              }
            }}
          />
          <div className="hw-inline-actions">
            <span className="hw-inline-hint" title={`Enter 적용 · Shift+Enter 줄바꿈 · Esc 닫기 (${mod})`}>
              Enter로 적용
            </span>
            {busy ? (
              <span className="hw-inline-busy" data-testid="hw-inline-busy" aria-live="polite">
                <span className="hw-dot" />
                <span className="hw-dot" />
                <span className="hw-dot" />
              </span>
            ) : (
              <button className="hw-btn-send hw-inline-send" disabled={!input.trim()} onClick={() => void submit()}>
                적용
              </button>
            )}
          </div>
        </>
      )}

      {phase.state === "applied" && (
        <div className="hw-inline-applied" data-testid="hw-inline-applied">
          <div className="hw-inline-summary">
            <span className="hw-inline-check">✓ 적용됨</span>
            <ul className="hw-inline-cards">
              {phase.cards.map((c, i) => (
                <li key={i} className="hw-inline-card">
                  <span aria-hidden>{c.icon}</span> {c.summary}
                </li>
              ))}
            </ul>
          </div>
          <div className="hw-inline-actions">
            <button className="hw-btn-ghost hw-inline-revert" onClick={() => void revert()} title="이 편집을 취소하고 원래대로">
              되돌리기
            </button>
            <button className="hw-btn-primary hw-inline-keep" onClick={props.onClose}>
              적용 유지
            </button>
          </div>
        </div>
      )}

      {phase.state === "error" && (
        <div className="hw-inline-error" data-testid="hw-inline-error">
          <p className="hw-inline-error-text">{phase.text}</p>
          <div className="hw-inline-actions">
            <button className="hw-btn-ghost" onClick={props.onClose}>
              닫기
            </button>
            <button className="hw-btn-primary" onClick={() => setPhase({ state: "compose" })}>
              다시 시도
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
