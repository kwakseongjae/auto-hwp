import { useCallback, useEffect, useRef, useState } from "react";
import type { Proposal, ProposalOp } from "./api";

export type Scope = { section: number; block: number | null; page: number };

export type ChatCtx = {
  /** Send a NL edit instruction (+ optional click-resolved scope); the provider proposes targeted
   *  edits (dry-run). Returns the structured proposal (rationale + per-op cards). Held pending. */
  propose: (instruction: string, scope: Scope | null) => Promise<Proposal>;
  /** Insert an attached image (base64) at the pointed target — deterministic, no provider needed. */
  insertImage: (name: string, dataB64: string, scope: Scope | null, widthMm: number, heightMm: number) => Promise<Proposal>;
  /** Commit the pending proposal (one undo unit). */
  commit: () => Promise<void>;
  /** Drop the pending proposal. */
  discard: () => Promise<void>;
};

type Attachment = { name: string; dataB64: string; dataUrl: string; widthMm: number; heightMm: number };

/** Read a File to its base64 payload (no data: prefix) + keep the full data URL for the thumbnail. */
function readImage(file: File): Promise<{ dataB64: string; dataUrl: string; w: number; h: number }> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(new Error("파일 읽기 실패"));
    r.onload = () => {
      const dataUrl = r.result as string;
      const dataB64 = dataUrl.split(",")[1] ?? "";
      const img = new Image();
      img.onload = () => resolve({ dataB64, dataUrl, w: img.naturalWidth, h: img.naturalHeight });
      img.onerror = () => resolve({ dataB64, dataUrl, w: 0, h: 0 });
      img.src = dataUrl;
    };
    r.readAsDataURL(file);
  });
}

// One assistant turn carries the STRUCTURED proposal (rationale + per-op cards) plus the page the
// user pointed at (so the card's jump-to-block link can scroll there). `state` tracks the review.
type Msg =
  | { role: "user"; text: string }
  | { role: "assistant"; state: "applied" | "discarded"; proposal: Proposal; page: number | null }
  | { role: "assistant"; state: "pending"; proposal: Proposal; page: number | null }
  | { role: "assistant"; state: "error"; text: string };

// Reusable prompt chips — the empty-state suggestions AND the always-available quick row above the
// composer. Each either fills the input (so the user can tweak before sending) or is a one-tap send.
const PROMPT_CHIPS: { label: string; prompt: string }[] = [
  { label: "표 추가", prompt: "여기 아래에 표를 하나 넣어줘" },
  { label: "이 블록 삭제", prompt: "이 블록을 지워줘" },
  { label: "문단 추가", prompt: "결론 문단 하나 추가해줘" },
  { label: "열 음영", prompt: "이 표의 첫 번째 열에 연한 회색 음영을 넣어줘" },
  { label: "제목 추가", prompt: "여기 위에 소제목을 추가해줘" },
];

// Per-op-kind label + glyph for the structured proposal CARD header (falls back for unknown kinds).
const OP_META: Record<string, { label: string; icon: string }> = {
  append_paragraph: { label: "문단 추가", icon: "¶" },
  insert_paragraph: { label: "문단 삽입", icon: "¶" },
  append_table: { label: "표 추가", icon: "▦" },
  insert_table: { label: "표 삽입", icon: "▦" },
  insert_image: { label: "그림 삽입", icon: "🖼" },
  insert_rows: { label: "행 삽입", icon: "▤" },
  set_cell: { label: "칸 채우기", icon: "▣" },
  shade_cells: { label: "음영", icon: "◧" },
  delete_block: { label: "블록 삭제", icon: "－" },
  page_layout: { label: "페이지 설정", icon: "▭" },
  edit: { label: "편집", icon: "✎" },
};

/** A structured per-op proposal CARD: op kind, a target chip {section,block} with a jump-to-block
 *  link that scrolls the page, and the human summary line — replaces the old prose <pre> blob. */
function OpCard(props: { op: ProposalOp; page: number | null; onJump: (page: number) => void }) {
  const { op, page, onJump } = props;
  const meta = OP_META[op.kind] ?? OP_META.edit;
  const hasTarget = op.section !== null;
  return (
    <div className="rounded-lg border border-ai/25 bg-white/60 px-2.5 py-2 dark:bg-neutral-900/40">
      <div className="flex items-center gap-1.5">
        <span className="text-sm leading-none">{meta.icon}</span>
        <span className="text-[12px] font-medium text-neutral-700 dark:text-neutral-200">{meta.label}</span>
        {hasTarget && (
          <span
            className="ml-auto inline-flex items-center gap-1 rounded-full bg-accent/10 px-1.5 py-0.5 font-mono text-[10px] text-accent"
            title="편집 대상 위치 (섹션/블록)"
          >
            s{op.section}
            {op.block !== null ? `·b${op.block}` : ""}
          </span>
        )}
      </div>
      <p className="mt-1 break-words text-[12px] leading-snug text-neutral-600 dark:text-neutral-300">{op.summary}</p>
      {page !== null && (
        <button
          onClick={() => onJump(page)}
          className="mt-1 inline-flex items-center gap-1 text-[11px] text-accent hover:underline"
          title="이 편집이 적용되는 쪽으로 이동"
        >
          ↪ p.{page + 1}로 이동
        </button>
      )}
    </div>
  );
}

const MIN_W = 300;
const MAX_W = 640;
const RAIL_W = 44; // collapsed rail width

/// The vibe-docs chat panel — the PRIMARY editing surface. The user POINTS at the document (a click
/// captures a `scope` chip) and says what they want ("이거 지워줘", "여기 아래 표 넣어줘"); the AI proposes
/// anchored edits, shown as reviewable per-op CARDS with 적용/취소. Applying commits through the op-bus.
/// The panel is resizable (drag the left edge) and collapsible to a thin rail.
export function Chat(props: {
  open: boolean;
  canEdit: boolean;
  provider: string;
  scope: Scope | null;
  onClearScope: () => void;
  onJumpToPage: (page: number) => void;
  ctx: ChatCtx;
  /** Signal raised by the INLINE document toolbar (✓확정/✕취소) so the mirrored chat card settles to
   *  the same terminal state. `n` is monotonic; the effect runs once per bump. */
  settleSignal: { n: number; state: "applied" | "discarded" } | null;
  onApplied: () => void;
}) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [attach, setAttach] = useState<Attachment | null>(null);
  // Resizable + collapsible-to-rail panel state (replaces the old hardcoded w-[360px]).
  const [width, setWidth] = useState(380);
  const [collapsed, setCollapsed] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file
    if (!file) return;
    try {
      const { dataB64, dataUrl, w, h } = await readImage(file);
      // Display box: cap width at 120mm, keep aspect (fall back to 100×75 if dims unknown).
      const widthMm = 120;
      const heightMm = w > 0 && h > 0 ? Math.round((widthMm * h) / w) : 90;
      setAttach({ name: file.name, dataB64, dataUrl, widthMm, heightMm });
    } catch {
      setMsgs((m) => [...m, { role: "assistant", state: "error", text: "이미지를 읽지 못했습니다" }]);
    }
  }

  const isMock = props.provider === "mock" || props.provider === "none";
  const last = msgs[msgs.length - 1];
  const awaiting = last?.role === "assistant" && last.state === "pending";

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [msgs, busy]);
  useEffect(() => {
    if (props.open && !collapsed) queueMicrotask(() => inputRef.current?.focus());
  }, [props.open, collapsed]);
  // When the user confirms/rejects from the INLINE document toolbar, settle the mirrored chat card to
  // the same terminal state so the two review surfaces never disagree. Keyed on the monotonic `n`.
  const settleN = props.settleSignal?.n;
  useEffect(() => {
    if (props.settleSignal) settleLast(props.settleSignal.state);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settleN]);

  // ---- left-edge resize drag (pointer events; clamps to [MIN_W, MAX_W]) ----
  const onResizeDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const onMove = (ev: PointerEvent) => {
      // Dragging the LEFT edge: moving left (smaller clientX) widens the panel.
      const next = Math.max(MIN_W, Math.min(MAX_W, startW + (startX - ev.clientX)));
      setWidth(next);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.cursor = "";
    };
    document.body.style.cursor = "col-resize";
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, [width]);

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
    // Need either some text (NL edit) or an attached image (deterministic insert).
    if (!trimmed && !attach) return;
    const scope = props.scope;
    const page = scope ? scope.page : null;
    const where = scope ? ` (가리킨 위치 p.${scope.page + 1}${scope.block !== null ? `·블록 ${scope.block}` : ""})` : "";
    const att = attach;
    setInput("");
    setAttach(null);
    setMsgs((m) => [...m, { role: "user", text: (att ? `📎 ${att.name} ` : "") + trimmed + where }]);
    setBusy(true);
    try {
      // An attached image takes the deterministic insert path (works with no provider/key); plain
      // text goes through the AI edit proposer. Both return a STRUCTURED proposal.
      const proposal = att
        ? await props.ctx.insertImage(att.name, att.dataB64, scope, att.widthMm, att.heightMm)
        : await props.ctx.propose(trimmed, scope);
      setMsgs((m) => [...m, { role: "assistant", state: "pending", proposal, page }]);
    } catch (e) {
      setMsgs((m) => [...m, { role: "assistant", state: "error", text: `${e}` }]);
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    setBusy(true);
    try {
      await props.ctx.commit();
      settleLast("applied");
      props.onApplied();
    } catch (e) {
      setMsgs((m) => [...m, { role: "assistant", state: "error", text: `적용 실패: ${e}` }]);
    } finally {
      setBusy(false);
    }
  }
  async function reject() {
    await props.ctx.discard().catch(() => {});
    settleLast("discarded");
  }

  if (!props.open) return null;

  // ---- collapsed RAIL: a thin vertical strip that re-expands the panel ----
  if (collapsed) {
    return (
      <aside
        style={{ width: RAIL_W }}
        className="flex shrink-0 flex-col items-center gap-3 border-l border-black/10 bg-neutral-50/60 py-3 backdrop-blur-xl dark:border-white/10 dark:bg-neutral-800/40"
      >
        <button
          onClick={() => setCollapsed(false)}
          title="바이브 편집 패널 펼치기"
          className="rounded-md px-1.5 py-1 text-ai hover:bg-ai/10"
        >
          ✦
        </button>
        <span
          className="text-[11px] font-medium text-neutral-400"
          style={{ writingMode: "vertical-rl" }}
        >
          바이브 편집
        </span>
        {awaiting && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" title="검토 대기 중인 제안" />}
      </aside>
    );
  }

  return (
    <aside
      style={{ width }}
      className="relative flex shrink-0 flex-col border-l border-black/10 bg-neutral-50/60 backdrop-blur-xl dark:border-white/10 dark:bg-neutral-800/40"
    >
      {/* Left-edge resize handle: a 5px hit-strip; the visible line brightens on hover/drag. */}
      <div
        onPointerDown={onResizeDown}
        title="너비 조절 (드래그)"
        className="group absolute -left-[3px] top-0 z-20 h-full w-[6px] cursor-col-resize"
      >
        <div className="mx-auto h-full w-px bg-transparent transition-colors group-hover:bg-accent/40" />
      </div>

      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-black/10 px-3 text-sm font-medium text-ai dark:border-white/10">
        ✦ 바이브 편집
        <span className="font-normal text-neutral-400">· 가리키고 말하세요</span>
        <button
          onClick={() => setCollapsed(true)}
          title="패널 접기"
          className="ml-auto rounded px-1.5 py-0.5 text-neutral-400 hover:bg-neutral-200/70 dark:hover:bg-neutral-700/60"
        >
          ⇥
        </button>
      </div>

      {isMock && (
        <div className="border-b border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-400">
          ⚠️ 데모 모드(mock): 요청을 실제로 이해하지 못하고 예시 편집만 보여줍니다. 실제 편집은
          {" "}<code className="rounded bg-black/10 px-1 dark:bg-white/10">ANTHROPIC_API_KEY</code> 설정(또는 Ollama 실행) 후 앱 재시작.
        </div>
      )}

      <div ref={listRef} className="min-h-0 flex-1 overflow-auto p-3">
        {msgs.length === 0 && (
          <div className="mt-6 flex flex-col gap-3 text-center text-xs text-neutral-400">
            <p>문서의 한 곳을 <b>클릭해서 가리키고</b>, 무엇을 바꿀지 말하세요.</p>
            <div className="mx-auto flex flex-wrap justify-center gap-1.5">
              {PROMPT_CHIPS.map((c) => (
                <button
                  key={c.label}
                  onClick={() => { setInput(c.prompt); inputRef.current?.focus(); }}
                  disabled={!props.canEdit || busy || awaiting}
                  className="rounded-full border border-ai/30 bg-ai/5 px-2.5 py-1 text-[11px] text-neutral-600 hover:bg-ai/10 disabled:opacity-40 dark:text-neutral-300"
                >
                  {c.label}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="flex flex-col gap-3">
          {msgs.map((m, i) =>
            m.role === "user" ? (
              <div key={i} className="self-end max-w-[85%] rounded-2xl rounded-br-sm bg-accent px-3 py-2 text-sm text-white">
                {m.text}
              </div>
            ) : m.state === "error" ? (
              <div key={i} className="self-start max-w-[95%]">
                <div className="rounded-2xl rounded-bl-sm border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
                  <pre className="max-h-60 overflow-auto whitespace-pre-wrap font-sans">{m.text}</pre>
                </div>
              </div>
            ) : (
              <div key={i} className="self-start w-full max-w-[95%]">
                <div className="rounded-2xl rounded-bl-sm border border-ai/30 bg-ai/5 px-2.5 py-2">
                  {m.proposal.rationale && (
                    <p className="mb-2 px-0.5 text-xs leading-snug text-neutral-600 dark:text-neutral-300">{m.proposal.rationale}</p>
                  )}
                  {/* Structured per-op CARDS — op kind + target chip + jump-to-block link. */}
                  <div className="flex flex-col gap-1.5">
                    {m.proposal.ops.map((op, j) => (
                      <OpCard key={j} op={op} page={m.page} onJump={props.onJumpToPage} />
                    ))}
                  </div>
                </div>
                {m.state === "pending" && (
                  <div className="mt-1.5 flex gap-2">
                    <button onClick={apply} disabled={busy} className="rounded-md bg-accent px-3 py-1 text-xs font-medium text-white hover:opacity-90 disabled:opacity-40">✓ 적용</button>
                    <button onClick={reject} disabled={busy} className="rounded-md px-3 py-1 text-xs text-neutral-600 hover:bg-neutral-200/70 disabled:opacity-40 dark:text-neutral-300 dark:hover:bg-neutral-700/60">취소</button>
                  </div>
                )}
                {m.state === "applied" && <div className="mt-1 text-[11px] text-emerald-600 dark:text-emerald-400">✓ 적용됨 · ⌘Z 로 되돌리기</div>}
                {m.state === "discarded" && <div className="mt-1 text-[11px] text-neutral-400">취소됨</div>}
              </div>
            ),
          )}
          {/* Assistant typing/thinking bubble while a proposal is being generated. */}
          {busy && !awaiting && (
            <div className="self-start">
              <div className="flex items-center gap-1 rounded-2xl rounded-bl-sm border border-ai/30 bg-ai/5 px-3 py-2.5">
                <span className="typing-dot h-1.5 w-1.5 rounded-full bg-ai" style={{ animationDelay: "0ms" }} />
                <span className="typing-dot h-1.5 w-1.5 rounded-full bg-ai" style={{ animationDelay: "150ms" }} />
                <span className="typing-dot h-1.5 w-1.5 rounded-full bg-ai" style={{ animationDelay: "300ms" }} />
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="shrink-0 border-t border-black/10 p-2 dark:border-white/10">
        {!props.canEdit && <p className="px-1 pb-1.5 text-[11px] text-neutral-400">편집하려면 먼저 HWPX 문서를 여세요.</p>}
        {/* Always-available quick prompt chips above the composer (reuse the same set). */}
        {props.canEdit && (
          <div className="mb-1.5 flex flex-wrap gap-1.5">
            {PROMPT_CHIPS.slice(0, 3).map((c) => (
              <button
                key={c.label}
                onClick={() => { setInput(c.prompt); inputRef.current?.focus(); }}
                disabled={busy || awaiting}
                className="rounded-full border border-black/10 px-2 py-0.5 text-[11px] text-neutral-500 hover:bg-neutral-200/70 disabled:opacity-40 dark:border-white/10 dark:text-neutral-400 dark:hover:bg-neutral-700/60"
              >
                {c.label}
              </button>
            ))}
          </div>
        )}
        {props.scope && (
          <div className="mb-1.5 flex items-center gap-1.5 rounded-md border border-accent/30 bg-accent/10 px-2 py-1 text-[11px] text-accent">
            📍 가리킨 위치: p.{props.scope.page + 1}
            {props.scope.block !== null ? ` · 블록 ${props.scope.block}` : " · (섹션 기준)"}
            <button onClick={props.onClearScope} className="ml-auto rounded px-1 hover:bg-accent/20" title="선택 해제">✕</button>
          </div>
        )}
        {attach && (
          <div className="mb-1.5 flex items-center gap-2 rounded-md border border-ai/30 bg-ai/5 px-2 py-1 text-[11px] text-neutral-600 dark:text-neutral-300">
            <img src={attach.dataUrl} alt="" className="h-8 w-8 rounded object-cover ring-1 ring-black/10" />
            <span className="truncate">📎 {attach.name}</span>
            <span className="shrink-0 text-neutral-400">{attach.widthMm}×{attach.heightMm}mm</span>
            <button onClick={() => setAttach(null)} className="ml-auto rounded px-1 hover:bg-ai/20" title="첨부 제거">✕</button>
          </div>
        )}
        <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={onPickFile} />
        <div className="flex items-end gap-2">
          <button
            onClick={() => fileRef.current?.click()}
            disabled={!props.canEdit || busy || awaiting}
            title="이미지 첨부"
            className="h-9 shrink-0 rounded-lg border border-black/10 px-2.5 text-sm text-neutral-500 hover:bg-neutral-200/70 disabled:opacity-40 dark:border-white/10 dark:hover:bg-neutral-700/60"
          >
            📎
          </button>
          <textarea
            ref={inputRef}
            value={input}
            disabled={!props.canEdit || busy || awaiting}
            spellCheck={false}
            placeholder={
              awaiting
                ? "위 제안을 적용/취소한 뒤 계속하세요"
                : attach
                  ? "📎 첨부 이미지를 넣습니다 — 보내기를 누르세요 (위치는 문서 클릭)"
                  : props.scope
                    ? "이 위치를 어떻게 바꿀까요?"
                    : "무엇을 바꿀까요? (문서를 클릭하면 위치 지정)"
            }
            className="h-16 flex-1 resize-none rounded-lg border border-black/10 bg-white px-2.5 py-2 text-sm outline-none placeholder:text-neutral-400 focus:border-accent disabled:opacity-50 dark:border-white/10 dark:bg-neutral-900"
            onChange={(e) => setInput(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send(input);
              }
            }}
          />
          <button
            onClick={() => void send(input)}
            disabled={!props.canEdit || busy || awaiting || (!input.trim() && !attach)}
            className="h-9 rounded-lg bg-ai px-3 text-sm font-medium text-white hover:opacity-90 disabled:opacity-40"
          >
            {busy ? "…" : "보내기"}
          </button>
        </div>
      </div>
    </aside>
  );
}
