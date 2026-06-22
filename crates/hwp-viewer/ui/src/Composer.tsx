import { useState } from "react";
import { Modal } from "./Modal";

export type ComposerMode = "table" | "ai" | null;

export type ComposerCtx = {
  /** Deterministic apply (one undo unit) → returns new page count. */
  applyContent: (json: string) => Promise<void>;
  /** Natural-language AI: provider turns a prompt into content (dry-run) → rationale+preview text. */
  generate: (prompt: string) => Promise<string>;
  /** Dry-run hand-authored content JSON → rationale+preview text (advanced). */
  propose: (json: string) => Promise<string>;
  commit: () => Promise<void>;
  discard: () => Promise<void>;
};

const DEFAULT_AI =
  '{"blocks":[{"type":"heading","text":"제목","style":"개요 1"},{"type":"paragraph","runs":[{"text":"본문 "},{"text":"강조","bold":true}]}]}';

/// Structured authoring composer. Deterministic 표 추가 applies directly (one undo unit); AI content
/// goes through propose → whole-proposal review → commit/discard.
export function Composer(props: { mode: ComposerMode; onClose: () => void; ctx: ComposerCtx }) {
  const [rows, setRows] = useState(3);
  const [cols, setCols] = useState(3);
  const [header, setHeader] = useState(true);
  const [prompt, setPrompt] = useState("");
  const [useJson, setUseJson] = useState(false);
  const [ai, setAi] = useState(DEFAULT_AI);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function close() {
    setPreview(null);
    setBusy(false);
    props.onClose();
  }

  function tableJson(): string {
    const c = Math.max(1, cols);
    const bodyRows = Math.max(0, rows - (header ? 1 : 0));
    const hdr = header ? Array.from({ length: c }, (_, i) => `항목${i + 1}`) : [];
    const body = Array.from({ length: bodyRows }, () => Array.from({ length: c }, () => ""));
    return JSON.stringify({ blocks: [{ type: "table", header: hdr, rows: body }] });
  }

  async function addTable() {
    setBusy(true);
    try {
      await props.ctx.applyContent(tableJson());
      close();
    } finally {
      setBusy(false);
    }
  }
  async function doGenerate() {
    if (!prompt.trim()) return;
    setBusy(true);
    try {
      setPreview(await props.ctx.generate(prompt));
    } catch (e) {
      setPreview(`생성 실패: ${e}`);
    } finally {
      setBusy(false);
    }
  }
  async function doPropose() {
    setBusy(true);
    try {
      setPreview(await props.ctx.propose(ai));
    } finally {
      setBusy(false);
    }
  }
  async function doCommit() {
    setBusy(true);
    try {
      await props.ctx.commit();
      close();
    } finally {
      setBusy(false);
    }
  }
  async function doDiscard() {
    await props.ctx.discard().catch(() => {});
    setPreview(null);
  }

  return (
    <Modal open={props.mode !== null} onClose={close}>
      <div className="w-[520px] max-w-[90vw] rounded-xl border border-black/10 bg-white p-5 shadow-2xl dark:border-white/10 dark:bg-neutral-800">
        {props.mode === "table" && (
          <>
            <div className="text-sm font-semibold">표 추가 <span className="font-normal text-neutral-400">· 문서 끝에 추가</span></div>
            <div className="mt-4 flex flex-col gap-3 text-sm">
              <div className="flex items-center gap-4">
                <label className="flex items-center gap-2">행
                  <input type="number" min={1} value={rows} onChange={(e) => setRows(+e.currentTarget.value || 1)}
                    className="w-16 rounded-md border border-black/10 bg-transparent px-2 py-1 dark:border-white/10" />
                </label>
                <label className="flex items-center gap-2">열
                  <input type="number" min={1} value={cols} onChange={(e) => setCols(+e.currentTarget.value || 1)}
                    className="w-16 rounded-md border border-black/10 bg-transparent px-2 py-1 dark:border-white/10" />
                </label>
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={header} onChange={(e) => setHeader(e.currentTarget.checked)} /> 머리글 행
                </label>
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button onClick={close} className="rounded-md px-3 py-1.5 text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-700">취소</button>
                <button onClick={addTable} disabled={busy} className="rounded-md bg-accent px-3 py-1.5 font-medium text-white hover:opacity-90 disabled:opacity-40">추가 <kbd className="opacity-70">⌘⏎</kbd></button>
              </div>
            </div>
          </>
        )}

        {props.mode === "ai" && (
          <>
            <div className="flex items-center justify-between">
              <div className="text-sm font-semibold text-ai">✦ AI로 작성</div>
              <button onClick={() => setUseJson(!useJson)} className="text-xs text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200">
                {useJson ? "← 자연어로" : "고급: JSON 직접 입력"}
              </button>
            </div>

            {!useJson && (
              <textarea
                spellCheck={false}
                placeholder="무엇을 추가할지 한국어로 적어주세요. 예: 팀원 구성에 대한 3열 표를 추가해줘"
                className="mt-3 h-32 w-full resize-none rounded-md border border-black/10 bg-neutral-50 p-2 text-sm text-neutral-900 placeholder:text-neutral-400 dark:border-white/10 dark:bg-neutral-900 dark:text-neutral-100"
                value={prompt}
                onChange={(e) => setPrompt(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                    e.preventDefault();
                    void doGenerate();
                  }
                }}
              />
            )}

            {useJson && (
              <textarea
                spellCheck={false}
                className="mt-3 h-40 w-full resize-none rounded-md border border-black/10 bg-neutral-50 p-2 font-mono text-xs text-neutral-900 dark:border-white/10 dark:bg-neutral-900 dark:text-neutral-100"
                value={ai}
                onChange={(e) => setAi(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                    e.preventDefault();
                    void doPropose();
                  }
                }}
              />
            )}

            {!preview && (
              <div className="mt-3 flex justify-end gap-2 text-sm">
                <button onClick={close} className="rounded-md px-3 py-1.5 text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-700">취소</button>
                {!useJson ? (
                  <button onClick={doGenerate} disabled={busy || !prompt.trim()} className="rounded-md bg-ai px-3 py-1.5 font-medium text-white hover:opacity-90 disabled:opacity-40">{busy ? "생성 중…" : "✦ 생성"} <kbd className="opacity-70">⌘⏎</kbd></button>
                ) : (
                  <button onClick={doPropose} disabled={busy} className="rounded-md bg-ai px-3 py-1.5 font-medium text-white hover:opacity-90 disabled:opacity-40">미리보기 <kbd className="opacity-70">⌘⏎</kbd></button>
                )}
              </div>
            )}

            {preview && (
              <div className="mt-3 flex flex-col gap-2 rounded-md border border-ai/30 bg-ai/5 p-2 text-sm">
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap text-xs text-neutral-700 dark:text-neutral-300">{preview}</pre>
                <div className="flex justify-end gap-2">
                  <button onClick={doDiscard} className="rounded-md px-3 py-1.5 text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-700">취소</button>
                  <button onClick={doCommit} disabled={busy} className="rounded-md bg-accent px-3 py-1.5 font-medium text-white hover:opacity-90 disabled:opacity-40">✓ 적용 (전체·실행취소 1단계)</button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
