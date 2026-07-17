import { useEffect, useRef, useState } from "react";
import { describeIntent } from "../describeIntent";
import { modLabel } from "../platform";
import type { AgentEvent, Anchor, Attachment, ChatTurn, Citation, DocContext, Intent, IntentCard, OnAiRequest } from "../types";

// Multimodal chat input (attachments are CONTEXT, not a new Intent). Text-like documents are extracted
// CLIENT-SIDE (FileReader.readAsText — no deps); binary formats (HWP/HWPX/PDF/DOCX) are NOT extracted here
// (a clean extractor would need a wasm text export or a binary-parser dep — out of scope for this JS-only
// change), so they attach with an honest UI note and carry no text (never sent as empty).
const TEXT_EXT = /\.(txt|text|md|markdown|csv|tsv|json|log|xml|html?|rtf|yml|yaml)$/i;
const UNSUPPORTED_NOTE = "이 형식은 아직 텍스트 추출 미지원 — 텍스트(.txt)·이미지로 첨부하세요";

let attachSeq = 0;
function nextAttachId(): string {
  attachSeq += 1;
  return `att-${Date.now().toString(36)}-${attachSeq}`;
}

function isTextLike(file: File): boolean {
  return file.type.startsWith("text/") || TEXT_EXT.test(file.name);
}

function readAs(file: File, how: "dataURL" | "text"): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(fr.error ?? new Error("파일 읽기 실패"));
    fr.onload = () => resolve(typeof fr.result === "string" ? fr.result : "");
    if (how === "dataURL") fr.readAsDataURL(file);
    else fr.readAsText(file);
  });
}

/** Turn a picked/pasted File into an Attachment: IMAGE → base64 dataUrl (vision), text-like DOC → extracted
 *  text, other binary DOC → an honest "미지원" note (no text; never sent as empty). Pure per-file — the
 *  caller appends to state (respecting the count cap). */
async function fileToAttachment(file: File): Promise<Attachment> {
  const base = { id: nextAttachId(), name: file.name || "attachment", mime: file.type || "application/octet-stream", size: file.size };
  if (file.type.startsWith("image/")) {
    return { ...base, kind: "image", dataUrl: await readAs(file, "dataURL") };
  }
  if (isTextLike(file)) {
    return { ...base, kind: "doc", text: await readAs(file, "text") };
  }
  return { ...base, kind: "doc", note: UNSUPPORTED_NOTE };
}

/** Human-readable byte size for a doc chip. */
function fmtSize(bytes: number | undefined): string {
  if (!bytes || bytes < 1024) return `${bytes ?? 0}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

const MAX_ATTACHMENTS = 8;

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
  /** OPTIONAL informational banner shown at the top of the panel — e.g. a static demo explaining that
   *  AI editing needs a locally-run host (BYOK). Plain text; rendered like the mock badge. */
  aiNotice?: string;
  /** A monotonically-bumped token; when it CHANGES the composer is focused + scrolled into view. The
   *  floating toolbar's "AI에게 전달" bumps it (issue 028) — the marked selection is already the anchor
   *  chip, so this just brings the user to the composer. No new prompt logic. */
  focusToken?: number;
  /** OPTIONAL async card builder (issue 051): maps the proposed Intents → enriched preview cards —
   *  the host wires `EditController.previewCards` so a DeleteBlock card carries the target block's
   *  ORIGINAL text (`detail`) + the `destructive` flag. Omitted → the pure `describeIntent` mapping
   *  (backward compatible). Applying is ALWAYS behind the explicit 적용 button either way. */
  previewCards?: (intents: Intent[]) => Promise<IntentCard[]>;
  /** PERSISTENT per-card 되돌리기 (Feature C): revert the TOP-of-stack applied batch (host wires
   *  `core.session.undo()`), resolving `true` when a batch was reverted. Omitted → no per-card revert
   *  button (backward compatible; the global ⌘Z / toolbar ↶ still exist). v1 is honest top-of-stack only:
   *  the button is shown on every APPLIED turn but ENABLED only for the batch currently on top; earlier
   *  batches are disabled with a tooltip until the ones above them are reverted (never silently reverts the
   *  wrong batch). */
  onRevert?: () => Promise<boolean>;
  /** The LIVE undo-stack depth getter (Feature C): paired with `onRevert`. The panel records each applied
   *  turn's depth-after-apply and compares it to this live value to know if that batch is still top-of-
   *  stack. A getter (not a value) so it reflects the session even across a global undo/redo. */
  undoDepth?: () => number;
}

/** How many prior chat turns ride along as CONVERSATION MEMORY (bounded — context-window discipline). Each
 *  prior user prompt + a compact digest of the assistant's proposal is folded into the model's context so a
 *  follow-up ("이제 그 표에 행 하나 더") is understood; the host bounds it again server-side. */
const MEMORY_TURNS = 6;

// One TIMELINE step in the live agentic process (THINKING TRANSPARENCY): a phase change, a growing chunk of
// the model's reasoning, or a web search (its query + the sources it found). Derived from the AgentEvent
// stream by `reduceStep`; rendered above the eventual op-cards.
type AgentStep =
  | { kind: "status"; phase: "thinking" | "searching" | "composing" }
  | { kind: "reasoning"; text: string }
  | { kind: "search"; query: string; done: boolean; citations?: Citation[] };

/** Fold ONE AgentEvent into the running step list (pure). `thinking_delta` grows the trailing reasoning
 *  step; `tool_call`(web_search) opens a search step; `tool_result` closes the latest open search + folds
 *  its citations in; `status` appends a phase label (deduped). `intents`/`error` are terminal — handled by
 *  send(), not here. */
function reduceStep(steps: AgentStep[], ev: AgentEvent): AgentStep[] {
  const next = steps.slice();
  const last = next[next.length - 1];
  switch (ev.type) {
    case "status":
      if (last && last.kind === "status" && last.phase === ev.phase) return steps; // dedupe consecutive
      next.push({ kind: "status", phase: ev.phase });
      return next;
    case "thinking_delta":
      if (last && last.kind === "reasoning") {
        next[next.length - 1] = { kind: "reasoning", text: last.text + ev.text };
        return next;
      }
      next.push({ kind: "reasoning", text: ev.text });
      return next;
    case "tool_call": {
      if (ev.tool !== "web_search") return steps;
      const a = ev.args as { query?: unknown } | undefined;
      const query = a && typeof a.query === "string" ? a.query : "";
      next.push({ kind: "search", query, done: false });
      return next;
    }
    case "tool_result": {
      if (ev.tool !== "web_search") return steps;
      for (let i = next.length - 1; i >= 0; i--) {
        const s = next[i];
        if (s.kind === "search" && !s.done) {
          next[i] = { ...s, done: true, citations: ev.citations };
          return next;
        }
      }
      return steps;
    }
    default:
      return steps;
  }
}

/** A human label for a status phase (Korean, shown as a timeline step). */
function statusLabel(phase: "thinking" | "searching" | "composing"): string {
  return phase === "searching" ? "웹 검색 중…" : phase === "composing" ? "편집 구성 중…" : "생각하는 중…";
}

/** Build the bounded CONVERSATION MEMORY window from prior chat messages (before the new user turn is
 *  pushed). A user message rides as-is; a settled assistant turn rides as a compact digest of its proposed
 *  edits (never raw Intent JSON — that lane stays the emit_intents tool). Thinking/error turns are skipped. */
function turnsFromMsgs(msgs: Msg[], max: number): ChatTurn[] {
  const turns: ChatTurn[] = [];
  for (const m of msgs) {
    if (m.role === "user") {
      turns.push({ role: "user", text: m.text });
    } else if (m.role === "assistant" && m.state !== "error" && m.state !== "thinking") {
      const summary = m.cards.length ? m.cards.map((c) => c.summary).join("; ") : "제안된 편집 없음";
      turns.push({ role: "assistant", text: `제안: ${summary}` });
    }
  }
  return turns.slice(-max);
}

// One assistant turn. `state` tracks its lifecycle:
//   - "thinking" — the live agentic process is streaming; `steps` is the growing TIMELINE (what it's
//                  searching, what it found, its reasoning) shown above the eventual op-cards.
//   - "pending"  — the process finished with proposed Intents (rendered as per-op CARDS) awaiting 적용/취소.
//   - "empty"    — the process finished with NO proposed edits (timeline stays visible).
//   - applied/discarded/reverted — the review outcomes.
// `steps` (agentic streaming) is the AgentEvent-derived timeline (empty for a non-streaming host — then only
// the cards render, back-compat). `appliedDepth` (Feature C) is the undo-stack depth captured right after
// applying — the turn's batch is still top-of-stack ⇔ this equals the live `undoDepth()`. `citations`
// (web grounding) are the sources folded into the timeline's search step.
type Msg =
  | { role: "user"; text: string }
  | {
      role: "assistant";
      state: "thinking" | "applied" | "discarded" | "pending" | "reverted" | "empty";
      steps: AgentStep[];
      intents: Intent[];
      cards: IntentCard[];
      page: number | null;
      appliedDepth?: number;
      citations?: Citation[];
    }
  | { role: "assistant"; state: "error"; text: string };

/** The steps-bearing assistant turn variant (everything except the `error` message variant). */
type AssistantMsg = Extract<Msg, { role: "assistant"; steps: AgentStep[] }>;

// Reusable prompt chips — the empty-state suggestions (fill the input so the user can tweak).
const PROMPT_CHIPS = ["이 칸을 채워줘", "이 표에 행 하나 추가해줘", "이 문단을 다듬어줘"];

/** A structured per-op preview CARD (010식): op icon + label + target chip + summary + jump link.
 *  Issue 051: a DESTRUCTIVE card (DeleteBlock) renders as a warning card and shows the target block's
 *  ORIGINAL text (`detail`) so the user approves knowing exactly what would be removed. */
function OpCard({ card, page, onJump }: { card: IntentCard; page: number | null; onJump?: (page: number) => void }) {
  return (
    <div className={card.destructive ? "hw-card hw-card-danger" : "hw-card"}>
      <div className="hw-card-head">
        <span className="hw-card-icon">{card.icon}</span>
        <span className="hw-card-label">{card.label}</span>
        {card.destructive && (
          <span className="hw-card-danger-badge" title="이 편집은 문서 내용을 삭제합니다 — 명시 승인 후에만 적용됩니다">
            삭제
          </span>
        )}
        {card.section !== null && (
          <span className="hw-card-target" title="편집 대상 위치 (섹션/블록)">
            s{card.section}
            {card.block !== null ? `·b${card.block}` : ""}
          </span>
        )}
      </div>
      <p className="hw-card-summary">{card.summary}</p>
      {card.detail !== undefined && (
        <blockquote className="hw-card-detail" data-testid="hw-card-detail" title="삭제 대상 블록의 현재 원문">
          {card.detail}
        </blockquote>
      )}
      {page !== null && onJump && (
        <button className="hw-card-jump" onClick={() => onJump(page)} title="이 편집이 적용되는 쪽으로 이동">
          ↪ p.{page + 1}로 이동
        </button>
      )}
    </div>
  );
}

/** The live agentic TIMELINE (THINKING TRANSPARENCY): the model's step-by-step process — status phases,
 *  reasoning chunks, and web searches (query + the sources found, folded in from the tool_result) — rendered
 *  ABOVE the eventual op-cards. `pending` shows the trailing step as still in-flight (a subtle pulse). */
function StepTimeline({ steps, pending }: { steps: AgentStep[]; pending: boolean }) {
  return (
    <div className="hw-timeline" data-testid="hw-timeline">
      {steps.map((s, i) => {
        const live = pending && i === steps.length - 1;
        if (s.kind === "status") {
          return (
            <div key={i} className={live ? "hw-step hw-step-status hw-step-live" : "hw-step hw-step-status"}>
              <span className="hw-step-dot" aria-hidden />
              {statusLabel(s.phase)}
            </div>
          );
        }
        if (s.kind === "reasoning") {
          return (
            <div key={i} className="hw-step hw-step-reasoning" data-testid="hw-step-reasoning">
              {s.text}
            </div>
          );
        }
        // web search: the query it ran + (once done) the sources it found (R5 display-only, safe links).
        return (
          <div key={i} className={s.done ? "hw-step hw-step-search" : "hw-step hw-step-search hw-step-live"} data-testid="hw-step-search">
            <span className="hw-step-search-q">
              🔎 웹 검색: <span className="hw-step-search-query">{s.query}</span>
              {!s.done && <span className="hw-step-search-running"> …</span>}
            </span>
            {s.citations && s.citations.length > 0 && (
              <ul className="hw-citations-list" data-testid="hw-citations">
                {s.citations.map((c, k) => (
                  <li key={k}>
                    <a className="hw-citation-link" href={c.url} target="_blank" rel="noopener noreferrer" title={c.url}>
                      {c.title}
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
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
  // Multimodal: attachments riding along with the next prompt (images for vision + reference-doc text).
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Read picked/pasted files into attachments (append, honoring the count cap). Failures surface a note
  // rather than throwing — a bad file never blocks the composer.
  async function addFiles(files: File[]) {
    if (!files.length) return;
    setAttachError(null);
    const room = MAX_ATTACHMENTS - attachments.length;
    if (room <= 0) {
      setAttachError(`첨부는 최대 ${MAX_ATTACHMENTS}개까지 가능합니다.`);
      return;
    }
    const picked = files.slice(0, room);
    try {
      const next = await Promise.all(picked.map(fileToAttachment));
      setAttachments((a) => [...a, ...next]);
      if (files.length > room) setAttachError(`첨부는 최대 ${MAX_ATTACHMENTS}개까지 — 처음 ${room}개만 추가했습니다.`);
    } catch (e) {
      setAttachError(`첨부 읽기 실패: ${e}`);
    }
  }
  function removeAttachment(id: string) {
    setAttachments((a) => a.filter((x) => x.id !== id));
  }
  // Paste an image directly into the textarea (clipboard screenshot). Only image items are intercepted; a
  // normal text paste falls through to the default behavior.
  function onPasteAttach(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const items = e.clipboardData?.items;
    if (!items) return;
    const imgs: File[] = [];
    for (const it of Array.from(items)) {
      if (it.kind === "file" && it.type.startsWith("image/")) {
        const f = it.getAsFile();
        if (f) imgs.push(f);
      }
    }
    if (imgs.length) {
      e.preventDefault(); // don't also paste the image's textual placeholder
      void addFiles(imgs);
    }
  }

  const last = msgs[msgs.length - 1];
  const awaiting = last?.role === "assistant" && last.state === "pending";
  const mod = props.modLabel ?? modLabel();
  // Feature C: the LIVE undo-stack depth (read each render — reflects global undo/redo too). Each applied
  // turn is top-of-stack ⇔ its recorded `appliedDepth` equals this. Undefined when the host wires no revert.
  const currentDepth = props.undoDepth?.();

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

  function settleLast(state: "applied" | "discarded", appliedDepth?: number) {
    setMsgs((m) => {
      const copy = m.slice();
      for (let i = copy.length - 1; i >= 0; i--) {
        const c = copy[i];
        if (c.role === "assistant" && c.state === "pending") {
          // Record the post-apply undo depth so this turn's per-card 되돌리기 knows when it's top-of-stack.
          copy[i] = { ...c, state, ...(state === "applied" ? { appliedDepth } : {}) };
          break;
        }
      }
      return copy;
    });
  }

  // Patch the LATEST in-flight "thinking" assistant turn (agentic streaming). `fn` maps that turn to its
  // next shape — used both to fold in streamed AgentEvents (grow the timeline) and to settle it (→ pending /
  // empty). No-op if there is no thinking turn (a non-streaming host never opened one). `AssistantMsg` is the
  // steps-bearing assistant variant (the `error` variant carries no steps, so Extract selects the right one).
  function patchThinking(fn: (c: AssistantMsg) => Msg) {
    setMsgs((m) => {
      const copy = m.slice();
      for (let i = copy.length - 1; i >= 0; i--) {
        const c = copy[i];
        if (c.role === "assistant" && c.state === "thinking") {
          copy[i] = fn(c);
          break;
        }
      }
      return copy;
    });
  }

  async function send(text: string) {
    if (busy || awaiting) return;
    const trimmed = text.trim();
    // Multimodal: only forward attachments that carry payload (an image dataUrl / doc text) — an
    // unsupported-format chip (note only) rides along visually but is never sent. Strip UI-only note/size.
    const sendable: Attachment[] = attachments
      .filter((a) => (a.kind === "image" && a.dataUrl) || (a.kind === "doc" && a.text))
      .map((a) => ({ id: a.id, kind: a.kind, name: a.name, mime: a.mime, ...(a.dataUrl ? { dataUrl: a.dataUrl } : {}), ...(a.text ? { text: a.text } : {}) }));
    if (!trimmed && sendable.length === 0) return; // nothing to send
    const anchors = props.anchors;
    const page = anchors.length ? anchors[0].page : null;
    const where = anchors.length ? ` (대상: ${anchors.map((a) => a.label).join(", ")})` : "";
    const attachTag = sendable.length ? ` 📎${sendable.length}` : "";
    // CONVERSATION MEMORY: snapshot prior turns (BEFORE the new user turn is pushed), bounded.
    const history = turnsFromMsgs(msgs, MEMORY_TURNS);
    setInput("");
    setAttachments([]); // the attachments have ridden along — clear them
    setAttachError(null);
    // Push the user turn + a fresh "thinking" assistant turn — the live timeline target (agentic streaming).
    setMsgs((m) => [...m, { role: "user", text: trimmed + where + attachTag }, { role: "assistant", state: "thinking", steps: [], intents: [], cards: [], page }]);
    setBusy(true);
    try {
      // THINKING TRANSPARENCY: stream each AgentEvent into the thinking turn's timeline. The host resolves
      // the SAME `Promise<Intent[]>` with the final intents (inline panel omits onEvent → single-shot). The
      // model decides web-search itself (no toggle). Citations arrive folded into a tool_result step, and
      // also via onCitations for the settled turn. Memory rides in `history` (bounded).
      let captured: Citation[] = [];
      const intents = await props.onAiRequest(trimmed, anchors, props.docContext, {
        onEvent: (ev) => patchThinking((c) => ({ ...c, steps: reduceStep(c.steps, ev) })),
        onCitations: (c) => {
          captured = c;
        },
        ...(history.length ? { history } : {}),
        ...(sendable.length ? { attachments: sendable } : {}),
      });
      props.onConsumeAnchors(); // the chips have ridden along — clear them (issue #009)
      const citations = captured.length ? captured : undefined;
      if (!intents || intents.length === 0) {
        // No proposed edits — settle the thinking turn into "empty" (its timeline stays visible).
        patchThinking((c) => ({ ...c, state: "empty", citations }));
      } else {
        // issue 051: the host's async builder enriches cards (e.g. DeleteBlock 원문); fall back to the
        // pure describeIntent mapping when the host doesn't wire one (backward compatible).
        const cards = props.previewCards ? await props.previewCards(intents) : intents.map(describeIntent);
        patchThinking((c) => ({ ...c, state: "pending", intents, cards, citations }));
      }
    } catch (e) {
      // Drop the in-flight thinking turn and surface the error as its own message.
      setMsgs((m) => {
        const copy = m.slice();
        for (let i = copy.length - 1; i >= 0; i--) {
          const c = copy[i];
          if (c.role === "assistant" && c.state === "thinking") {
            copy.splice(i, 1);
            break;
          }
        }
        copy.push({ role: "assistant", state: "error", text: `${e}` });
        return copy;
      });
    } finally {
      setBusy(false);
    }
  }

  async function apply(intents: Intent[]) {
    setBusy(true);
    try {
      const applied = await props.onApply(intents);
      // Capture the LIVE depth after applying — this batch is now top-of-stack at exactly this depth, so the
      // per-card 되돌리기 can later tell whether it's still on top (Feature C). Read via the live getter (the
      // captured `props` closure is stale, but `undoDepth` is a stable getter reading session state).
      settleLast("applied", props.undoDepth?.());
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

  // Feature C — persistent per-card 되돌리기: revert the applied turn at index `i`. HONEST top-of-stack v1:
  // only proceed when this turn's batch is STILL the top of the undo stack (re-checked here against the live
  // depth) so we never pop the wrong batch; the button is already disabled off-top. On success the turn flips
  // to a "reverted" state (its cards stay visible, greyed, labelled 되돌림).
  async function revert(i: number) {
    if (busy || !props.onRevert) return;
    const c = msgs[i];
    if (!c || c.role !== "assistant" || c.state !== "applied") return;
    if (c.appliedDepth === undefined || props.undoDepth?.() !== c.appliedDepth) return; // not top → refuse
    setBusy(true);
    try {
      const ok = await props.onRevert();
      if (ok) {
        setMsgs((m) => {
          const copy = m.slice();
          const t = copy[i];
          if (t && t.role === "assistant" && t.state === "applied") copy[i] = { ...t, state: "reverted" };
          return copy;
        });
      }
    } catch (e) {
      setMsgs((m) => [...m, { role: "assistant", state: "error", text: `되돌리기 실패: ${e}` }]);
    } finally {
      setBusy(false);
    }
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

      {props.aiNotice && (
        <div className="hw-mock-badge" data-testid="hw-ai-notice">
          ℹ️ {props.aiNotice}
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
                {/* THINKING TRANSPARENCY: the live agentic timeline (what it searched, what it found, its
                    reasoning) — folded citations live inside the search step. Empty for a non-streaming host. */}
                {m.steps.length > 0 && <StepTimeline steps={m.steps} pending={m.state === "thinking"} />}
                {/* While the process is still streaming, show a subtle typing pulse under the timeline. */}
                {m.state === "thinking" && (
                  <div className="hw-typing" data-testid="hw-thinking">
                    <span className="hw-dot" />
                    <span className="hw-dot" />
                    <span className="hw-dot" />
                  </div>
                )}
                {m.state === "empty" && <div className="hw-empty-result" data-testid="hw-empty-result">제안된 편집이 없습니다.</div>}
                {m.cards.length > 0 && (
                  <div className="hw-cards">
                    {m.cards.map((card, j) => (
                      <OpCard key={j} card={card} page={m.page} onJump={props.onJumpToPage} />
                    ))}
                  </div>
                )}
                {m.state === "pending" && (
                  <div className="hw-review">
                    {/* issue 051: a proposal containing a DESTRUCTIVE card names the deletion on the
                        approval button — the user consents to the delete EXPLICITLY (no auto-apply). */}
                    <button className="hw-btn-primary" disabled={busy} onClick={() => apply(m.intents)}>
                      {m.cards.some((c) => c.destructive) ? "✓ 적용(삭제 포함)" : "✓ 적용"}
                    </button>
                    <button className="hw-btn-ghost" disabled={busy} onClick={reject}>
                      취소
                    </button>
                  </div>
                )}
                {m.state === "applied" && (
                  <div className="hw-applied-row">
                    <span className="hw-applied">✓ 적용됨</span>
                    {/* Feature C: persistent 되돌리기 — always shown once applied; enabled only while this
                        batch is the TOP of the undo stack (honest v1). Off-top edits are disabled with a
                        tooltip until the batches above them are reverted. */}
                    {props.onRevert &&
                      (() => {
                        const isTop = m.appliedDepth !== undefined && currentDepth !== undefined && currentDepth === m.appliedDepth;
                        return (
                          <button
                            className="hw-btn-ghost hw-revert"
                            data-testid="hw-revert"
                            disabled={busy || !isTop}
                            title={
                              isTop
                                ? "이 편집을 되돌립니다"
                                : "이 편집 위에 다른 편집이 있어 개별 되돌리기는 다음 배치에서 지원됩니다 — 먼저 위 편집을 되돌리세요"
                            }
                            onClick={() => void revert(i)}
                          >
                            되돌리기
                          </button>
                        );
                      })()}
                  </div>
                )}
                {m.state === "reverted" && <div className="hw-discarded">↩ 되돌림</div>}
                {m.state === "discarded" && <div className="hw-discarded">취소됨</div>}
              </div>
            ),
          )}
          {busy && !awaiting && !(last?.role === "assistant" && last.state === "thinking") && (
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
        {/* Multimodal: attachment CHIPS ride along with the next prompt (mirrors the anchor-chips block).
            An image shows a thumbnail; a doc shows filename + size (or an honest "미지원" note). */}
        {attachments.length > 0 && (
          <div className="hw-attachments-wrap" data-testid="hw-attachments">
            <div className="hw-attachments-head">
              <span className="hw-attachments-hint" title="이 요청과 함께 AI에 전달됩니다 — 이미지는 이미지로, 문서는 참고 텍스트로. 첨부 내용은 지시가 아니라 참고 자료입니다.">
                📎 첨부 {attachments.length}개
              </span>
            </div>
            <div className="hw-attachments">
              {attachments.map((a) => (
                <span key={a.id} className={a.note ? "hw-attachment hw-attachment-unsupported" : "hw-attachment"} title={a.note ?? a.name} data-testid="hw-attachment">
                  {a.kind === "image" && a.dataUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img className="hw-attachment-thumb" src={a.dataUrl} alt={a.name} />
                  ) : (
                    <span className="hw-attachment-icon" aria-hidden>
                      📄
                    </span>
                  )}
                  <span className="hw-attachment-name">{a.name}</span>
                  <span className="hw-attachment-meta">{a.note ? "미지원" : a.kind === "image" ? fmtSize(a.size) : `${fmtSize(a.size)}`}</span>
                  <button className="hw-attachment-x" onClick={() => removeAttachment(a.id)} title="이 첨부 제거">
                    ✕
                  </button>
                </span>
              ))}
            </div>
          </div>
        )}
        {attachError && <p className="hw-attach-error" data-testid="hw-attach-error">{attachError}</p>}
        <div className="hw-composer-tools">
          {/* 📎 attachment picker — images + common documents. Always available while editing. */}
          <input
            ref={fileRef}
            type="file"
            multiple
            accept="image/*,.txt,.md,.markdown,.csv,.tsv,.json,.log,.xml,.html,.htm,.rtf,.hwp,.hwpx,.pdf,.doc,.docx"
            style={{ display: "none" }}
            data-testid="hw-attach-input"
            onChange={(e) => {
              void addFiles(Array.from(e.currentTarget.files ?? []));
              e.currentTarget.value = ""; // allow re-picking the same file
            }}
          />
          <button
            type="button"
            className="hw-attach-btn"
            data-testid="hw-attach-btn"
            disabled={!props.canEdit || busy || awaiting}
            title="이미지·문서 첨부: 표 사진/스크린샷을 붙여넣거나(⌘V) 참고 문서를 선택하세요. AI가 내용을 읽어 편집에 반영합니다."
            onClick={() => fileRef.current?.click()}
          >
            📎 첨부
          </button>
          {/* No web-search toggle: search is now MODEL-DRIVEN (the agent decides when to search based on the
              request) and its sources stream into the timeline as a tool_result step. */}
        </div>
        <div className="hw-composer-row">
          <textarea
            ref={inputRef}
            className="hw-textarea"
            value={input}
            disabled={!props.canEdit || busy || awaiting}
            spellCheck={false}
            placeholder={awaiting ? "위 제안을 적용/취소한 뒤 계속하세요" : props.anchors.length ? "이 위치를 어떻게 바꿀까요?" : "무엇을 바꿀까요? (문서를 클릭하거나 이미지를 붙여넣기)"}
            onChange={(e) => setInput(e.currentTarget.value)}
            onPaste={onPasteAttach}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send(input);
              }
            }}
          />
          <button
            className="hw-btn-send"
            disabled={!props.canEdit || busy || awaiting || (!input.trim() && attachments.every((a) => !a.dataUrl && !a.text))}
            onClick={() => void send(input)}
          >
            {busy ? "…" : "보내기"}
          </button>
        </div>
      </div>
    </aside>
  );
}
