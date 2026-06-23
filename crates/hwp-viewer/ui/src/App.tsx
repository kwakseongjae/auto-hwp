import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { tinykeys } from "tinykeys";
import { api, type CaretRect, type FindMatch } from "./api";
import { sanitizeSvg } from "./sanitize";
import { advanceOffset, pageToScreen, screenToPage } from "./caret";
import { type Command } from "./commands";
import { Palette } from "./Palette";
import { Composer, type ComposerMode } from "./Composer";
import { Chat, type Scope } from "./Chat";
import { toast, Toaster } from "./toast";

type CaretAnchor = { page: number; node: number; offset: number; len: number };

/// 한칸 (Hankan) — Raycast-grade shell, now React. A ⌘K palette over the virtualized SVG viewer, an
/// overlay titlebar, a structured composer, the WYSIWYG caret, and the vibe-docs Chat panel.
export default function App() {
  const [pageCount, setPageCount] = useState(0);
  const [svgCache, setSvgCache] = useState<Record<number, string>>({});
  const [docName, setDocName] = useState<string | null>(null);
  const [editable, setEditable] = useState(true);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [composer, setComposer] = useState<ComposerMode>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const [rendering, setRendering] = useState(false);
  // Preview mode: 'svg' = rhwp faithful render of the ORIGINAL (layout-preserve); 'html' = the
  // JSX(content)/CSS(design) → HTML render (the pivot view — shows edits cleanly, matches export);
  // 'own' = OUR OWN engine (place_doc → paint IR → SvgSink) — the self-owned fidelity render that
  // regenerates from the live IR (shows edits too). Editable docs default to 'html'.
  const [viewMode, setViewMode] = useState<"svg" | "html" | "own">("svg");
  const [docHtml, setDocHtml] = useState<string | null>(null);
  const viewModeRef = useRef(viewMode);
  viewModeRef.current = viewMode;

  // ---- Own-engine ('자체 렌더') page list: its OWN paginator can yield a different page count than
  // rhwp, and its OWN SVG cache (keyed by page) is regenerated from the live IR, so it stays separate
  // from the rhwp svgCache and is invalidated on every edit. ----
  const [ownPageCount, setOwnPageCount] = useState(0);
  const [ownSvgCache, setOwnSvgCache] = useState<Record<number, string>>({});
  const ownSvgCacheRef = useRef(ownSvgCache);
  ownSvgCacheRef.current = ownSvgCache;
  const ownInflight = useRef(new Set<number>());
  // Fetch the own-engine page count (after open + every edit while in 'own' mode).
  const loadOwnPageCount = useCallback(async () => {
    try {
      setOwnPageCount(await api.ownPageCount());
    } catch {
      setOwnPageCount(0);
    }
  }, []);
  // Once the doc has been edited, the faithful rhwp SVG "원본 보기" no longer reflects the document
  // (the backend refuses to re-render edited content — P1). So edits force/lock the HTML preview,
  // which renders the LIVE IR. The toggle to 원본 is disabled after the first edit.
  const [edited, setEdited] = useState(false);
  const editedRef = useRef(edited);
  editedRef.current = edited;

  // Fetch the whole-doc HTML for the iframe preview (and after every edit when in html mode).
  const loadDocHtml = useCallback(async () => {
    try {
      setDocHtml(await api.renderDocHtml());
    } catch {
      setDocHtml(null);
    }
  }, []);
  // Vibe-docs: the active provider (for an honest "mock = demo" badge) + the click-resolved target the
  // user pointed at (the scope chip). A page click while the chat is open captures it.
  const [provider, setProvider] = useState("none");
  const [scope, setScope] = useState<Scope | null>(null);
  const scopeRef = useRef<Scope | null>(null);
  scopeRef.current = scope;
  const chatOpenRef = useRef(chatOpen);
  chatOpenRef.current = chatOpen;

  // Authoring is only safe on an editable (HWPX) doc.
  const canEdit = pageCount > 0 && editable;

  // ---- Find / Replace bar state ----
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [replaceQuery, setReplaceQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [matches, setMatches] = useState<FindMatch[] | null>(null);
  const [finding, setFinding] = useState(false);
  const findInputRef = useRef<HTMLInputElement>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inflight = useRef(new Set<number>());

  // ---- Interactive caret state (built on the shipped caret engine; see the Solid original for the
  // full coordinate-space / reflow contract — semantics are unchanged, only the framework differs) ----
  const [caret, setCaret] = useState<CaretAnchor | null>(null);
  const [caretRect, setCaretRect] = useState<CaretRect | null>(null);
  const [caretBox, setCaretBox] = useState<{ left: number; top: number; height: number } | null>(null);
  const [composing, setComposing] = useState(false);
  const imeInput = useRef<HTMLInputElement>(null);

  // Refs mirror the values that async (queued) edit/move closures must read at EXECUTION time, not at
  // the time the closure was created — React closures capture stale state otherwise.
  const caretRef = useRef<CaretAnchor | null>(null);
  caretRef.current = caret;
  const canEditRef = useRef(canEdit);
  canEditRef.current = canEdit;
  const composingRef = useRef(composing);
  composingRef.current = composing;

  // Edit SERIALIZER: chain every mutation/move through one promise queue so concurrent input applies
  // strictly in order (no dropped keystroke / IME syllable). Errors toast and don't break the chain.
  const editQueue = useRef<Promise<unknown>>(Promise.resolve());
  const enqueueEdit = useCallback((fn: () => Promise<void>): Promise<void> => {
    const next = editQueue.current.then(fn).catch((err) => {
      toast("warn", `${err}`);
    });
    editQueue.current = next;
    return next;
  }, []);

  function svgForPage(page: number): SVGSVGElement | null {
    return scrollRef.current?.querySelector(`[data-index="${page}"] svg`) ?? null;
  }
  const recomputeCaretBox = useCallback((page: number, r: CaretRect | null) => {
    if (!r) return setCaretBox(null);
    const svg = svgForPage(page);
    if (!svg) return setCaretBox(null);
    const rect = svg.getBoundingClientRect();
    const vb = svg.viewBox.baseVal;
    setCaretBox(pageToScreen(r, { width: rect.width, height: rect.height }, { width: vb.width, height: vb.height }));
  }, []);
  const clearCaret = useCallback(() => {
    setCaret(null);
    setCaretRect(null);
    setCaretBox(null);
    setComposing(false);
  }, []);

  // In 'own' mode the page list is paginated by OUR engine (its count can differ from rhwp's).
  const listCount = viewMode === "own" ? ownPageCount : pageCount;
  const virtualizer = useVirtualizer({
    count: listCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 920,
    overscan: 2,
    gap: 24,
  });

  const ensurePage = useCallback(async (i: number) => {
    if (svgCacheRef.current[i] !== undefined || inflight.current.has(i)) return;
    inflight.current.add(i);
    setRendering(true);
    try {
      const svg = await api.renderPage(i);
      setSvgCache((c) => ({ ...c, [i]: sanitizeSvg(svg) }));
    } catch (e) {
      toast("warn", `렌더 실패(${i + 1}쪽): ${e}`);
    } finally {
      inflight.current.delete(i);
      setRendering(inflight.current.size > 0);
    }
  }, []);
  // svgCache read inside the (stable) ensurePage closure needs the latest map.
  const svgCacheRef = useRef(svgCache);
  svgCacheRef.current = svgCache;

  // The 'own' (자체 렌더) twin of ensurePage: fetch a page via the own-engine command. We generate the
  // SVG ourselves, but keep sanitizeSvg for consistency with the rhwp path (defense-in-depth).
  const ensureOwnPage = useCallback(async (i: number) => {
    if (ownSvgCacheRef.current[i] !== undefined || ownInflight.current.has(i)) return;
    ownInflight.current.add(i);
    setRendering(true);
    try {
      const svg = await api.renderOwnPage(i);
      setOwnSvgCache((c) => ({ ...c, [i]: sanitizeSvg(svg) }));
    } catch (e) {
      toast("warn", `자체 렌더 실패(${i + 1}쪽): ${e}`);
    } finally {
      ownInflight.current.delete(i);
      setRendering(inflight.current.size + ownInflight.current.size > 0);
    }
  }, []);

  // `scrollTo === null` keeps the current scroll (chat edits shouldn't yank the view to the doc end —
  // the "결과가 튀는" issue); a number scrolls to that page.
  const invalidate = useCallback((n: number, scrollTo: number | null = 0) => {
    setSvgCache({});
    setPageCount(n);
    clearCaret();
    // The own-engine SVGs are regenerated from the live IR — drop them too so an edit repaints. Its
    // page count is fetched lazily (or eagerly when 'own' is the active mode).
    setOwnSvgCache({});
    if (viewModeRef.current === "html") void loadDocHtml();
    else if (viewModeRef.current === "own") void loadOwnPageCount();
    if (scrollTo !== null) {
      // Scroll within the active mode's list (own can have a different page count than rhwp).
      const max = (viewModeRef.current === "own" ? ownPageCountRef.current : n) - 1;
      queueMicrotask(() => virtualizer.scrollToIndex(Math.max(0, Math.min(scrollTo, max))));
    }
  }, [clearCaret, virtualizer, loadDocHtml, loadOwnPageCount]);
  // own page count read inside the (stable) invalidate closure needs the latest value.
  const ownPageCountRef = useRef(ownPageCount);
  ownPageCountRef.current = ownPageCount;

  const invalidateKeepingCaret = useCallback(async (n: number, want: CaretAnchor) => {
    setSvgCache({});
    setPageCount(n);
    setCaret(want);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    try {
      const r = await api.caretRect(want.page, want.node, want.offset);
      setCaretRect(r);
      recomputeCaretBox(want.page, r);
    } catch {
      setCaretRect(null);
      setCaretBox(null);
    }
    imeInput.current?.focus();
  }, [recomputeCaretBox]);

  // ---- caret: click-to-place ----
  async function onPageClick(e: React.MouseEvent) {
    if (!canEditRef.current) return;
    // The caret hit-test geometry comes from the rhwp render path; in the 'own' fidelity view the
    // displayed SVG is our engine's, so don't place a caret against mismatched coordinates.
    if (viewModeRef.current === "own") return;
    const host = (e.target as Element).closest("[data-index]");
    if (!host) return;
    const page = Number(host.getAttribute("data-index"));
    if (!Number.isFinite(page)) return;
    const svg = host.querySelector("svg");
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const vb = svg.viewBox.baseVal;
    const pt = screenToPage(
      e.clientX,
      e.clientY,
      { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      { width: vb.width, height: vb.height },
    );
    if (!pt) return;
    try {
      const hit = await api.hitTest(page, pt.x, pt.y);
      // Vibe-docs: while the chat is open, ANY click on the page captures a target "scope" (section
      // always; block when it's a simple paragraph) so the user can point-then-ask ("이거 바꿔줘").
      if (chatOpenRef.current && hit) {
        setScope({ section: hit.section, block: hit.block, page });
      }
      if (!hit || hit.node === null) {
        clearCaret();
        // A table/heading click can't take a typing caret, but with the chat open it DID set a scope,
        // so don't nag — only hint when there's no chat to receive the pointer.
        if (hit && hit.node === null && !chatOpenRef.current) toast("info", "표/머리말 등은 아직 편집할 수 없습니다");
        return;
      }
      const want: CaretAnchor = { page, node: hit.node, offset: hit.offset, len: hit.paraLen };
      const r = await api.caretRect(page, want.node, want.offset);
      setCaret(want);
      setCaretRect(r);
      recomputeCaretBox(page, r);
      imeInput.current?.focus();
    } catch (err) {
      toast("warn", `캐럿 배치 실패: ${err}`);
    }
  }

  // ---- caret: edit loop (each helper enqueued; reads caretRef AFTER the prior queued edit resolved) ----
  const doInsert = useCallback((text: string) => {
    void enqueueEdit(async () => {
      const c = caretRef.current;
      if (!c || !canEditRef.current) return;
      const inserted = advanceOffset(c.offset, text) - c.offset;
      const pages = await api.insertText(c.node, c.offset, text);
      setEdited(true);
      await invalidateKeepingCaret(pages, { ...c, offset: c.offset + inserted, len: c.len + inserted });
    });
  }, [enqueueEdit, invalidateKeepingCaret]);
  const doDelete = useCallback(() => {
    void enqueueEdit(async () => {
      const c = caretRef.current;
      if (!c || !canEditRef.current || c.offset === 0) return;
      const pages = await api.deleteBack(c.node, c.offset);
      setEdited(true);
      await invalidateKeepingCaret(pages, { ...c, offset: c.offset - 1, len: Math.max(0, c.len - 1) });
    });
  }, [enqueueEdit, invalidateKeepingCaret]);
  const doMove = useCallback((d: -1 | 1) => {
    void enqueueEdit(async () => {
      const c = caretRef.current;
      if (!c) return;
      const newOffset = c.offset + d;
      if (newOffset < 0 || newOffset > c.len) return;
      const r = await api.caretRect(c.page, c.node, newOffset);
      if (r === null) return;
      setCaret({ ...c, offset: newOffset });
      setCaretRect(r);
      recomputeCaretBox(c.page, r);
    });
  }, [enqueueEdit, recomputeCaretBox]);

  // ---- caret: keyboard + IME handlers (attached to the hidden imeInput) ----
  function onCaretKeyDown(e: React.KeyboardEvent) {
    if (composingRef.current || e.nativeEvent.isComposing) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (!caretRef.current) return;
    if (e.key.length === 1) {
      e.preventDefault();
      doInsert(e.key);
    } else if (e.key === "Backspace") {
      e.preventDefault();
      doDelete();
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      doMove(-1);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      doMove(1);
    } else if (e.key === "Escape") {
      e.preventDefault();
      clearCaret();
    }
  }
  function onCompositionEnd(e: React.CompositionEvent) {
    setComposing(false);
    const text = e.data || imeInput.current?.value || "";
    if (imeInput.current) imeInput.current.value = "";
    if (!text) return;
    doInsert(text);
  }

  // ---- verbs ----
  const doOpen = useCallback(async () => {
    const path = await openDialog({ filters: [{ name: "HWP/HWPX", extensions: ["hwpx", "hwp"] }] });
    if (typeof path !== "string") return;
    setBusyLabel("문서 여는 중…");
    try {
      const r = await api.openDoc(path);
      const name = path.split("/").pop() ?? path;
      setDocName(name);
      setEditable(r.editable);
      setEdited(false); // a freshly opened doc is unedited → 원본 보기 (rhwp SVG) is faithful again
      // Editable docs default to the HTML (JSX/CSS) preview — shows edits + the gov-doc styling;
      // a view-only original stays on the faithful rhwp SVG. The toolbar toggles either way.
      const mode = r.editable ? "html" : "svg";
      setViewMode(mode);
      viewModeRef.current = mode;
      invalidate(r.pages);
      if (mode === "html") void loadDocHtml();
      if (r.editable) setChatOpen(true); // surface the vibe-docs chat on an editable doc
      if (r.convertedPath) {
        const saved = r.convertedPath.split("/").pop() ?? r.convertedPath;
        toast("ok", `${name} · ${r.pages}쪽 · 편집용 .hwpx 저장됨: ${saved}`);
      } else if (r.editable) {
        toast("ok", `${name} · ${r.pages}쪽`);
      } else {
        toast("warn", "보기전용 — 편집하려면 먼저 HWPX로 내보내세요", [
          { label: "HWPX로 내보내기", run: () => void handlers.current.doExport() },
        ]);
      }
    } catch (e) {
      toast("warn", `열기 실패: ${e}`);
    } finally {
      setBusyLabel(null);
    }
  }, [invalidate]);

  const doExport = useCallback(async () => {
    if (pageCountRef.current === 0) return;
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
  }, []);
  const pageCountRef = useRef(pageCount);
  pageCountRef.current = pageCount;

  const doUndo = useCallback(async () => {
    if (pageCountRef.current === 0) return;
    invalidate(await api.undo());
    toast("info", "실행 취소");
  }, [invalidate]);
  const doRedo = useCallback(async () => {
    if (pageCountRef.current === 0) return;
    invalidate(await api.redo());
    toast("info", "다시 실행");
  }, [invalidate]);

  // Switch the preview surface. 'svg' = rhwp 원본(layout-preserve), 'html' = JSX/CSS pivot, 'own' =
  // OUR engine (자체 렌더). The rhwp 원본 can't show an EDITED doc (P1), so block 'svg' after an edit;
  // 'html'/'own' both regenerate from the live IR. Each mode lazily loads what it needs.
  const setMode = useCallback((next: "svg" | "html" | "own") => {
    if (next === viewModeRef.current) return;
    if (next === "svg" && editedRef.current) {
      toast("info", "편집된 문서는 HTML/자체 렌더로만 표시됩니다 (원본 보기는 편집 전용)");
      return;
    }
    setViewMode(next);
    viewModeRef.current = next;
    if (next === "html") void loadDocHtml();
    else if (next === "own") void loadOwnPageCount();
  }, [loadDocHtml, loadOwnPageCount]);

  // ---- Find / Replace verbs ----
  const openFind = useCallback(() => {
    if (pageCountRef.current === 0) return;
    setFindOpen(true);
    queueMicrotask(() => {
      findInputRef.current?.focus();
      findInputRef.current?.select();
    });
  }, []);
  function closeFind() {
    setFindOpen(false);
    setMatches(null);
  }
  async function doFind() {
    if (!findQuery) {
      setMatches(null);
      return;
    }
    setFinding(true);
    try {
      setMatches(await api.findText(findQuery, caseSensitive));
    } catch (e) {
      toast("warn", `찾기 실패: ${e}`);
    } finally {
      setFinding(false);
    }
  }
  async function doReplace(all: boolean) {
    if (!findQuery || !canEdit) return;
    setBusyLabel(all ? "모두 바꾸는 중…" : "바꾸는 중…");
    try {
      const r = await api.replaceText(findQuery, replaceQuery, caseSensitive, false, all);
      if (r.replaced > 0) setEdited(true);
      invalidate(r.pages);
      if (r.replaced > 0) {
        toast("ok", `${r.replaced}개 바꿈`, [{ label: "실행취소", run: () => void doUndo() }]);
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

  const composerCtx = useMemo(
    () => ({
      applyContent: async (json: string) => {
        const n = await api.applyContent(json);
        setEdited(true);
        invalidate(n, n - 1);
        toast("ok", "문서 끝에 추가됨", [{ label: "실행취소", run: () => void doUndo() }]);
      },
      generate: (p: string) => api.aiGenerate(p),
      propose: (json: string) => api.propose(json),
      commit: async () => {
        const n = await api.commitProposal();
        setEdited(true);
        invalidate(n, n - 1);
        toast("ok", "제안 적용됨", [{ label: "실행취소", run: () => void doUndo() }]);
      },
      discard: () => api.discardProposal(),
    }),
    [invalidate, doUndo],
  );

  // The vibe-docs chat: propose anchored edits (dry-run, optionally scoped to a clicked target) →
  // 적용 commits through the same op-bus. On apply, scroll to the pointed page (or stay put) instead
  // of yanking to the doc end — and clear the spent scope.
  const chatCtx = useMemo(
    () => ({
      propose: (instruction: string, scopeArg: Scope | null) =>
        api.aiEdit(instruction, scopeArg ? { section: scopeArg.section, block: scopeArg.block } : undefined),
      insertImage: (name: string, dataB64: string, scopeArg: Scope | null, widthMm: number, heightMm: number) =>
        api.insertImage(name, dataB64, scopeArg ? { section: scopeArg.section, block: scopeArg.block } : null, widthMm, heightMm),
      commit: async () => {
        const n = await api.commitProposal();
        setEdited(true);
        invalidate(n, scopeRef.current ? scopeRef.current.page : null);
        setScope(null);
      },
      discard: () => api.discardProposal(),
    }),
    [invalidate],
  );

  // ---- palette command registry ----
  const commands = useMemo<Command[]>(() => {
    const haveDoc = pageCount > 0;
    return [
      { id: "open", title: "문서 열기", group: "문서", keys: "⌘O", keywords: "open 열기 파일", run: doOpen },
      { id: "export", title: "HWPX로 내보내기 / 저장", group: "문서", keys: "⌘S", keywords: "export 내보내기 저장 save hwpx", disabled: !haveDoc, run: doExport },
      { id: "chat", title: "AI 바이브 편집 (채팅)", group: "작성", keys: "⌘L", keywords: "ai chat 채팅 편집 vibe 바이브 표 이미지", tone: "ai", disabled: !canEdit, run: () => setChatOpen((o) => !o) },
      { id: "table", title: "표 추가 (문서 끝에)", group: "작성", keys: "⌘T", keywords: "table 표 추가 그리드", disabled: !canEdit, run: () => setComposer("table") },
      { id: "ai", title: "AI 콘텐츠 제안", group: "작성", keys: "⌘.", keywords: "ai 제안 작성 propose", tone: "ai", disabled: !canEdit, run: () => setComposer("ai") },
      { id: "find", title: "찾기 / 바꾸기", group: "편집", keys: "⌘F", keywords: "find replace 찾기 바꾸기 검색 치환", disabled: !haveDoc, run: openFind },
      { id: "undo", title: "실행 취소", group: "편집", keys: "⌘Z", keywords: "undo 실행취소", disabled: !canEdit, run: doUndo },
      { id: "redo", title: "다시 실행", group: "편집", keys: "⌘⇧Z", keywords: "redo 다시실행", disabled: !canEdit, run: doRedo },
    ];
  }, [pageCount, canEdit, doOpen, doExport, openFind, doUndo, doRedo]);

  // ---- global shortcuts: registered ONCE; closures call the always-current handler set via a ref. ----
  const handlers = useRef({ doOpen, doExport, doUndo, doRedo, openFind });
  handlers.current = { doOpen, doExport, doUndo, doRedo, openFind };
  const canEditForKeys = useRef(canEdit);
  canEditForKeys.current = canEdit;
  useEffect(() => {
    const un = tinykeys(window, {
      "$mod+k": (e) => { e.preventDefault(); setPaletteOpen((o) => !o); },
      "$mod+o": (e) => { e.preventDefault(); void handlers.current.doOpen(); },
      "$mod+e": (e) => { e.preventDefault(); void handlers.current.doExport(); },
      "$mod+s": (e) => { e.preventDefault(); void handlers.current.doExport(); },
      "$mod+f": (e) => { e.preventDefault(); handlers.current.openFind(); },
      "$mod+l": (e) => { e.preventDefault(); if (canEditForKeys.current) setChatOpen((o) => !o); },
      "$mod+t": (e) => { e.preventDefault(); if (canEditForKeys.current) setComposer("table"); },
      "$mod+.": (e) => { e.preventDefault(); if (canEditForKeys.current) setComposer("ai"); },
      "$mod+z": (e) => { e.preventDefault(); void handlers.current.doUndo(); },
      "$mod+Shift+z": (e) => { e.preventDefault(); void handlers.current.doRedo(); },
    });
    return un;
  }, []);

  // Resolve the active AI provider once, for the chat's honest "mock = demo" badge.
  useEffect(() => {
    api.aiProviderName().then(setProvider).catch(() => setProvider("none"));
  }, []);

  // Repaint when the embedded control server (or any out-of-band path) mutates the live session:
  // it emits "doc-changed" after every call. Re-sync the page count + drop the SVG cache so the
  // viewer reflects an externally opened/edited document. (The in-UI verbs repaint directly.)
  useEffect(() => {
    let un: undefined | (() => void);
    (async () => {
      un = await listen("doc-changed", async () => {
        try {
          const n = await api.pageCount();
          if (n > 0) {
            setEditable(true);
            setDocName((d) => d ?? "문서");
            setChatOpen(true);
            // An out-of-band mutation may have edited the doc → lock to the HTML (IR) preview, since
            // the rhwp SVG can no longer faithfully show it (P1).
            setEdited(true);
            setViewMode("html");
            viewModeRef.current = "html";
          }
          invalidate(n, null); // repaint in place (reloads HTML when in html mode)
        } catch {
          /* no document / render unavailable — ignore */
        }
      });
    })();
    return () => un?.();
  }, [invalidate]);

  // deterministic dark mode from the native theme event
  useEffect(() => {
    const apply = (t: string | null) => document.documentElement.classList.toggle("dark", t === "dark");
    let unlisten: (() => void) | undefined;
    let mqCleanup: (() => void) | undefined;
    (async () => {
      try {
        const w = getCurrentWindow();
        apply(await w.theme());
        unlisten = await w.onThemeChanged(({ payload }) => apply(payload));
      } catch {
        const mq = window.matchMedia("(prefers-color-scheme: dark)");
        const onChange = () => apply(mq.matches ? "dark" : "light");
        onChange();
        mq.addEventListener("change", onChange);
        mqCleanup = () => mq.removeEventListener("change", onChange);
      }
    })();
    return () => {
      unlisten?.();
      mqCleanup?.();
    };
  }, []);

  const Tool = (p: { onClick: () => void; icon: string; label: string; keys?: string; tone?: "ai"; disabled?: boolean }) => (
    <button
      onClick={p.onClick}
      disabled={p.disabled}
      title={p.keys ? `${p.label} (${p.keys})` : p.label}
      className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-sm hover:bg-neutral-200/70 disabled:opacity-35 dark:hover:bg-neutral-700/60 ${p.tone === "ai" ? "text-ai" : "text-neutral-700 dark:text-neutral-200"}`}
    >
      <span className="text-xs opacity-80">{p.icon}</span>
      <span>{p.label}</span>
      {p.keys && <kbd className="ml-0.5 rounded bg-black/5 px-1 text-[10px] text-neutral-400 dark:bg-white/10">{p.keys}</kbd>}
    </button>
  );
  const Sep = () => <span className="mx-1 h-5 w-px bg-black/10 dark:bg-white/10" />;

  return (
    <div className="relative flex h-full flex-col bg-neutral-100 text-neutral-900 dark:bg-neutral-900 dark:text-neutral-100">
      <header
        data-tauri-drag-region
        className="flex h-11 shrink-0 items-center gap-2 border-b border-black/10 bg-neutral-50/70 pl-20 pr-3 backdrop-blur-xl dark:border-white/10 dark:bg-neutral-800/60"
      >
        {docName ? (
          <>
            <span data-tauri-drag-region className="text-sm font-medium">{docName}</span>
            <span data-tauri-drag-region className="text-xs text-neutral-400">· {pageCount}쪽</span>
            <span className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${editable ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400" : "bg-neutral-500/15 text-neutral-500"}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${editable ? "bg-emerald-500" : "bg-neutral-400"}`} />
              {editable ? "편집가능" : "보기전용"}
            </span>
          </>
        ) : (
          <span data-tauri-drag-region className="text-sm font-semibold tracking-tight text-neutral-400">한칸</span>
        )}
        <div data-tauri-drag-region className="h-6 flex-1" />
        {canEdit && (
          <button
            onClick={() => setChatOpen((o) => !o)}
            title="AI 바이브 편집 (⌘L)"
            className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs ${chatOpen ? "border-ai/40 bg-ai/10 text-ai" : "border-black/10 text-neutral-500 hover:bg-neutral-200/60 dark:border-white/10 dark:text-neutral-400 dark:hover:bg-neutral-700/60"}`}
          >
            ✦ 바이브 <kbd className="rounded bg-black/5 px-1 dark:bg-white/10">⌘L</kbd>
          </button>
        )}
        <button
          onClick={() => setPaletteOpen(true)}
          className="flex items-center gap-1.5 rounded-md border border-black/10 px-2.5 py-1 text-xs text-neutral-500 hover:bg-neutral-200/60 dark:border-white/10 dark:text-neutral-400 dark:hover:bg-neutral-700/60"
        >
          명령 <kbd className="rounded bg-black/5 px-1 dark:bg-white/10">⌘K</kbd>
        </button>
      </header>

      {pageCount > 0 && (
        <div className="flex h-10 shrink-0 items-center gap-0.5 border-b border-black/10 bg-neutral-50/40 px-2 dark:border-white/10 dark:bg-neutral-800/30">
          <Tool onClick={doOpen} icon="📂" label="열기" keys="⌘O" />
          <Tool onClick={doExport} icon="⬇︎" label="내보내기" keys="⌘S" />
          <Sep />
          <Tool onClick={() => setChatOpen((o) => !o)} icon="✦" label="바이브 편집" tone="ai" keys="⌘L" disabled={!canEdit} />
          <Tool onClick={() => setComposer("table")} icon="▦" label="표" keys="⌘T" disabled={!canEdit} />
          <Sep />
          {/* View surface: 원본(rhwp layout-preserve) · HTML(JSX/CSS pivot) · 자체 렌더(OUR engine).
              원본 is disabled once edited (rhwp can't re-render edits); the other two render the live IR. */}
          <div className="flex items-center gap-0.5 rounded-md bg-black/5 p-0.5 dark:bg-white/10">
            {([
              { m: "svg", label: "원본", icon: "🖹", title: "원본 보기 (rhwp · 레이아웃 보존)", off: edited },
              { m: "html", label: "HTML", icon: "🅷", title: "HTML 미리보기 (JSX/CSS · 내보내기와 동일)", off: false },
              { m: "own", label: "자체 렌더", icon: "◈", title: "자체 렌더 (우리 엔진 · place_doc → SVG)", off: false },
            ] as const).map((v) => (
              <button
                key={v.m}
                onClick={() => setMode(v.m)}
                disabled={v.off}
                title={v.title}
                className={`flex items-center gap-1 rounded px-2 py-1 text-sm disabled:opacity-35 ${
                  viewMode === v.m
                    ? "bg-white text-neutral-900 shadow-sm dark:bg-neutral-700 dark:text-neutral-100"
                    : "text-neutral-600 hover:bg-black/5 dark:text-neutral-300 dark:hover:bg-white/10"
                }`}
              >
                <span className="text-xs opacity-80">{v.icon}</span>
                <span>{v.label}</span>
              </button>
            ))}
          </div>
          <Sep />
          <Tool onClick={doUndo} icon="↩︎" label="실행취소" keys="⌘Z" disabled={!canEdit} />
          <Tool onClick={doRedo} icon="↪︎" label="다시실행" disabled={!canEdit} />
        </div>
      )}

      {findOpen && pageCount > 0 && (
        <div className="flex shrink-0 flex-col gap-1.5 border-b border-black/10 bg-neutral-50/60 px-3 py-2 backdrop-blur-xl dark:border-white/10 dark:bg-neutral-800/50">
          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={findInputRef}
              value={findQuery}
              onChange={(e) => { setFindQuery(e.currentTarget.value); setMatches(null); }}
              onKeyDown={(e) => {
                if (e.key === "Escape") { e.preventDefault(); closeFind(); }
                else if (e.key === "Enter") { e.preventDefault(); void doFind(); }
              }}
              placeholder="찾을 내용"
              className="w-48 rounded-md border border-black/10 bg-white px-2 py-1 text-sm outline-none focus:border-accent dark:border-white/10 dark:bg-neutral-900"
            />
            <input
              value={replaceQuery}
              onChange={(e) => setReplaceQuery(e.currentTarget.value)}
              onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); closeFind(); } }}
              placeholder="바꿀 내용"
              disabled={!canEdit}
              className="w-48 rounded-md border border-black/10 bg-white px-2 py-1 text-sm outline-none focus:border-accent disabled:opacity-40 dark:border-white/10 dark:bg-neutral-900"
            />
            <label className="flex cursor-pointer select-none items-center gap-1.5 text-xs text-neutral-600 dark:text-neutral-300">
              <input type="checkbox" checked={caseSensitive} onChange={(e) => { setCaseSensitive(e.currentTarget.checked); setMatches(null); }} className="accent-accent" />
              대소문자 구분
            </label>
            <span className="mx-0.5 h-5 w-px bg-black/10 dark:bg-white/10" />
            <button onClick={() => void doFind()} disabled={!findQuery || finding} className="rounded-md px-2 py-1 text-sm text-neutral-700 hover:bg-neutral-200/70 disabled:opacity-35 dark:text-neutral-200 dark:hover:bg-neutral-700/60">찾기</button>
            <button onClick={() => void doReplace(false)} disabled={!findQuery || !canEdit || !!busyLabel} title="문서의 첫 일치 항목을 바꿉니다" className="rounded-md px-2 py-1 text-sm text-neutral-700 hover:bg-neutral-200/70 disabled:opacity-35 dark:text-neutral-200 dark:hover:bg-neutral-700/60">바꾸기</button>
            <button onClick={() => void doReplace(true)} disabled={!findQuery || !canEdit || !!busyLabel} className="rounded-md px-2 py-1 text-sm text-neutral-700 hover:bg-neutral-200/70 disabled:opacity-35 dark:text-neutral-200 dark:hover:bg-neutral-700/60">모두 바꾸기</button>
            <span className="flex-1" />
            {finding && (
              <span className="flex items-center gap-1.5 text-xs text-neutral-400">
                <span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
                찾는 중…
              </span>
            )}
            {!finding && matches !== null && (
              <span className="text-xs text-neutral-500 dark:text-neutral-400">
                {matches.length > 0 ? `${matches.length}개 찾음` : "찾는 결과 없음"}
              </span>
            )}
            <button onClick={closeFind} title="닫기 (Esc)" className="rounded-md px-1.5 py-1 text-xs text-neutral-400 hover:bg-neutral-200/70 dark:hover:bg-neutral-700/60">✕</button>
          </div>
          {!finding && matches !== null && matches.length > 0 && (
            <div className="flex items-center gap-2 text-[11px] text-neutral-400">
              <span className="shrink-0">위치</span>
              <span className="truncate">
                {matches.slice(0, 8).map((m) => `${m.section + 1}-${m.block + 1}`).join(", ")}
                {matches.length > 8 ? " …" : ""}
              </span>
            </div>
          )}
          <p className="text-[11px] text-neutral-400">
            본문의 단순 문단만 검색합니다 (표·머리말/꼬리말·각주, 추가한 콘텐츠, 문단 경계를 넘는 검색 제외).
          </p>
        </div>
      )}

      {/* The viewer + the docked vibe-docs chat, side by side. */}
      <div className="flex min-h-0 flex-1">
        <main ref={scrollRef} className="min-h-0 flex-1 overflow-auto p-6">
          {pageCount > 0 && viewMode === "html" ? (
            // The JSX(content)/CSS(design) → HTML preview (the pivot view) in an isolated iframe.
            <iframe
              title="문서 미리보기"
              srcDoc={docHtml ?? "<!doctype html><body style='font-family:sans-serif;color:#999;padding:2rem'>렌더 중…</body>"}
              sandbox="allow-same-origin"
              // Size the iframe to its CONTENT height (same-origin srcDoc) so the WebView can't squeeze
              // it — a collapsed/short iframe was making WKWebView mis-lay-out and overlap blocks.
              onLoad={(e) => {
                const f = e.currentTarget;
                const h = f.contentDocument?.body?.scrollHeight;
                if (h && h > 0) f.style.height = `${h + 32}px`;
              }}
              className="mx-auto block w-full max-w-3xl rounded-lg border-0 bg-white shadow-md ring-1 ring-black/5"
            />
          ) : listCount > 0 ? (
            // SVG page list — shared by 'svg' (rhwp 원본) and 'own' (자체 렌더, OUR engine). The two have
            // separate caches/ensure-fns + page counts; the caret (whose geometry is from the rhwp
            // render path) only attaches in 'svg' mode.
            <div className="relative mx-auto max-w-3xl" style={{ height: `${virtualizer.getTotalSize()}px` }} onClick={(e) => void onPageClick(e)}>
              {virtualizer.getVirtualItems().map((item) => {
                void (viewMode === "own" ? ensureOwnPage(item.index) : ensurePage(item.index));
                const pageSvg = viewMode === "own" ? ownSvgCache[item.index] : svgCache[item.index];
                return (
                  <div
                    key={item.key}
                    ref={(el) => { if (el) virtualizer.measureElement(el); }}
                    data-index={item.index}
                    className="absolute left-0 w-full"
                    style={{ transform: `translateY(${item.start}px)` }}
                  >
                    <div
                      className="relative w-full rounded-lg bg-white shadow-md ring-1 ring-black/5"
                      style={{ contentVisibility: "auto", containIntrinsicSize: "auto 920px" }}
                    >
                      {pageSvg !== undefined ? (
                        <div className="page-svg" dangerouslySetInnerHTML={{ __html: pageSvg }} />
                      ) : (
                        <div className="grid aspect-[1/1.414] place-items-center text-neutral-300">{item.index + 1}쪽…</div>
                      )}
                      {viewMode === "svg" && caret && caretRect && caretBox && caret.page === item.index && (
                        <div
                          className="caret-blink pointer-events-none absolute z-10 w-px bg-accent"
                          style={{ left: `${caretBox.left}px`, top: `${caretBox.top}px`, height: `${caretBox.height}px` }}
                        />
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : pageCount > 0 ? (
            // A doc IS open but the active list has no pages yet — e.g. switching to 'own' before its
            // page count resolves. Show a render hint, not the open-file prompt.
            <div className="grid h-full place-items-center text-neutral-400">
              <span className="flex items-center gap-2 text-sm">
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                자체 렌더 준비 중…
              </span>
            </div>
          ) : (
            <div className="grid h-full place-items-center">
              <div className="flex flex-col items-center gap-4 text-center">
                <div className="text-5xl opacity-20">한칸</div>
                <div className="text-neutral-500 dark:text-neutral-400">한글 문서를 열어 시작하세요</div>
                <button onClick={doOpen} className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:opacity-90">
                  📂 문서 열기 <kbd className="opacity-70">⌘O</kbd>
                </button>
                <div className="text-xs text-neutral-400">또는 <kbd className="rounded bg-black/5 px-1 dark:bg-white/10">⌘K</kbd> 로 모든 명령</div>
              </div>
            </div>
          )}
        </main>

        <Chat
          open={chatOpen && pageCount > 0}
          canEdit={canEdit}
          provider={provider}
          scope={scope}
          onClearScope={() => setScope(null)}
          ctx={chatCtx}
          onApplied={() => { /* re-render + scroll handled by commit→invalidate */ }}
        />
      </div>

      <footer className="flex items-center gap-3 border-t border-black/10 px-4 py-1.5 text-xs text-neutral-500 dark:border-white/10 dark:text-neutral-400">
        <span>{pageCount > 0 ? `${pageCount}쪽` : "준비됨"}</span>
        {rendering && (
          <span className="flex items-center gap-1.5 text-neutral-400">
            <span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
            렌더 중…
          </span>
        )}
        <span className="flex-1" />
        <span><kbd>⌘K</kbd> 명령</span>
        <span><kbd>⌘L</kbd> 바이브</span>
        <span><kbd>⌘F</kbd> 찾기</span>
        <span><kbd>⌘E</kbd> 내보내기</span>
      </footer>

      {busyLabel && (
        <div className="absolute inset-0 z-50 grid place-items-center bg-black/20 backdrop-blur-sm dark:bg-black/40">
          <div className="flex items-center gap-3 rounded-lg bg-neutral-50/90 px-5 py-3 text-sm shadow-lg ring-1 ring-black/10 dark:bg-neutral-800/90 dark:ring-white/10">
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-neutral-400 border-t-transparent" />
            <span className="text-neutral-700 dark:text-neutral-200">{busyLabel}</span>
          </div>
        </div>
      )}

      {/* Hidden off-screen IME-capture input (keystrokes + composition route here on an editable click). */}
      <input
        ref={imeInput}
        aria-hidden="true"
        tabIndex={-1}
        className="absolute -left-[9999px] top-0 h-px w-px opacity-0"
        onKeyDown={onCaretKeyDown}
        onCompositionStart={() => setComposing(true)}
        onCompositionEnd={onCompositionEnd}
      />

      <Palette open={paletteOpen} onOpenChange={setPaletteOpen} commands={commands} />
      <Composer mode={composer} onClose={() => setComposer(null)} ctx={composerCtx} />
      <Toaster />
    </div>
  );
}
