import { Dialog } from "@kobalte/core/dialog";
import { createSignal, Show } from "solid-js";

export type ComposerMode = "table" | "ai" | null;

export type ComposerCtx = {
  /** Deterministic apply (one undo unit) → returns new page count. */
  applyContent: (json: string) => Promise<void>;
  /** Dry-run a proposal → returns the rationale+preview text. */
  propose: (json: string) => Promise<string>;
  commit: () => Promise<void>;
  discard: () => Promise<void>;
};

const DEFAULT_AI =
  '{"blocks":[{"type":"heading","text":"제목","style":"개요 1"},{"type":"paragraph","runs":[{"text":"본문 "},{"text":"강조","bold":true}]}]}';

/// Structured authoring composer (Kobalte Form/Dialog). Deterministic 표 추가 applies directly
/// (one undo unit); AI content goes through propose → whole-proposal review → commit/discard.
/// Shaped to graduate into the per-block inspector (Phase 4) with no mental-model change.
export function Composer(props: { mode: ComposerMode; onClose: () => void; ctx: ComposerCtx }) {
  const [rows, setRows] = createSignal(3);
  const [cols, setCols] = createSignal(3);
  const [header, setHeader] = createSignal(true);
  const [ai, setAi] = createSignal(DEFAULT_AI);
  const [preview, setPreview] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);

  const open = () => props.mode !== null;
  function close() {
    setPreview(null);
    setBusy(false);
    props.onClose();
  }

  function tableJson(): string {
    const c = Math.max(1, cols());
    const bodyRows = Math.max(0, rows() - (header() ? 1 : 0));
    const hdr = header() ? Array.from({ length: c }, (_, i) => `항목${i + 1}`) : [];
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
  async function doPropose() {
    setBusy(true);
    try {
      setPreview(await props.ctx.propose(ai()));
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
    <Dialog open={open()} onOpenChange={(o) => !o && close()}>
      <Dialog.Portal>
        <Dialog.Overlay class="fixed inset-0 z-40 bg-black/30 backdrop-blur-sm" />
        <div class="fixed inset-0 z-40 flex items-start justify-center pt-[14vh]">
          <Dialog.Content class="w-[520px] max-w-[90vw] rounded-xl border border-black/10 bg-white p-5 shadow-2xl dark:border-white/10 dark:bg-neutral-800">
            <Show when={props.mode === "table"}>
              <Dialog.Title class="text-sm font-semibold">표 추가 <span class="font-normal text-neutral-400">· 문서 끝에 추가</span></Dialog.Title>
              <div class="mt-4 flex flex-col gap-3 text-sm">
                <div class="flex items-center gap-4">
                  <label class="flex items-center gap-2">행
                    <input type="number" min={1} value={rows()} onInput={(e) => setRows(+e.currentTarget.value || 1)}
                      class="w-16 rounded-md border border-black/10 bg-transparent px-2 py-1 dark:border-white/10" />
                  </label>
                  <label class="flex items-center gap-2">열
                    <input type="number" min={1} value={cols()} onInput={(e) => setCols(+e.currentTarget.value || 1)}
                      class="w-16 rounded-md border border-black/10 bg-transparent px-2 py-1 dark:border-white/10" />
                  </label>
                  <label class="flex items-center gap-2">
                    <input type="checkbox" checked={header()} onChange={(e) => setHeader(e.currentTarget.checked)} /> 머리글 행
                  </label>
                </div>
                <div class="flex justify-end gap-2 pt-2">
                  <button onClick={close} class="rounded-md px-3 py-1.5 text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-700">취소</button>
                  <button onClick={addTable} disabled={busy()} class="rounded-md bg-accent px-3 py-1.5 font-medium text-white hover:opacity-90 disabled:opacity-40">추가 <kbd class="opacity-70">⌘⏎</kbd></button>
                </div>
              </div>
            </Show>

            <Show when={props.mode === "ai"}>
              <Dialog.Title class="text-sm font-semibold text-ai">✦ AI 콘텐츠 (템플릿 JSON)</Dialog.Title>
              <textarea
                spellcheck={false}
                class="mt-3 h-40 w-full resize-none rounded-md border border-black/10 bg-neutral-50 p-2 font-mono text-xs text-neutral-900 dark:border-white/10 dark:bg-neutral-900 dark:text-neutral-100"
                value={ai()}
                onInput={(e) => setAi(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                    e.preventDefault();
                    void doPropose();
                  }
                }}
              />
              <Show when={!preview()}>
                <div class="mt-3 flex justify-end gap-2 text-sm">
                  <button onClick={close} class="rounded-md px-3 py-1.5 text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-700">취소</button>
                  <button onClick={doPropose} disabled={busy()} class="rounded-md bg-ai px-3 py-1.5 font-medium text-white hover:opacity-90 disabled:opacity-40">미리보기 (제안) <kbd class="opacity-70">⌘⏎</kbd></button>
                </div>
              </Show>
              <Show when={preview()}>
                <div class="mt-3 flex flex-col gap-2 rounded-md border border-ai/30 bg-ai/5 p-2 text-sm">
                  <pre class="max-h-48 overflow-auto whitespace-pre-wrap text-xs text-neutral-700 dark:text-neutral-300">{preview()}</pre>
                  <div class="flex justify-end gap-2">
                    <button onClick={doDiscard} class="rounded-md px-3 py-1.5 text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-700">취소</button>
                    <button onClick={doCommit} disabled={busy()} class="rounded-md bg-accent px-3 py-1.5 font-medium text-white hover:opacity-90 disabled:opacity-40">✓ 적용 (전체·실행취소 1단계)</button>
                  </div>
                </div>
              </Show>
            </Show>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog>
  );
}
