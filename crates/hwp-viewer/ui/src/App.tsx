import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { createVirtualizer } from "@tanstack/solid-virtual";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { tinykeys } from "tinykeys";
import { api, type CaretRect, type FindMatch } from "./api";
import { sanitizeSvg } from "./sanitize";
import { advanceOffset, pageToScreen, screenToPage } from "./caret";
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
  // Heavy work (open/export) runs on a Rust spawn_blocking worker; show a blocking overlay while it
  // runs so a tens-of-MB file reads as "working", not a hang. `busyLabel` doubles as the on/off flag.
  const [busyLabel, setBusyLabel] = createSignal<string | null>(null);
  // Per-page renders are async too; a subtle "loading…" badge shows when any page is in flight.
  const [rendering, setRendering] = createSignal(false);

  // ---- Find / Replace bar state ----
  // A docked top bar (⌘F to open, Esc to close). v1 backend scope: searches only the document's
  // PARSED simple body paragraphs (NodeId-bearing) — appended/AI content, table cells, headers/
  // footers, notes and cross-paragraph queries are NOT matched (surfaced in the bar's hint copy).
  const [findOpen, setFindOpen] = createSignal(false);
  const [findQuery, setFindQuery] = createSignal("");
  const [replaceQuery, setReplaceQuery] = createSignal("");
  const [caseSensitive, setCaseSensitive] = createSignal(false);
  // `matches===null` = not searched yet; `[]` = searched, zero hits (drives the count label).
  const [matches, setMatches] = createSignal<FindMatch[] | null>(null);
  const [finding, setFinding] = createSignal(false);
  let findInputRef!: HTMLInputElement;

  let scrollRef!: HTMLDivElement;
  const inflight = new Set<number>();

  // ---- Interactive caret state (the P1 "interactive half", built on the shipped caret engine) ----
  // `caret` is the EDITABLE model anchor; we ONLY ever store a non-null target (a click on a cell /
  // unanchored run — HitTarget.node===null — clears it instead). page = which rendered page the
  // click landed on; node = the editable NodeId (guaranteed non-null here); offset = paragraph char
  // offset (Unicode-scalar count over the paragraph's concatenated run text); len = the paragraph's
  // editable char length (so we clamp moves to it — caret_rect CLAMPS past-end offsets and returns a
  // rect, so a null rect can NOT be used to detect end-of-paragraph).
  const [caret, setCaret] = createSignal<{ page: number; node: number; offset: number; len: number } | null>(null);
  // `caretRect` = the PAGE-unit geometry from api.caretRect, recomputed after every move/edit. It is
  // null in the legitimate "anchor reflowed off this page → hide overlay until next click" state
  // (caret set, caretRect null). The inverse (caretRect set while caret null) is impossible.
  const [caretRect, setCaretRect] = createSignal<CaretRect | null>(null);
  // `caretBox` = the caret geometry already converted to CSS px (left/top/height) against the live
  // svg rect, so the overlay renders without re-reading rects mid-render. Recomputed in the same
  // async step that sets caretRect. Null whenever caretRect is null (overlay hidden).
  const [caretBox, setCaretBox] = createSignal<{ left: number; top: number; height: number } | null>(null);
  // IME guard: true between compositionstart and compositionend; keydown early-returns while true so
  // the printable-char path never double-inserts the IME's already-committed text.
  const [composing, setComposing] = createSignal(false);
  const caretActive = () => caret() !== null;
  // Non-reactive ref to the hidden off-screen input that captures keystrokes + composition events.
  let imeInput!: HTMLInputElement;
  // Edit SERIALIZER: a mutation (insert/delete/IME-commit) is spawn_blocking behind the session
  // Mutex, and offset bookkeeping is read-modify-write. Rather than DROP input that arrives mid-edit
  // (which would lose a fast typist's keystrokes / a committed IME syllable), we chain every edit and
  // move through one promise queue so they apply strictly in order, each reading the caret AFTER the
  // prior one resolved. Errors are toasted and don't break the chain.
  let editQueue: Promise<unknown> = Promise.resolve();
  function enqueueEdit(fn: () => Promise<void>): Promise<void> {
    const next = editQueue.then(fn).catch((err) => {
      toast("warn", `${err}`);
    });
    editQueue = next;
    return next;
  }

  // Re-acquire THIS page's live <svg> el by data-index under the scroll container, so caret geometry
  // uses the current on-screen rect after any scroll. querySelector finds the innerHTML-injected svg.
  function svgForPage(page: number): SVGSVGElement | null {
    if (!scrollRef) return null;
    return scrollRef.querySelector(`[data-index="${page}"] svg`) as SVGSVGElement | null;
  }
  // Convert the current caretRect (PAGE units) → CSS px against `page`'s live svg rect, store in
  // caretBox. Called after every move/edit (and after re-render microtasks). Hides the box if the
  // page isn't laid out / rect is degenerate.
  function recomputeCaretBox(page: number, r: CaretRect | null) {
    if (!r) {
      setCaretBox(null);
      return;
    }
    const svg = svgForPage(page);
    if (!svg) {
      setCaretBox(null);
      return;
    }
    const rect = svg.getBoundingClientRect();
    const vb = svg.viewBox.baseVal;
    const box = pageToScreen(r, { width: rect.width, height: rect.height }, { width: vb.width, height: vb.height });
    setCaretBox(box);
  }
  function clearCaret() {
    setCaret(null);
    setCaretRect(null);
    setCaretBox(null);
    setComposing(false);
  }

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
    setRendering(true);
    try {
      const svg = await api.renderPage(i);
      // Sanitize once, on ingest: rhwp-produced SVG is untrusted (a malicious .hwp could embed
      // <script>/on*/<foreignObject>) and is injected via innerHTML below.
      setSvgCache((c) => ({ ...c, [i]: sanitizeSvg(svg) }));
    } catch (e) {
      toast("warn", `렌더 실패(${i + 1}쪽): ${e}`);
    } finally {
      inflight.delete(i);
      setRendering(inflight.size > 0);
    }
  }
  function invalidate(n: number, scrollTo = 0) {
    setSvgCache({});
    setPageCount(n);
    // Any doc-level change (undo/redo/replace/open/apply) can drop the NodeId the caret pointed at,
    // so never leave a stale anchor — the typed caret path (invalidateKeepingCaret) is the only one
    // that re-establishes a caret after a mutation.
    clearCaret();
    queueMicrotask(() => virtualizer.scrollToIndex(Math.max(0, Math.min(scrollTo, n - 1))));
  }

  // Re-render after an in-place edit (insert/delete) while KEEPING the caret anchored: the doc just
  // reflowed and page_count may have changed, so we reuse the invalidate() teardown (drop svgCache +
  // set pageCount) but, in a microtask AFTER the re-render, re-query caret_rect at the wanted offset
  // and reposition. If the paragraph reflowed off `want.page` (caretRect===null) we keep the anchor
  // but hide the overlay until it reflows back / the next click (spec'd behavior). Also re-focus the
  // hidden imeInput because the innerHTML re-render blurs it (keystrokes would silently stop).
  async function invalidateKeepingCaret(n: number, want: { page: number; node: number; offset: number; len: number }) {
    setSvgCache({});
    setPageCount(n);
    setCaret(want);
    // Let the For body re-render the page svgs before we read their rects / fetch geometry.
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    try {
      const r = await api.caretRect(want.page, want.node, want.offset);
      setCaretRect(r);
      recomputeCaretBox(want.page, r);
    } catch {
      setCaretRect(null);
      setCaretBox(null);
    }
    imeInput?.focus();
  }

  // ---- caret: click-to-place ----
  // Attached to the page-list wrapper. DOM glue lives here (caret.ts stays DOM-free): find the
  // clicked page via its [data-index] ancestor, read the live svg rect, map the click to page units,
  // hit-test, and place an EDITABLE caret only when HitTarget.node!=null. A view-only .hwp skips the
  // whole thing (no caret on a doc you can't edit). A null-node target (cell / unanchored run) clears
  // the caret and hints why — we never store a typeable caret on a non-editable target.
  async function onPageClick(e: MouseEvent) {
    if (!canEdit()) return; // view-only docs show no caret
    const host = (e.target as Element).closest("[data-index]");
    if (!host) return;
    const page = Number(host.getAttribute("data-index"));
    if (!Number.isFinite(page)) return;
    const svg = host.querySelector("svg") as SVGSVGElement | null;
    if (!svg) return; // page not rendered yet
    const rect = svg.getBoundingClientRect();
    const vb = svg.viewBox.baseVal;
    const pt = screenToPage(
      e.clientX,
      e.clientY,
      { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      { width: vb.width, height: vb.height },
    );
    if (!pt) return; // page not laid out yet (zero dims)
    try {
      const hit = await api.hitTest(page, pt.x, pt.y);
      if (!hit || hit.node === null) {
        // Off any editable text line, OR a cell / unanchored run (node===null): not editable.
        clearCaret();
        if (hit && hit.node === null) toast("info", "표/머리말 등은 아직 편집할 수 없습니다");
        return;
      }
      const want = { page, node: hit.node, offset: hit.offset, len: hit.paraLen };
      const r = await api.caretRect(page, want.node, want.offset);
      setCaret(want);
      setCaretRect(r);
      recomputeCaretBox(page, r);
      // Route all subsequent keystrokes + composition through the hidden input.
      imeInput?.focus();
    } catch (err) {
      toast("warn", `캐럿 배치 실패: ${err}`);
    }
  }

  // ---- caret: edit loop (every helper is enqueued so concurrent input never races/drops; each is a
  // no-op unless there is an editable caret, read AFTER the prior queued edit resolved) ----
  // Insert `text` (one printable char, or a whole committed IME syllable cluster = ONE undo unit).
  function doInsert(text: string) {
    void enqueueEdit(async () => {
      const c = caret();
      if (!c || !canEdit()) return;
      // P0-3 contract: a structural paragraph (inline image/equation) or out-of-range offset refuses
      // in place — the queue's .catch surfaces the op-bus message, leaves the caret put, never crashes.
      const inserted = advanceOffset(c.offset, text) - c.offset;
      const pages = await api.insertText(c.node, c.offset, text);
      await invalidateKeepingCaret(pages, { ...c, offset: c.offset + inserted, len: c.len + inserted });
    });
  }
  function doDelete() {
    void enqueueEdit(async () => {
      const c = caret();
      if (!c || !canEdit() || c.offset === 0) return;
      const pages = await api.deleteBack(c.node, c.offset);
      await invalidateKeepingCaret(pages, { ...c, offset: c.offset - 1, len: Math.max(0, c.len - 1) });
    });
  }
  // Move ±1 char, clamped to the paragraph [0, len] (NOT inferred from a null caret_rect — the engine
  // CLAMPS past-end offsets and returns a rect, so a runaway offset would otherwise desync the model).
  // No mutation → no re-render, just reposition the overlay. Enqueued so it can't reorder against edits.
  function doMove(d: -1 | 1) {
    void enqueueEdit(async () => {
      const c = caret();
      if (!c) return;
      const newOffset = c.offset + d;
      if (newOffset < 0 || newOffset > c.len) return; // at a paragraph edge — leave the caret put
      const r = await api.caretRect(c.page, c.node, newOffset);
      if (r === null) return; // reflowed off this page — keep the anchor
      setCaret({ ...c, offset: newOffset });
      setCaretRect(r);
      recomputeCaretBox(c.page, r);
    });
  }

  // ---- caret: keyboard + IME handlers (attached to the hidden imeInput, NOT window, so ⌘K/⌘F and
  // palette typing keep working). ----
  function onCaretKeyDown(e: KeyboardEvent) {
    // IME owns the keys while composing; the final text commits on compositionend. This early-return
    // is the double-insert guard (the browser fires keydown with isComposing===true for IME keys).
    if (composing() || e.isComposing) return;
    // Let ⌘/Ctrl/Alt shortcuts bubble (⌘Z undo, ⌘F find, …) — don't treat them as text.
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (!caretActive()) return;
    if (e.key.length === 1) {
      e.preventDefault();
      void doInsert(e.key);
    } else if (e.key === "Backspace") {
      e.preventDefault();
      void doDelete();
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      void doMove(-1);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      void doMove(1);
    } else if (e.key === "Escape") {
      e.preventDefault();
      clearCaret();
    }
    // Home/End/selection/drag-highlight are intentionally NOT handled in this slice (next P1).
  }
  function onCompositionStart() {
    setComposing(true);
  }
  function onCompositionUpdate() {
    // v1: no in-place composing preview; the half-built syllable shows only in the (hidden) input.
    // Final text commits on compositionend. A future pass would draw the composing jamo at the caret.
  }
  function onCompositionEnd(e: CompositionEvent) {
    setComposing(false);
    // Capture the committed text SYNCHRONOUSLY (before clearing the input), so a syllable committing
    // while a prior edit is still in flight is never lost — it goes onto the serialized edit queue.
    // WKWebView (macOS Tauri target) supplies the committed Hangul in e.data; fall back to the input's
    // own value if a platform/IME leaves e.data empty. A cancelled composition → empty → no-op.
    const text = e.data || imeInput?.value || "";
    if (imeInput) imeInput.value = ""; // never re-feed on the next composition
    if (!text) return;
    // Commit the WHOLE finalized string as ONE insertText (one undo unit) via the shared edit path.
    doInsert(text);
  }

  // ---- verbs (each maps to a typed Intent) ----
  async function doOpen() {
    const path = await openDialog({ filters: [{ name: "HWP/HWPX", extensions: ["hwpx", "hwp"] }] });
    if (typeof path !== "string") return;
    setBusyLabel("문서 여는 중…");
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
    } finally {
      setBusyLabel(null);
    }
  }
  async function doExport() {
    if (pageCount() === 0) return;
    const path = await saveDialog({ defaultPath: "export.hwpx", filters: [{ name: "HWPX", extensions: ["hwpx"] }] });
    if (typeof path !== "string") return;
    setBusyLabel("내보내는 중…");
    try {
      toast("ok", await api.exportHwpx(path));
    } catch (e) {
      toast("warn", `내보내기 실패: ${e}`);
    } finally {
      setBusyLabel(null);
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

  // ---- Find / Replace verbs ----
  function openFind() {
    if (pageCount() === 0) return;
    setFindOpen(true);
    // Focus + select the field on the next frame so ⌘F over an existing query re-targets it.
    queueMicrotask(() => {
      findInputRef?.focus();
      findInputRef?.select();
    });
  }
  function closeFind() {
    setFindOpen(false);
    setMatches(null);
  }
  // 찾기: count hits (read-only). Cheap, so a light inline spinner — not the blocking overlay.
  async function doFind() {
    const q = findQuery();
    if (!q) {
      setMatches(null);
      return;
    }
    setFinding(true);
    try {
      setMatches(await api.findText(q, caseSensitive()));
    } catch (e) {
      toast("warn", `찾기 실패: ${e}`);
    } finally {
      setFinding(false);
    }
  }
  // 바꾸기(all=false → first match) / 모두 바꾸기(all=true). Each is ONE undo unit; we reuse the
  // exact invalidate() path (drop SVG cache + new page count) so the doc re-renders post-mutation.
  async function doReplace(all: boolean) {
    const q = findQuery();
    if (!q || !canEdit()) return;
    setBusyLabel(all ? "모두 바꾸는 중…" : "바꾸는 중…");
    try {
      const r = await api.replaceText(q, replaceQuery(), caseSensitive(), false, all);
      invalidate(r.pages);
      if (r.replaced > 0) {
        toast("ok", `${r.replaced}개 바꿈`, [{ label: "실행취소", run: () => void doUndo() }]);
        // Offsets shifted after a replace — re-run find so the count reflects the new doc.
        await doFind();
      } else {
        toast("info", "바꿀 항목 없음");
        setMatches([]);
      }
    } catch (e) {
      toast("warn", `바꾸기 실패: ${e}`);
    } finally {
      setBusyLabel(null);
    }
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
      { id: "find", title: "찾기 / 바꾸기", group: "편집", keys: "⌘F", keywords: "find replace 찾기 바꾸기 검색 치환", disabled: !haveDoc, run: openFind },
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
      "$mod+f": (e) => {
        e.preventDefault();
        openFind();
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
    <div class="relative flex h-full flex-col bg-neutral-100 text-neutral-900 dark:bg-neutral-900 dark:text-neutral-100">
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

      {/* Find / Replace bar (⌘F). Docked under the control strip, same overlay-toolbar look.
          No caret/scroll-to-match geometry yet (next P1 piece) — so we DON'T fake a jump/highlight;
          we honestly show a hit count + a few match snippets. Replace-all + count work fully. */}
      <Show when={findOpen() && pageCount() > 0}>
        <div class="flex shrink-0 flex-col gap-1.5 border-b border-black/10 bg-neutral-50/60 px-3 py-2 backdrop-blur-xl dark:border-white/10 dark:bg-neutral-800/50">
          <div class="flex flex-wrap items-center gap-2">
            <input
              ref={findInputRef}
              value={findQuery()}
              onInput={(e) => {
                setFindQuery(e.currentTarget.value);
                setMatches(null); // query changed → stale count
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  closeFind();
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  void doFind();
                }
              }}
              placeholder="찾을 내용"
              class="w-48 rounded-md border border-black/10 bg-white px-2 py-1 text-sm outline-none focus:border-accent dark:border-white/10 dark:bg-neutral-900"
            />
            <input
              value={replaceQuery()}
              onInput={(e) => setReplaceQuery(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  closeFind();
                }
              }}
              placeholder="바꿀 내용"
              disabled={!canEdit()}
              class="w-48 rounded-md border border-black/10 bg-white px-2 py-1 text-sm outline-none focus:border-accent disabled:opacity-40 dark:border-white/10 dark:bg-neutral-900"
            />
            <label class="flex cursor-pointer select-none items-center gap-1.5 text-xs text-neutral-600 dark:text-neutral-300">
              <input
                type="checkbox"
                checked={caseSensitive()}
                onChange={(e) => {
                  setCaseSensitive(e.currentTarget.checked);
                  setMatches(null); // option changed → stale count
                }}
                class="accent-accent"
              />
              대소문자 구분
            </label>
            <span class="mx-0.5 h-5 w-px bg-black/10 dark:bg-white/10" />
            <button
              onClick={() => void doFind()}
              disabled={!findQuery() || finding()}
              class="rounded-md px-2 py-1 text-sm text-neutral-700 hover:bg-neutral-200/70 disabled:opacity-35 dark:text-neutral-200 dark:hover:bg-neutral-700/60"
            >
              찾기
            </button>
            <button
              onClick={() => void doReplace(false)}
              disabled={!findQuery() || !canEdit() || !!busyLabel()}
              title="문서의 첫 일치 항목을 바꿉니다"
              class="rounded-md px-2 py-1 text-sm text-neutral-700 hover:bg-neutral-200/70 disabled:opacity-35 dark:text-neutral-200 dark:hover:bg-neutral-700/60"
            >
              바꾸기
            </button>
            <button
              onClick={() => void doReplace(true)}
              disabled={!findQuery() || !canEdit() || !!busyLabel()}
              class="rounded-md px-2 py-1 text-sm text-neutral-700 hover:bg-neutral-200/70 disabled:opacity-35 dark:text-neutral-200 dark:hover:bg-neutral-700/60"
            >
              모두 바꾸기
            </button>
            <span class="flex-1" />
            {/* honest status: spinner while finding, then a hit count (null = not searched yet) */}
            <Show when={finding()}>
              <span class="flex items-center gap-1.5 text-xs text-neutral-400">
                <span class="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
                찾는 중…
              </span>
            </Show>
            <Show when={!finding() && matches() !== null}>
              <span class="text-xs text-neutral-500 dark:text-neutral-400">
                {matches()!.length > 0 ? `${matches()!.length}개 찾음` : "찾는 결과 없음"}
              </span>
            </Show>
            <button
              onClick={closeFind}
              title="닫기 (Esc)"
              class="rounded-md px-1.5 py-1 text-xs text-neutral-400 hover:bg-neutral-200/70 dark:hover:bg-neutral-700/60"
            >
              ✕
            </button>
          </div>
          {/* No caret geometry yet → no scroll-to / in-page highlight. We surface a few snippet
              previews instead of faking a jump (full highlight needs the P1 caret-geometry work). */}
          <Show when={!finding() && matches() !== null && matches()!.length > 0}>
            <div class="flex items-center gap-2 text-[11px] text-neutral-400">
              <span class="shrink-0">위치</span>
              <span class="truncate">
                {matches()!
                  .slice(0, 8)
                  .map((m) => `${m.section + 1}-${m.block + 1}`)
                  .join(", ")}
                {matches()!.length > 8 ? " …" : ""}
              </span>
            </div>
          </Show>
          <p class="text-[11px] text-neutral-400">
            본문의 단순 문단만 검색합니다 (표·머리말/꼬리말·각주, 추가한 콘텐츠, 문단 경계를 넘는 검색 제외).
          </p>
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
          <div class="relative mx-auto max-w-3xl" style={{ height: `${virtualizer.getTotalSize()}px` }} onClick={(e) => void onPageClick(e)}>
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
                    {/* The svg-host wrapper is `relative` so the caret overlay (absolute) positions
                        against it and scrolls with the page automatically (shared scroll context). */}
                    <div
                      class="relative w-full rounded-lg bg-white shadow-md ring-1 ring-black/5"
                      style={{ "content-visibility": "auto", "contain-intrinsic-size": "auto 920px" }}
                    >
                      <Show when={svgCache()[item.index]} fallback={<div class="grid aspect-[1/1.414] place-items-center text-neutral-300">{item.index + 1}쪽…</div>}>
                        <div class="page-svg" innerHTML={svgCache()[item.index]} />
                      </Show>
                      {/* Blinking caret overlay. Renders only when BOTH caret() and caretBox() exist
                          AND this is the caret's page — so the reflowed-off-page state (caretBox null)
                          hides it until the next click. pointer-events-none so it never eats a click. */}
                      <Show when={caretActive() && caretRect() && caretBox() && caret()!.page === item.index}>
                        <div
                          class="caret-blink pointer-events-none absolute z-10 w-px bg-accent"
                          style={{
                            left: `${caretBox()!.left}px`,
                            top: `${caretBox()!.top}px`,
                            height: `${caretBox()!.height}px`,
                          }}
                        />
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
        <Show when={rendering()}>
          <span class="flex items-center gap-1.5 text-neutral-400">
            <span class="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
            렌더 중…
          </span>
        </Show>
        <span class="flex-1" />
        <span><kbd>⌘K</kbd> 명령</span>
        <span><kbd>⌘F</kbd> 찾기</span>
        <span><kbd>⌘E</kbd> 내보내기</span>
        <span><kbd>⌘Z</kbd> 실행취소</span>
      </footer>

      {/* Blocking overlay during heavy open/export so a large file reads as "working", not a hang. */}
      <Show when={busyLabel()}>
        <div class="absolute inset-0 z-50 grid place-items-center bg-black/20 backdrop-blur-sm dark:bg-black/40">
          <div class="flex items-center gap-3 rounded-lg bg-neutral-50/90 px-5 py-3 text-sm shadow-lg ring-1 ring-black/10 dark:bg-neutral-800/90 dark:ring-white/10">
            <span class="h-4 w-4 animate-spin rounded-full border-2 border-neutral-400 border-t-transparent" />
            <span class="text-neutral-700 dark:text-neutral-200">{busyLabel()}</span>
          </div>
        </div>
      </Show>

      {/* Hidden off-screen IME-capture input. Keystrokes + composition events route here (focused on
          an editable click) so the printable/Backspace/arrow/Esc and Korean compositionend-commit
          paths fire WITHOUT clobbering ⌘K/⌘F/palette typing (those listen on window). aria-hidden so
          screen readers skip it. v1 IME: final text commits on compositionend (no in-place jamo
          preview — documented limit). */}
      <input
        ref={imeInput}
        aria-hidden="true"
        tabindex={-1}
        class="absolute -left-[9999px] top-0 h-px w-px opacity-0"
        onKeyDown={onCaretKeyDown}
        onCompositionStart={onCompositionStart}
        onCompositionUpdate={onCompositionUpdate}
        onCompositionEnd={(e) => void onCompositionEnd(e)}
      />

      <Palette open={paletteOpen()} onOpenChange={setPaletteOpen} commands={commands()} />
      <Composer mode={composer()} onClose={() => setComposer(null)} ctx={composerCtx} />
      <Toaster />
    </div>
  );
}
