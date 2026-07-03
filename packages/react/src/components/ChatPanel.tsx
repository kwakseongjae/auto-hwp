import { useEffect, useRef, useState } from "react";
import { describeIntent } from "../describeIntent";
import { modLabel } from "../platform";
import type { Anchor, DocContext, Intent, IntentCard, OnAiRequest } from "../types";

export interface ChatPanelProps {
  /** Whether editing is possible (a document is open + editable). */
  canEdit: boolean;
  /** Marked anchor chips (issue #009) that ride along with the next prompt. */
  anchors: Anchor[];
  /** Remove the i-th anchor chip. */
  onRemoveAnchor: (i: number) => void;
  /** Clear ALL anchor chips ("모두 지우기"). Optional — when omitted the button is hidden. */
  onClearAnchors?: () => void;
  /** Label for the additive/toggle modifier key ("⌘"/"Ctrl") in the hint tooltip. Defaults to a
   *  platform-detected label. */
  modLabel?: string;
  /** The host AI bridge (R6). The package never calls an LLM — this returns the Intents to preview. */
  onAiRequest: OnAiRequest;
  /** Read-only doc context passed to `onAiRequest`. */
  docContext: DocContext;
  /** Apply the previewed Intents (commit). Resolves to how many were applied. */
  onApply: (intents: Intent[]) => Promise<number>;
  /** Consume (clear) the marked anchors once a prompt has ridden them along. */
  onConsumeAnchors: () => void;
  /** Jump the page view to `page` (preview card link). Optional. */
  onJumpToPage?: (page: number) => void;
  /** Show the honest "mock/demo" badge (host passes true when `onAiRequest` returns canned Intents). */
  isMock?: boolean;
  /** A monotonically-bumped token; when it CHANGES the composer is focused + scrolled into view. The
   *  floating toolbar's "AI에게 전달" bumps it (issue 028) — the marked selection is already the anchor
   *  chip, so this just brings the user to the composer. No new prompt logic. */
  focusToken?: number;
}

// One assistant turn carries the previewed Intents (rendered as per-op CARDS); `state` tracks review.
type Msg =
  | { role: "user"; text: string }
  | { role: "assistant"; state: "applied" | "discarded" | "pending"; intents: Intent[]; cards: IntentCard[]; page: number | null }
  | { role: "assistant"; state: "error"; text: string };

// Reusable prompt chips — the empty-state suggestions (fill the input so the user can tweak).
const PROMPT_CHIPS = ["이 칸을 채워줘", "이 표에 행 하나 추가해줘", "이 문단을 다듬어줘"];

/** A structured per-op preview CARD (010식): op icon + label + target chip + summary + jump link. */
function OpCard({ card, page, onJump }: { card: IntentCard; page: number | null; onJump?: (page: number) => void }) {
  return (
    <div className="hw-card">
      <div className="hw-card-head">
        <span className="hw-card-icon">{card.icon}</span>
        <span className="hw-card-label">{card.label}</span>
        {card.section !== null && (
          <span className="hw-card-target" title="편집 대상 위치 (섹션/블록)">
            s{card.section}
            {card.block !== null ? `·b${card.block}` : ""}
          </span>
        )}
      </div>
      <p className="hw-card-summary">{card.summary}</p>
      {page !== null && onJump && (
        <button className="hw-card-jump" onClick={() => onJump(page)} title="이 편집이 적용되는 쪽으로 이동">
          ↪ p.{page + 1}로 이동
        </button>
      )}
    </div>
  );
}

/// ChatPanel — the PRIMARY editing surface (issue 016 step 2). The user POINTS at the document (a click
/// captures an anchor chip) and says what they want; the host's `onAiRequest` returns Intents, shown as
/// reviewable per-op CARDS with 적용/취소. Applying commits through the adapter (via `onApply`). The AI
/// is fully DELEGATED to the host callback — this package holds no LLM client and no key (R6).
export function ChatPanel(props: ChatPanelProps) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const last = msgs[msgs.length - 1];
  const awaiting = last?.role === "assistant" && last.state === "pending";
  const mod = props.modLabel ?? modLabel();

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight; // scrollTop is settable everywhere (scrollTo isn't in jsdom)
  }, [msgs, busy]);

  // "AI에게 전달" (issue 028): focus the composer when the token bumps. Skip the initial mount (token 0/
  // undefined) so opening the workspace doesn't steal focus. The marked selection is already shown as an
  // anchor chip above — this only routes the user to the composer to type.
  const focusToken = props.focusToken;
  const firstFocus = useRef(true);
  useEffect(() => {
    if (firstFocus.current) {
      firstFocus.current = false;
      return;
    }
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.scrollIntoView?.({ block: "nearest" });
  }, [focusToken]);

  function settleLast(state: "applied" | "discarded") {
    setMsgs((m) => {
      const copy = m.slice();
      for (let i = copy.length - 1; i >= 0; i--) {
        const c = copy[i];
        if (c.role === "assistant" && c.state === "pending") {
          copy[i] = { ...c, state };
          break;
        }
      }
      return copy;
    });
  }

  async function send(text: string) {
    if (busy || awaiting) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    const anchors = props.anchors;
    const page = anchors.length ? anchors[0].page : null;
    const where = anchors.length ? ` (대상: ${anchors.map((a) => a.label).join(", ")})` : "";
    setInput("");
    setMsgs((m) => [...m, { role: "user", text: trimmed + where }]);
    setBusy(true);
    try {
      const intents = await props.onAiRequest(trimmed, anchors, props.docContext);
      props.onConsumeAnchors(); // the chips have ridden along — clear them (issue #009)
      if (!intents || intents.length === 0) {
        setMsgs((m) => [...m, { role: "assistant", state: "error", text: "제안된 편집이 없습니다." }]);
      } else {
        const cards = intents.map(describeIntent);
        setMsgs((m) => [...m, { role: "assistant", state: "pending", intents, cards, page }]);
      }
    } catch (e) {
      setMsgs((m) => [...m, { role: "assistant", state: "error", text: `${e}` }]);
    } finally {
      setBusy(false);
    }
  }

  async function apply(intents: Intent[]) {
    setBusy(true);
    try {
      const applied = await props.onApply(intents);
      settleLast("applied");
      void applied;
    } catch (e) {
      setMsgs((m) => [...m, { role: "assistant", state: "error", text: `적용 실패: ${e}` }]);
    } finally {
      setBusy(false);
    }
  }
  function reject() {
    settleLast("discarded");
  }

  return (
    <aside className="hw-chat">
      <div className="hw-chat-head">
        <span className="hw-chat-title">✦ 바이브 편집</span>
        <span className="hw-chat-sub">· 가리키고 말하세요</span>
      </div>

      {props.isMock && (
        <div className="hw-mock-badge">
          ⚠️ 데모 모드(mock): 실제 이해 없이 예시 편집만 보여줍니다. 실제 편집은 호스트가 서버사이드 AI를 <code>onAiRequest</code>에 연결해야 합니다.
        </div>
      )}

      <div className="hw-chat-list" ref={listRef}>
        {msgs.length === 0 && (
          <div className="hw-empty">
            <p>
              문서의 한 곳을 <b>클릭해서 가리키고</b>, 무엇을 바꿀지 말하세요.
            </p>
            <div className="hw-chip-row">
              {PROMPT_CHIPS.map((c) => (
                <button
                  key={c}
                  className="hw-chip"
                  disabled={!props.canEdit || busy || awaiting}
                  onClick={() => {
                    setInput(c);
                    inputRef.current?.focus();
                  }}
                >
                  {c}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="hw-msgs">
          {msgs.map((m, i) =>
            m.role === "user" ? (
              <div key={i} className="hw-msg-user">
                {m.text}
              </div>
            ) : m.state === "error" ? (
              <div key={i} className="hw-msg-error">
                {m.text}
              </div>
            ) : (
              <div key={i} className="hw-msg-assistant">
                <div className="hw-cards">
                  {m.cards.map((card, j) => (
                    <OpCard key={j} card={card} page={m.page} onJump={props.onJumpToPage} />
                  ))}
                </div>
                {m.state === "pending" && (
                  <div className="hw-review">
                    <button className="hw-btn-primary" disabled={busy} onClick={() => apply(m.intents)}>
                      ✓ 적용
                    </button>
                    <button className="hw-btn-ghost" disabled={busy} onClick={reject}>
                      취소
                    </button>
                  </div>
                )}
                {m.state === "applied" && <div className="hw-applied">✓ 적용됨</div>}
                {m.state === "discarded" && <div className="hw-discarded">취소됨</div>}
              </div>
            ),
          )}
          {busy && !awaiting && (
            <div className="hw-typing">
              <span className="hw-dot" />
              <span className="hw-dot" />
              <span className="hw-dot" />
            </div>
          )}
        </div>
      </div>

      <div className="hw-composer">
        {!props.canEdit && <p className="hw-composer-hint">편집하려면 먼저 문서를 여세요.</p>}
        {props.anchors.length > 0 && (
          <div className="hw-anchors-wrap">
            <div className="hw-anchors-head">
              <span className="hw-anchors-hint" title={`클릭: 선택 교체 · ${mod}+클릭: 선택 추가/토글 · 빈 곳 드래그: 영역 선택`}>
                {props.anchors.length}개 선택됨
              </span>
              {props.onClearAnchors && (
                <button className="hw-anchors-clear" onClick={props.onClearAnchors} title="선택 모두 해제 (Esc)">
                  모두 지우기
                </button>
              )}
            </div>
            <div className="hw-anchors">
              {props.anchors.map((a, i) => (
                <span key={`${a.section}:${a.block}:${i}`} className="hw-anchor" title={`대상 [s${a.section}/b${a.block}] — 이 위치만 편집됩니다`}>
                  <span aria-hidden>◆</span>
                  {a.label}
                  <button className="hw-anchor-x" onClick={() => props.onRemoveAnchor(i)} title="이 대상 제거">
                    ✕
                  </button>
                </span>
              ))}
            </div>
          </div>
        )}
        <div className="hw-composer-row">
          <textarea
            ref={inputRef}
            className="hw-textarea"
            value={input}
            disabled={!props.canEdit || busy || awaiting}
            spellCheck={false}
            placeholder={awaiting ? "위 제안을 적용/취소한 뒤 계속하세요" : props.anchors.length ? "이 위치를 어떻게 바꿀까요?" : "무엇을 바꿀까요? (문서를 클릭해 위치 지정)"}
            onChange={(e) => setInput(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send(input);
              }
            }}
          />
          <button className="hw-btn-send" disabled={!props.canEdit || busy || awaiting || !input.trim()} onClick={() => void send(input)}>
            {busy ? "…" : "보내기"}
          </button>
        </div>
      </div>
    </aside>
  );
}
