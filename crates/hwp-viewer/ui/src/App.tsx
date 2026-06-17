import { createSignal, For, Show } from "solid-js";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { api } from "./api";

/// tf-hwp viewer shell (Phase 1 skeleton): toolbar + virtualizable page list + AI panel, all
/// driven through the typed `Intent` command lane. Premium chrome/motion + the editable canvas
/// land in later phases; this is the working frontend skeleton replacing the vanilla placeholder.
export default function App() {
  const [pages, setPages] = createSignal<string[]>([]);
  const [status, setStatus] = createSignal("문서를 여세요.");
  const [busy, setBusy] = createSignal(false);
  const [aiOpen, setAiOpen] = createSignal(false);
  const [content, setContent] = createSignal(
    '{"blocks":[{"type":"heading","text":"제목","style":"개요 1"},{"type":"paragraph","runs":[{"text":"본문 "},{"text":"강조","bold":true}]}]}',
  );

  /// Re-render every page of the live document into the page column.
  async function refresh(n: number) {
    const svgs: string[] = [];
    for (let i = 0; i < n; i++) svgs.push(await api.renderPage(i));
    setPages(svgs);
  }

  async function guard<T>(label: string, f: () => Promise<T>) {
    setBusy(true);
    try {
      return await f();
    } catch (e) {
      setStatus(`${label} 실패: ${e}`);
    } finally {
      setBusy(false);
    }
  }

  async function openDoc() {
    const path = await openDialog({ filters: [{ name: "HWP/HWPX", extensions: ["hwpx", "hwp"] }] });
    if (typeof path !== "string") return;
    await guard("열기", async () => {
      const n = await api.openDoc(path);
      await refresh(n);
      setStatus(`${path.split("/").pop()} · ${n}쪽`);
    });
  }

  async function applyContent() {
    await guard("적용", async () => {
      const n = await api.applyContent(content());
      await refresh(n);
      setStatus(`적용됨 · ${n}쪽`);
    });
  }

  async function exportHwpx() {
    const path = await saveDialog({ defaultPath: "export.hwpx", filters: [{ name: "HWPX", extensions: ["hwpx"] }] });
    if (typeof path !== "string") return;
    await guard("내보내기", async () => setStatus(await api.exportHwpx(path)));
  }

  const step = (label: string, f: () => Promise<number>) => () =>
    guard(label, async () => {
      const n = await f();
      await refresh(n);
      setStatus(`${label} · ${n}쪽`);
    });

  const Btn = (p: { onClick: () => void; children: any; disabled?: boolean }) => (
    <button
      onClick={p.onClick}
      disabled={p.disabled || busy()}
      class="rounded-md px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-200/70 active:bg-neutral-300/70 disabled:opacity-40 dark:text-neutral-200 dark:hover:bg-neutral-700/60"
    >
      {p.children}
    </button>
  );

  return (
    <div class="flex h-full flex-col bg-neutral-100 text-neutral-900 dark:bg-neutral-900 dark:text-neutral-100">
      {/* Toolbar (a placeholder for the Overlay titlebar + vibrancy chrome of Phase 2). */}
      <header class="flex items-center gap-1 border-b border-black/10 bg-neutral-50/80 px-3 py-2 backdrop-blur dark:border-white/10 dark:bg-neutral-800/70">
        <Btn onClick={openDoc}>📂 열기</Btn>
        <Btn onClick={step("실행 취소", api.undo)}>↩︎ 실행취소</Btn>
        <Btn onClick={step("다시 실행", api.redo)}>↪︎ 다시실행</Btn>
        <Btn onClick={exportHwpx} disabled={pages().length === 0}>⬇︎ 내보내기</Btn>
        <div class="flex-1" />
        <span class="px-2 text-xs text-neutral-500 dark:text-neutral-400">{status()}</span>
        <Btn onClick={() => setAiOpen(!aiOpen())}>🤖 AI</Btn>
      </header>

      <div class="flex min-h-0 flex-1">
        {/* Page column. Phase 3 will virtualize this (TanStack Virtual) over the cached renderer. */}
        <main class="flex-1 overflow-auto p-6">
          <Show
            when={pages().length > 0}
            fallback={<div class="grid h-full place-items-center text-neutral-400">열린 문서가 없습니다</div>}
          >
            <div class="mx-auto flex max-w-3xl flex-col items-center gap-6">
              <For each={pages()}>
                {(svg, i) => (
                  <div class="w-full rounded-lg bg-white shadow-md ring-1 ring-black/5">
                    <div class="page-svg" data-page={i()} innerHTML={svg} />
                  </div>
                )}
              </For>
            </div>
          </Show>
        </main>

        {/* AI panel: author template content → apply through the op-bus (one undo unit). */}
        <Show when={aiOpen()}>
          <aside class="flex w-96 flex-col gap-3 border-l border-black/10 bg-neutral-50 p-4 dark:border-white/10 dark:bg-neutral-800">
            <h3 class="text-sm font-semibold">AI 콘텐츠 (템플릿 JSON)</h3>
            <textarea
              spellcheck={false}
              class="h-64 w-full resize-none rounded-md border border-black/10 bg-white p-2 font-mono text-xs dark:border-white/10 dark:bg-neutral-900"
              value={content()}
              onInput={(e) => setContent(e.currentTarget.value)}
            />
            <Btn onClick={applyContent} disabled={pages().length === 0}>적용 (op-bus)</Btn>
          </aside>
        </Show>
      </div>
    </div>
  );
}
