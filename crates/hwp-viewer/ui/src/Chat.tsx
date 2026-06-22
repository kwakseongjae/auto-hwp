import { useEffect, useRef, useState } from "react";

export type Scope = { section: number; block: number | null; page: number };

export type ChatCtx = {
  /** Send a NL edit instruction (+ optional click-resolved scope); the provider proposes targeted
   *  edits (dry-run). Returns the rationale + per-op preview. Held pending on the Rust session. */
  propose: (instruction: string, scope: Scope | null) => Promise<string>;
  /** Insert an attached image (base64) at the pointed target — deterministic, no provider needed. */
  insertImage: (name: string, dataB64: string, scope: Scope | null, widthMm: number, heightMm: number) => Promise<string>;
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

type Msg =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; state: "pending" | "applied" | "discarded" | "error" };

/// The vibe-docs chat panel — the PRIMARY editing surface. The user POINTS at the document (a click
/// captures a `scope` chip) and says what they want ("이거 지워줘", "여기 아래 표 넣어줘"); the AI proposes
/// anchored edits, shown as a reviewable card with 적용/취소. Applying commits through the op-bus.
export function Chat(props: {
  open: boolean;
  canEdit: boolean;
  provider: string;
  scope: Scope | null;
  onClearScope: () => void;
  ctx: ChatCtx;
  onApplied: () => void;
}) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [attach, setAttach] = useState<Attachment | null>(null);
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
      setMsgs((m) => [...m, { role: "assistant", text: "이미지를 읽지 못했습니다", state: "error" }]);
    }
  }

  const isMock = props.provider === "mock" || props.provider === "none";
  const awaiting =
    msgs.length > 0 &&
    msgs[msgs.length - 1].role === "assistant" &&
    (msgs[msgs.length - 1] as { state: string }).state === "pending";

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [msgs]);
  useEffect(() => {
    if (props.open) queueMicrotask(() => inputRef.current?.focus());
  }, [props.open]);

  function settleLast(state: "applied" | "discarded" | "error") {
    setMsgs((m) => {
      const copy = m.slice();
      for (let i = copy.length - 1; i >= 0; i--) {
        if (copy[i].role === "assistant" && (copy[i] as { state: string }).state === "pending") {
          copy[i] = { ...(copy[i] as Msg & { role: "assistant" }), state };
          break;
        }
      }
      return copy;
    });
  }

  async function send() {
    const text = input.trim();
    if (busy || awaiting) return;
    // Need either some text (NL edit) or an attached image (deterministic insert).
    if (!text && !attach) return;
    const scope = props.scope;
    const where = scope ? ` (가리킨 위치 p.${scope.page + 1}${scope.block !== null ? `·블록 ${scope.block}` : ""})` : "";
    const att = attach;
    setInput("");
    setAttach(null);
    setMsgs((m) => [...m, { role: "user", text: (att ? `📎 ${att.name} ` : "") + text + where }]);
    setBusy(true);
    try {
      // An attached image takes the deterministic insert path (works with no provider/key); plain
      // text goes through the AI edit proposer.
      const preview = att
        ? await props.ctx.insertImage(att.name, att.dataB64, scope, att.widthMm, att.heightMm)
        : await props.ctx.propose(text, scope);
      setMsgs((m) => [...m, { role: "assistant", text: preview, state: "pending" }]);
    } catch (e) {
      setMsgs((m) => [...m, { role: "assistant", text: `${e}`, state: "error" }]);
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
      setMsgs((m) => [...m, { role: "assistant", text: `적용 실패: ${e}`, state: "error" }]);
    } finally {
      setBusy(false);
    }
  }
  async function reject() {
    await props.ctx.discard().catch(() => {});
    settleLast("discarded");
  }

  if (!props.open) return null;

  return (
    <aside className="flex w-[360px] shrink-0 flex-col border-l border-black/10 bg-neutral-50/60 backdrop-blur-xl dark:border-white/10 dark:bg-neutral-800/40">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-black/10 px-3 text-sm font-medium text-ai dark:border-white/10">
        ✦ 바이브 편집
        <span className="font-normal text-neutral-400">· 가리키고 말하세요</span>
      </div>

      {isMock && (
        <div className="border-b border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-400">
          ⚠️ 데모 모드(mock): 요청을 실제로 이해하지 못하고 예시 편집만 보여줍니다. 실제 편집은
          {" "}<code className="rounded bg-black/10 px-1 dark:bg-white/10">ANTHROPIC_API_KEY</code> 설정(또는 Ollama 실행) 후 앱 재시작.
        </div>
      )}

      <div ref={listRef} className="min-h-0 flex-1 overflow-auto p-3">
        {msgs.length === 0 && (
          <div className="mt-6 flex flex-col gap-2 text-center text-xs text-neutral-400">
            <p>문서의 한 곳을 <b>클릭해서 가리키고</b>, 무엇을 바꿀지 말하세요.</p>
            <div className="mx-auto flex flex-col gap-1 text-left text-neutral-500 dark:text-neutral-400">
              <span>· (목차 클릭) → “이 표 지우고 새로 만들어줘”</span>
              <span>· (문단 클릭) → “여기 아래에 표 넣어줘”</span>
              <span>· “결론 문단 하나 추가해줘”</span>
            </div>
          </div>
        )}
        <div className="flex flex-col gap-3">
          {msgs.map((m, i) =>
            m.role === "user" ? (
              <div key={i} className="self-end max-w-[85%] rounded-2xl rounded-br-sm bg-accent px-3 py-2 text-sm text-white">
                {m.text}
              </div>
            ) : (
              <div key={i} className="self-start max-w-[95%]">
                <div
                  className={`rounded-2xl rounded-bl-sm border px-3 py-2 text-xs ${
                    m.state === "error"
                      ? "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400"
                      : "border-ai/30 bg-ai/5 text-neutral-700 dark:text-neutral-300"
                  }`}
                >
                  <pre className="max-h-60 overflow-auto whitespace-pre-wrap font-sans">{m.text}</pre>
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
        </div>
      </div>

      <div className="shrink-0 border-t border-black/10 p-2 dark:border-white/10">
        {!props.canEdit && <p className="px-1 pb-1.5 text-[11px] text-neutral-400">편집하려면 먼저 HWPX 문서를 여세요.</p>}
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
                void send();
              }
            }}
          />
          <button
            onClick={() => void send()}
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
