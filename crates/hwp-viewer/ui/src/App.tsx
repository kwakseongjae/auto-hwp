import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { createVirtualizer } from "@tanstack/solid-virtual";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api } from "./api";

/// tf-hwp viewer (Phase 1–3): Overlay-titlebar chrome + a VIRTUALIZED page list that lazily
/// renders only on-screen pages through the cached engine (seam 1), plus an AI panel — all driven
/// by the typed `Intent` command lane. The editable canvas + Korean IME land in Phase 4.
export default function App() {
  const [pageCount, setPageCount] = createSignal(0);
  const [svgCache, setSvgCache] = createSignal<Record<number, string>>({});
  const [status, setStatus] = createSignal("문서를 여세요.");
  const [busy, setBusy] = createSignal(false);
  const [aiOpen, setAiOpen] = createSignal(false);
  const [preview, setPreview] = createSignal<string | null>(null);
  const [content, setContent] = createSignal(
    '{"blocks":[{"type":"heading","text":"제목","style":"개요 1"},{"type":"paragraph","runs":[{"text":"본문 "},{"text":"강조","bold":true}]}]}',
  );

  let scrollRef!: HTMLDivElement;
  const inflight = new Set<number>();

  // Virtualize the page column: only on-screen pages (+overscan) exist in the DOM. Heights vary,
  // so estimate then refine via measureElement.
  const virtualizer = createVirtualizer({
    get count() {
      return pageCount();
    },
    getScrollElement: () => scrollRef,
    estimateSize: () => 920,
    overscan: 2,
    gap: 24,
  });

  /// Render a page on demand (once), filling the cache. Pages already cached or in flight are skipped.
  async function ensurePage(i: number) {
    if (svgCache()[i] !== undefined || inflight.has(i)) return;
    inflight.add(i);
    try {
      const svg = await api.renderPage(i);
      setSvgCache((c) => ({ ...c, [i]: svg }));
    } catch (e) {
      setStatus(`렌더 실패(${i + 1}쪽): ${e}`);
    } finally {
      inflight.delete(i);
    }
  }

  /// After a mutation (open/edit/undo/redo) the document changed: drop cached pages and reset count.
  function invalidate(n: number) {
    setSvgCache({});
    setPageCount(n);
    virtualizer.scrollToIndex(0);
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

  // Deterministic dark mode from the native theme event (WKWebView prefers-color-scheme is flaky).
  onMount(async () => {
    const apply = (t: string | null) => document.documentElement.classList.toggle("dark", t === "dark");
    try {
      const w = getCurrentWindow();
      apply(await w.theme());
      onCleanup(await w.onThemeChanged(({ payload }) => apply(payload)));
    } catch {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      const onChange = () => apply(mq.matches ? "dark" : "light");
      onChange();
      mq.addEventListener("change", onChange);
      onCleanup(() => mq.removeEventListener("change", onChange));
    }
  });

  async function openDoc() {
    const path = await openDialog({ filters: [{ name: "HWP/HWPX", extensions: ["hwpx", "hwp"] }] });
    if (typeof path !== "string") return;
    await guard("열기", async () => {
      const n = await api.openDoc(path);
      invalidate(n);
      setStatus(`${path.split("/").pop()} · ${n}쪽`);
    });
  }

  // AI diff/approve loop: propose (dry-run preview) → commit (apply, one undo unit) / discard.
  async function doPropose() {
    await guard("미리보기", async () => {
      setPreview(await api.propose(content()));
      setStatus("제안 준비됨 — 적용 또는 취소");
    });
  }
  async function doCommit() {
    await guard("적용", async () => {
      const n = await api.commitProposal();
      setPreview(null);
      invalidate(n);
      setStatus(`적용됨 · ${n}쪽`);
    });
  }
  async function doDiscard() {
    await api.discardProposal().catch(() => {});
    setPreview(null);
    setStatus("제안 취소됨");
  }

  async function exportHwpx() {
    const path = await saveDialog({ defaultPath: "export.hwpx", filters: [{ name: "HWPX", extensions: ["hwpx"] }] });
    if (typeof path !== "string") return;
    await guard("내보내기", async () => setStatus(await api.exportHwpx(path)));
  }

  const step = (label: string, f: () => Promise<number>) => () =>
    guard(label, async () => {
      const n = await f();
      invalidate(n);
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
      <header
        data-tauri-drag-region
        class="flex items-center gap-1 border-b border-black/10 bg-neutral-50/70 py-2.5 pl-20 pr-3 backdrop-blur-xl dark:border-white/10 dark:bg-neutral-800/60"
      >
        <Btn onClick={openDoc}>📂 열기</Btn>
        <Btn onClick={step("실행 취소", api.undo)} disabled={pageCount() === 0}>↩︎ 실행취소</Btn>
        <Btn onClick={step("다시 실행", api.redo)} disabled={pageCount() === 0}>↪︎ 다시실행</Btn>
        <Btn onClick={exportHwpx} disabled={pageCount() === 0}>⬇︎ 내보내기</Btn>
        <div data-tauri-drag-region class="h-6 flex-1" />
        <span data-tauri-drag-region class="px-2 text-xs text-neutral-500 dark:text-neutral-400">{status()}</span>
        <Btn onClick={() => setAiOpen(!aiOpen())}>🤖 AI</Btn>
      </header>

      <div class="flex min-h-0 flex-1">
        <main ref={scrollRef} class="flex-1 overflow-auto p-6">
          <Show
            when={pageCount() > 0}
            fallback={<div class="grid h-full place-items-center text-neutral-400">열린 문서가 없습니다</div>}
          >
            <div class="relative mx-auto max-w-3xl" style={{ height: `${virtualizer.getTotalSize()}px` }}>
              <For each={virtualizer.getVirtualItems()}>
                {(item) => {
                  ensurePage(item.index);
                  return (
                    <div
                      ref={(el) => queueMicrotask(() => virtualizer.measureElement(el))}
                      data-index={item.index}
                      class="absolute left-0 w-full"
                      style={{ transform: `translateY(${item.start}px)` }}
                    >
                      <div
                        class="w-full rounded-lg bg-white shadow-md ring-1 ring-black/5"
                        style={{ "content-visibility": "auto", "contain-intrinsic-size": "auto 920px" }}
                      >
                        <Show
                          when={svgCache()[item.index]}
                          fallback={<div class="grid aspect-[1/1.414] place-items-center text-neutral-300">{item.index + 1}쪽…</div>}
                        >
                          <div class="page-svg" innerHTML={svgCache()[item.index]} />
                        </Show>
                      </div>
                    </div>
                  );
                }}
              </For>
            </div>
          </Show>
        </main>

        <Show when={aiOpen()}>
          <aside class="flex w-96 flex-col gap-3 border-l border-black/10 bg-neutral-50 p-4 dark:border-white/10 dark:bg-neutral-800">
            <h3 class="text-sm font-semibold">AI 콘텐츠 (템플릿 JSON)</h3>
            <textarea
              spellcheck={false}
              class="h-48 w-full resize-none rounded-md border border-black/10 bg-white p-2 font-mono text-xs dark:border-white/10 dark:bg-neutral-900"
              value={content()}
              onInput={(e) => setContent(e.currentTarget.value)}
            />
            <Btn onClick={doPropose} disabled={pageCount() === 0}>미리보기 (제안)</Btn>
            <Show when={preview()}>
              <div class="flex flex-col gap-2 rounded-md border border-amber-400/40 bg-amber-50 p-2 dark:bg-amber-950/30">
                <pre class="max-h-48 overflow-auto whitespace-pre-wrap text-xs text-neutral-700 dark:text-neutral-300">{preview()}</pre>
                <div class="flex gap-2">
                  <button
                    onClick={doCommit}
                    disabled={busy()}
                    class="flex-1 rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-40"
                  >
                    ✓ 적용
                  </button>
                  <button
                    onClick={doDiscard}
                    disabled={busy()}
                    class="rounded-md px-3 py-1.5 text-sm font-medium text-neutral-600 hover:bg-neutral-200/70 dark:text-neutral-300 dark:hover:bg-neutral-700/60"
                  >
                    취소
                  </button>
                </div>
              </div>
            </Show>
          </aside>
        </Show>
      </div>
    </div>
  );
}
