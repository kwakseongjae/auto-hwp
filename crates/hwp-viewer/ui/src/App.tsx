import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { createVirtualizer } from "@tanstack/solid-virtual";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { tinykeys } from "tinykeys";
import { api } from "./api";
import { type Command } from "./commands";
import { Palette } from "./Palette";
import { Composer, type ComposerMode } from "./Composer";
import { toast, Toaster } from "./toast";

/// 한칸 (Hankan) — Raycast-grade shell (Phase 0): a ⌘K command palette spine over the virtualized
/// SVG viewer, a minimal overlay-titlebar (doc + 2-tier capability chip + top-3 verbs + ⌘K hint),
/// an actionable hub empty-state, a structured composer, and toasts. All verbs map to typed Intents.
export default function App() {
  const [pageCount, setPageCount] = createSignal(0);
  const [svgCache, setSvgCache] = createSignal<Record<number, string>>({});
  const [docName, setDocName] = createSignal<string | null>(null);
  const [editable, setEditable] = createSignal(true);
  const [paletteOpen, setPaletteOpen] = createSignal(false);
  // Authoring is only safe on an editable (HWPX) doc — a view-only .hwp must be exported first.
  const canEdit = () => pageCount() > 0 && editable();
  const [composer, setComposer] = createSignal<ComposerMode>(null);

  let scrollRef!: HTMLDivElement;
  const inflight = new Set<number>();

  const virtualizer = createVirtualizer({
    get count() {
      return pageCount();
    },
    getScrollElement: () => scrollRef,
    estimateSize: () => 920,
    overscan: 2,
    gap: 24,
  });

  async function ensurePage(i: number) {
    if (svgCache()[i] !== undefined || inflight.has(i)) return;
    inflight.add(i);
    try {
      const svg = await api.renderPage(i);
      setSvgCache((c) => ({ ...c, [i]: svg }));
    } catch (e) {
      toast("warn", `렌더 실패(${i + 1}쪽): ${e}`);
    } finally {
      inflight.delete(i);
    }
  }
  function invalidate(n: number, scrollTo = 0) {
    setSvgCache({});
    setPageCount(n);
    queueMicrotask(() => virtualizer.scrollToIndex(Math.max(0, Math.min(scrollTo, n - 1))));
  }

  // ---- verbs (each maps to a typed Intent) ----
  async function doOpen() {
    const path = await openDialog({ filters: [{ name: "HWP/HWPX", extensions: ["hwpx", "hwp"] }] });
    if (typeof path !== "string") return;
    try {
      const r = await api.openDoc(path);
      setDocName(path.split("/").pop() ?? path);
      setEditable(r.editable);
      invalidate(r.pages);
      if (r.convertedPath) {
        // A binary .hwp was converted: an editable .hwpx was saved beside it.
        const saved = r.convertedPath.split("/").pop() ?? r.convertedPath;
        toast("ok", `${docName()} · ${r.pages}쪽 · 편집용 .hwpx 저장됨: ${saved}`);
      } else if (r.editable) {
        toast("ok", `${docName()} · ${r.pages}쪽`);
      } else {
        toast("warn", "보기전용 — 편집하려면 먼저 HWPX로 내보내세요", [
          { label: "HWPX로 내보내기", run: () => void doExport() },
        ]);
      }
    } catch (e) {
      toast("warn", `열기 실패: ${e}`);
    }
  }
  async function doExport() {
    if (pageCount() === 0) return;
    const path = await saveDialog({ defaultPath: "export.hwpx", filters: [{ name: "HWPX", extensions: ["hwpx"] }] });
    if (typeof path !== "string") return;
    try {
      toast("ok", await api.exportHwpx(path));
    } catch (e) {
      toast("warn", `내보내기 실패: ${e}`);
    }
  }
  async function doUndo() {
    if (pageCount() === 0) return;
    invalidate(await api.undo());
    toast("info", "실행 취소");
  }
  async function doRedo() {
    if (pageCount() === 0) return;
    invalidate(await api.redo());
    toast("info", "다시 실행");
  }

  const composerCtx = {
    applyContent: async (json: string) => {
      const n = await api.applyContent(json);
      invalidate(n, n - 1); // jump to the appended content (document end)
      toast("ok", "문서 끝에 추가됨", [{ label: "실행취소", run: () => void doUndo() }]);
    },
    generate: (p: string) => api.aiGenerate(p),
    propose: (json: string) => api.propose(json),
    commit: async () => {
      const n = await api.commitProposal();
      invalidate(n, n - 1);
      toast("ok", "제안 적용됨", [{ label: "실행취소", run: () => void doUndo() }]);
    },
    discard: () => api.discardProposal(),
  };

  // ---- palette command registry (reactive: disabled tracks pageCount) ----
  const commands = createMemo<Command[]>(() => {
    const haveDoc = pageCount() > 0;
    const edit = canEdit();
    return [
      { id: "open", title: "문서 열기", group: "문서", keys: "⌘O", keywords: "open 열기 파일", run: doOpen },
      { id: "export", title: "HWPX로 내보내기 / 저장", group: "문서", keys: "⌘S", keywords: "export 내보내기 저장 save hwpx", disabled: !haveDoc, run: doExport },
      { id: "table", title: "표 추가 (문서 끝에)", group: "작성", keys: "⌘T", keywords: "table 표 추가 그리드", disabled: !edit, run: () => { setComposer("table"); } },
      { id: "ai", title: "AI 콘텐츠 제안", group: "작성", keys: "⌘.", keywords: "ai 제안 작성 propose", tone: "ai", disabled: !edit, run: () => { setComposer("ai"); } },
      { id: "undo", title: "실행 취소", group: "편집", keys: "⌘Z", keywords: "undo 실행취소", disabled: !edit, run: doUndo },
      { id: "redo", title: "다시 실행", group: "편집", keys: "⌘⇧Z", keywords: "redo 다시실행", disabled: !edit, run: doRedo },
    ];
  });

  // ---- global shortcuts ----
  onMount(() => {
    const un = tinykeys(window, {
      "$mod+k": (e) => {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      },
      "$mod+o": (e) => {
        e.preventDefault();
        void doOpen();
      },
      "$mod+e": (e) => {
        e.preventDefault();
        void doExport();
      },
      "$mod+s": (e) => {
        e.preventDefault();
        void doExport();
      },
      "$mod+t": (e) => {
        e.preventDefault();
        if (canEdit()) setComposer("table");
      },
      "$mod+.": (e) => {
        e.preventDefault();
        if (canEdit()) setComposer("ai");
      },
      "$mod+z": (e) => {
        e.preventDefault();
        void doUndo();
      },
      "$mod+Shift+z": (e) => {
        e.preventDefault();
        void doRedo();
      },
    });
    onCleanup(un);
  });

  // deterministic dark mode from the native theme event
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

  // A control-strip button: icon + label + optional shortcut hint, left-aligned.
  const Tool = (p: { onClick: () => void; icon: string; label: string; keys?: string; tone?: "ai"; disabled?: boolean }) => (
    <button
      onClick={p.onClick}
      disabled={p.disabled}
      title={p.keys ? `${p.label} (${p.keys})` : p.label}
      class="flex items-center gap-1.5 rounded-md px-2 py-1 text-sm hover:bg-neutral-200/70 disabled:opacity-35 dark:hover:bg-neutral-700/60"
      classList={{ "text-ai": p.tone === "ai", "text-neutral-700 dark:text-neutral-200": p.tone !== "ai" }}
    >
      <span class="text-xs opacity-80">{p.icon}</span>
      <span>{p.label}</span>
      <Show when={p.keys}>
        <kbd class="ml-0.5 rounded bg-black/5 px-1 text-[10px] text-neutral-400 dark:bg-white/10">{p.keys}</kbd>
      </Show>
    </button>
  );
  const Sep = () => <span class="mx-1 h-5 w-px bg-black/10 dark:bg-white/10" />;

  return (
    <div class="flex h-full flex-col bg-neutral-100 text-neutral-900 dark:bg-neutral-900 dark:text-neutral-100">
      <header
        data-tauri-drag-region
        class="flex h-11 shrink-0 items-center gap-2 border-b border-black/10 bg-neutral-50/70 pl-20 pr-3 backdrop-blur-xl dark:border-white/10 dark:bg-neutral-800/60"
      >
        <Show when={docName()} fallback={<span data-tauri-drag-region class="text-sm font-semibold tracking-tight text-neutral-400">한칸</span>}>
          <span data-tauri-drag-region class="text-sm font-medium">{docName()}</span>
          <span data-tauri-drag-region class="text-xs text-neutral-400">· {pageCount()}쪽</span>
          <span
            class="flex items-center gap-1 rounded-full px-2 py-0.5 text-xs"
            classList={{
              "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400": editable(),
              "bg-neutral-500/15 text-neutral-500": !editable(),
            }}
          >
            <span class="h-1.5 w-1.5 rounded-full" classList={{ "bg-emerald-500": editable(), "bg-neutral-400": !editable() }} />
            {editable() ? "편집가능" : "보기전용"}
          </span>
        </Show>
        <div data-tauri-drag-region class="h-6 flex-1" />
        <button
          onClick={() => setPaletteOpen(true)}
          class="flex items-center gap-1.5 rounded-md border border-black/10 px-2.5 py-1 text-xs text-neutral-500 hover:bg-neutral-200/60 dark:border-white/10 dark:text-neutral-400 dark:hover:bg-neutral-700/60"
        >
          명령 <kbd class="rounded bg-black/5 px-1 dark:bg-white/10">⌘K</kbd>
        </button>
      </header>

      {/* Control strip: visible verbs, left-aligned (moved off the top-right). Shown once a doc opens. */}
      <Show when={pageCount() > 0}>
        <div class="flex h-10 shrink-0 items-center gap-0.5 border-b border-black/10 bg-neutral-50/40 px-2 dark:border-white/10 dark:bg-neutral-800/30">
          <Tool onClick={doOpen} icon="📂" label="열기" keys="⌘O" />
          <Tool onClick={doExport} icon="⬇︎" label="내보내기" keys="⌘S" />
          <Sep />
          <Tool onClick={() => setComposer("table")} icon="▦" label="표" keys="⌘T" disabled={!canEdit()} />
          <Tool onClick={() => setComposer("ai")} icon="✦" label="AI 작성" tone="ai" keys="⌘." disabled={!canEdit()} />
          <Sep />
          <Tool onClick={doUndo} icon="↩︎" label="실행취소" keys="⌘Z" disabled={!canEdit()} />
          <Tool onClick={doRedo} icon="↪︎" label="다시실행" disabled={!canEdit()} />
        </div>
      </Show>

      <main ref={scrollRef} class="min-h-0 flex-1 overflow-auto p-6">
        <Show
          when={pageCount() > 0}
          fallback={
            <div class="grid h-full place-items-center">
              <div class="flex flex-col items-center gap-4 text-center">
                <div class="text-5xl opacity-20">한칸</div>
                <div class="text-neutral-500 dark:text-neutral-400">한글 문서를 열어 시작하세요</div>
                <button onClick={doOpen} class="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90">
                  📂 문서 열기 <kbd class="opacity-70">⌘O</kbd>
                </button>
                <div class="text-xs text-neutral-400">또는 <kbd class="rounded bg-black/5 px-1 dark:bg-white/10">⌘K</kbd> 로 모든 명령</div>
              </div>
            </div>
          }
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
                      <Show when={svgCache()[item.index]} fallback={<div class="grid aspect-[1/1.414] place-items-center text-neutral-300">{item.index + 1}쪽…</div>}>
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

      <footer class="flex items-center gap-3 border-t border-black/10 px-4 py-1.5 text-xs text-neutral-500 dark:border-white/10 dark:text-neutral-400">
        <span>{pageCount() > 0 ? `${pageCount()}쪽` : "준비됨"}</span>
        <span class="flex-1" />
        <span><kbd>⌘K</kbd> 명령</span>
        <span><kbd>⌘E</kbd> 내보내기</span>
        <span><kbd>⌘Z</kbd> 실행취소</span>
      </footer>

      <Palette open={paletteOpen()} onOpenChange={setPaletteOpen} commands={commands()} />
      <Composer mode={composer()} onClose={() => setComposer(null)} ctx={composerCtx} />
      <Toaster />
    </div>
  );
}
