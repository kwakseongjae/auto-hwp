import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
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

  // ---- Zoom: the page column is sized off a base A4 CSS width (≈794px = 210mm @ 96dpi). `zoom` is a
  // factor where 1 = 100%; "fit-width" (zoom === 0 sentinel) tracks the scroll viewport's width so a
  // page fills the column. Page height follows the A4 ratio (√2). The virtualizer's estimate + the
  // SVG wrapper's containIntrinsicSize are derived from this so a zoom change re-lays the list.
  const A4_W = 794; // CSS px for 210mm at 96dpi — the 100% page width
  const A4_RATIO = 1.414; // A4 height/width (297/210)
  const ZOOM_MIN = 0.5;
  const ZOOM_MAX = 1; // discrete control tops out at 100%; ⌘+ won't overshoot the segmented range
  // zoom === 0 is the "맞춤(가로)" / fit-width sentinel (resolved against the live viewport width).
  const [zoom, setZoom] = useState(1);
  const [fitWidth, setFitWidth] = useState(A4_W); // measured viewport width for the fit-width mode
  // Resolve the zoom factor to a concrete CSS page width. Fit-width clamps to a sane band so a tiny or
  // huge window doesn't produce an unusable page.
  const pageWidth = zoom === 0 ? Math.max(360, Math.min(fitWidth, 1400)) : A4_W * zoom;
  const pageHeight = pageWidth * A4_RATIO;
  // Status-bar go-to-page input (controlled string; commit on Enter / blur).
  const [gotoText, setGotoText] = useState("");

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
  // Drag-drop image insert: highlight the page container while a file is dragged over it (M1).
  const [dragActive, setDragActive] = useState(false);

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
  // caretRect mirrored to a ref so a zoom-driven re-layout can re-place the caret box without it being
  // a dependency of the zoom effect.
  const caretRectRef = useRef<CaretRect | null>(null);
  caretRectRef.current = caretRect;
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
    // Zoom-derived A4 page height (was a hardcoded 920) so a zoom change re-estimates every page; the
    // real per-page height still comes from measureElement once the SVG paints.
    estimateSize: () => Math.round(pageHeight),
    overscan: 2,
    gap: 24,
  });

  // A zoom change resizes every page, so re-measure the virtual list (estimateSize already reads the
  // new pageHeight; this forces the cached measurements to be dropped + recomputed). Re-running the
  // caret box keeps it pinned to the (now differently scaled) glyph.
  useEffect(() => {
    virtualizer.measure();
    if (caretRef.current && caretRectRef.current) recomputeCaretBox(caretRef.current.page, caretRectRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageWidth]);

  // Track the scroll viewport's width so "맞춤(가로)" (fit-width) keeps a page filling the column as
  // the window or chat panel resizes. p-6 = 24px padding each side on <main>.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => setFitWidth(Math.max(0, el.clientWidth - 48));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

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

  // Export the LIVE doc to a self-contained HTML file (JSX/CSS → emit_html; matches the HTML preview).
  const doExportHtml = useCallback(async () => {
    if (pageCountRef.current === 0) return;
    const path = await saveDialog({ defaultPath: "export.html", filters: [{ name: "HTML", extensions: ["html", "htm"] }] });
    if (typeof path !== "string") return;
    setBusyLabel("HTML 내보내는 중…");
    try {
      toast("ok", `HTML 내보냄 · ${await api.exportHtml(path)}`);
    } catch (e) {
      toast("warn", `HTML 내보내기 실패: ${e}`);
    } finally {
      setBusyLabel(null);
    }
  }, []);

  // Export the LIVE doc to a PDF through OUR OWN engine (place_doc → paint IR → krilla; matches 자체
  // 렌더, not a browser print). Needs the `pdf` feature — the command surfaces a clear error if absent.
  const doExportPdf = useCallback(async () => {
    if (pageCountRef.current === 0) return;
    const path = await saveDialog({ defaultPath: "export.pdf", filters: [{ name: "PDF", extensions: ["pdf"] }] });
    if (typeof path !== "string") return;
    setBusyLabel("PDF 내보내는 중…");
    try {
      toast("ok", `PDF 내보냄 · ${await api.exportPdf(path)}`);
    } catch (e) {
      toast("warn", `PDF 내보내기 실패: ${e}`);
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

  // ---- Zoom verbs ----
  // ⌘+/⌘- step through the same discrete levels the segmented control offers (excluding fit-width,
  // which is a viewport-relative mode). ⌘0 resets to 100%.
  const ZOOM_STEPS = useMemo(() => [0.5, 0.75, 1], []);
  const zoomIn = useCallback(() => {
    setZoom((z) => {
      const cur = z === 0 ? 1 : z; // from fit-width, ⌘+ snaps into the discrete band at 100%
      const next = ZOOM_STEPS.find((s) => s > cur + 1e-6);
      return next ?? Math.min(ZOOM_MAX, cur);
    });
  }, [ZOOM_STEPS]);
  const zoomOut = useCallback(() => {
    setZoom((z) => {
      const cur = z === 0 ? 1 : z;
      const lower = [...ZOOM_STEPS].reverse().find((s) => s < cur - 1e-6);
      return lower ?? Math.max(ZOOM_MIN, cur);
    });
  }, [ZOOM_STEPS]);
  const zoomReset = useCallback(() => setZoom(1), []);

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
      { id: "export-html", title: "HTML 내보내기", group: "문서", keywords: "export html 내보내기 웹 저장 save", disabled: !haveDoc, run: doExportHtml },
      { id: "export-pdf", title: "PDF 내보내기", group: "문서", keywords: "export pdf 내보내기 저장 save 인쇄", disabled: !haveDoc, run: doExportPdf },
      { id: "chat", title: "AI 바이브 편집 (채팅)", group: "작성", keys: "⌘L", keywords: "ai chat 채팅 편집 vibe 바이브 표 이미지", tone: "ai", disabled: !canEdit, run: () => setChatOpen((o) => !o) },
      { id: "table", title: "표 추가 (문서 끝에)", group: "작성", keys: "⌘T", keywords: "table 표 추가 그리드", disabled: !canEdit, run: () => setComposer("table") },
      { id: "ai", title: "AI 콘텐츠 제안", group: "작성", keys: "⌘.", keywords: "ai 제안 작성 propose", tone: "ai", disabled: !canEdit, run: () => setComposer("ai") },
      { id: "find", title: "찾기 / 바꾸기", group: "편집", keys: "⌘F", keywords: "find replace 찾기 바꾸기 검색 치환", disabled: !haveDoc, run: openFind },
      { id: "undo", title: "실행 취소", group: "편집", keys: "⌘Z", keywords: "undo 실행취소", disabled: !canEdit, run: doUndo },
      { id: "redo", title: "다시 실행", group: "편집", keys: "⌘⇧Z", keywords: "redo 다시실행", disabled: !canEdit, run: doRedo },
    ];
  }, [pageCount, canEdit, doOpen, doExport, doExportHtml, doExportPdf, openFind, doUndo, doRedo]);

  // ---- global shortcuts: registered ONCE; closures call the always-current handler set via a ref. ----
  const handlers = useRef({ doOpen, doExport, doUndo, doRedo, openFind, zoomIn, zoomOut, zoomReset });
  handlers.current = { doOpen, doExport, doUndo, doRedo, openFind, zoomIn, zoomOut, zoomReset };
  const canEditForKeys = useRef(canEdit);
  canEditForKeys.current = canEdit;
  useEffect(() => {
    const un = tinykeys(window, {
      "$mod+k": (e) => { e.preventDefault(); setPaletteOpen((o) => !o); },
      "$mod+o": (e) => { e.preventDefault(); void handlers.current.doOpen(); },
      // ⌘S and ⌘E are the SAME verb (save/export HWPX). Bound once each to the shared handler so the
      // two accelerators advertised across the UI (palette ⌘S, footer ⌘E) both work — no real conflict.
      "$mod+s": (e) => { e.preventDefault(); void handlers.current.doExport(); },
      "$mod+e": (e) => { e.preventDefault(); void handlers.current.doExport(); },
      "$mod+f": (e) => { e.preventDefault(); handlers.current.openFind(); },
      // Zoom: ⌘0 → 100%, ⌘+ (=⌘⇧=) / ⌘= → in, ⌘- → out. Bound by KEY CODE so the shifted '+' on a
      // US/Korean layout still lands on Equal.
      "$mod+Digit0": (e) => { e.preventDefault(); handlers.current.zoomReset(); },
      "$mod+Equal": (e) => { e.preventDefault(); handlers.current.zoomIn(); },
      "$mod+Minus": (e) => { e.preventDefault(); handlers.current.zoomOut(); },
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

  // ---- M1: drag a local IMAGE file onto a page → insert it at the pointed block (DIRECT manipulation:
  // commits IMMEDIATELY as one undoable op, NOT a chat proposal). The browser `ondrop` never fires in
  // the WebView, so we subscribe to Tauri's native `onDragDropEvent`, which carries the OS file PATHS
  // (Rust reads the bytes) + a physical drop position we map to page coords → hit_test → InsertImageAt.
  useEffect(() => {
    const IMG_EXT = /\.(png|jpe?g|gif|bmp|webp|tiff?)$/i;
    const isImage = (p: string) => IMG_EXT.test(p);
    let un: undefined | (() => void);
    (async () => {
      un = await getCurrentWebviewWindow().onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type === "leave") {
          setDragActive(false);
          return;
        }
        // 'enter'/'over' carry a position; show the drop affordance only for an editable doc in an
        // SVG page mode (the caret/hit-test geometry — and thus our anchor — comes from that path).
        if (payload.type === "enter" || payload.type === "over") {
          const droppable = canEditRef.current && viewModeRef.current !== "html";
          // 'enter' carries paths; only highlight when at least one is an image.
          const hasImage = payload.type === "over" || payload.paths.some(isImage);
          setDragActive(droppable && hasImage);
          return;
        }
        // payload.type === "drop"
        setDragActive(false);
        if (!canEditRef.current || viewModeRef.current === "html") return;
        const imgs = payload.paths.filter(isImage);
        if (imgs.length === 0) {
          if (payload.paths.length > 0) toast("info", "이미지 파일만 끌어다 놓을 수 있습니다 (png/jpg/gif…)");
          return;
        }
        // GUARD the known Tauri HiDPI bug: the drop position arrives in PHYSICAL pixels, but
        // elementFromPoint / getBoundingClientRect work in CSS pixels — divide by devicePixelRatio.
        const dpr = window.devicePixelRatio || 1;
        const clientX = payload.position.x / dpr;
        const clientY = payload.position.y / dpr;
        void enqueueEdit(async () => {
          // Map the drop point to an editable anchor via the SAME page-coords→hit_test path as a click;
          // on a miss fall back to the last-pointed scope, else the section/doc end (block=null → end).
          let scopeArg: { section: number; block: number | null } | null = null;
          const host = document.elementFromPoint(clientX, clientY)?.closest("[data-index]") ?? null;
          const svg = host?.querySelector("svg") ?? null;
          if (host && svg) {
            const page = Number(host.getAttribute("data-index"));
            const rect = svg.getBoundingClientRect();
            const vb = svg.viewBox.baseVal;
            const pt = screenToPage(
              clientX,
              clientY,
              { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
              { width: vb.width, height: vb.height },
            );
            if (Number.isFinite(page) && pt) {
              try {
                const hit = await api.hitTest(page, pt.x, pt.y);
                if (hit) scopeArg = { section: hit.section, block: hit.block };
              } catch {
                /* hit-test miss → fall through to the scope/end fallback below */
              }
            }
          }
          if (!scopeArg && scopeRef.current) {
            scopeArg = { section: scopeRef.current.section, block: scopeRef.current.block };
          }
          // ONE undoable op, applied immediately (no propose→review) — the direct-manipulation contract.
          const n = await api.applyImageDrop(imgs[0], scopeArg);
          setEdited(true);
          invalidate(n, scopeArg ? (scopeRef.current?.page ?? null) : null);
          const more = imgs.length - 1;
          toast("info", more > 0 ? `이미지 삽입됨 (나머지 ${more}개는 건너뜀)` : "이미지 삽입됨");
        });
      });
    })();
    return () => un?.();
  }, [enqueueEdit, invalidate]);

  // Current page for the status bar: the first virtual item still on screen (the virtualizer re-renders
  // on scroll, so this stays live). 1-based for display; falls back to 1 before the first measure.
  const currentPage = listCount > 0 ? (virtualizer.getVirtualItems()[0]?.index ?? 0) + 1 : 0;
  // Go-to-page: clamp to [1, listCount], scroll, sync the input. Empty/NaN input is a no-op.
  const goToPage = useCallback((oneBased: number) => {
    if (listCount === 0 || !Number.isFinite(oneBased)) return;
    const idx = Math.max(0, Math.min(Math.round(oneBased) - 1, listCount - 1));
    virtualizer.scrollToIndex(idx, { align: "start" });
    setGotoText("");
  }, [virtualizer, listCount]);

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
          <Tool onClick={doExport} icon="⬇︎" label="HWPX" keys="⌘S" />
          <Tool onClick={doExportHtml} icon="🅷" label="HTML" />
          <Tool onClick={doExportPdf} icon="📄" label="PDF" />
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
        {/* SVG-page modes ('svg' 원본 / 'own' 자체 렌더) lay WHITE sheets on a light DOCUMENT PASTEBOARD
            (like Word/Hancom keep a neutral canvas behind pages) so the inter-page gap reads as a soft
            light band — NOT the dark app background, which made the gap look like a full-width black bar
            in dark mode. The HTML iframe + empty state keep the normal app background. */}
        <main
          ref={scrollRef}
          className={`min-h-0 flex-1 overflow-auto p-6 ${
            listCount > 0 && viewMode !== "html" ? "bg-neutral-200 dark:bg-neutral-800" : ""
          }`}
        >
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
              // Zoom-derived page width (replaces the fixed max-w-3xl) so the HTML preview tracks the
              // segmented zoom / fit-width control like the SVG pages do.
              style={{ width: `${pageWidth}px` }}
              className="mx-auto block rounded-lg border-0 bg-white shadow-md ring-1 ring-black/5"
            />
          ) : listCount > 0 ? (
            // SVG page list — shared by 'svg' (rhwp 원본) and 'own' (자체 렌더, OUR engine). The two have
            // separate caches/ensure-fns + page counts; the caret (whose geometry is from the rhwp
            // render path) only attaches in 'svg' mode.
            <div
              className={`relative mx-auto rounded-lg ${dragActive ? "ring-2 ring-accent ring-offset-4 ring-offset-neutral-200 dark:ring-offset-neutral-800" : ""}`}
              // Zoom-derived column width (replaces max-w-3xl); height is the virtualizer total.
              style={{ width: `${pageWidth}px`, height: `${virtualizer.getTotalSize()}px` }}
              onClick={(e) => void onPageClick(e)}
            >
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
                      // Zoom-derived intrinsic height (was a fixed 920px) so off-screen pages reserve
                      // the right space before their SVG paints.
                      style={{ contentVisibility: "auto", containIntrinsicSize: `auto ${Math.round(pageHeight)}px` }}
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
          {/* M1: drop affordance — a sticky pill while an image file is dragged over the pages. */}
          {dragActive && (
            <div className="pointer-events-none sticky bottom-4 z-20 mx-auto flex w-fit items-center gap-2 rounded-full border border-accent/40 bg-accent/10 px-3 py-1.5 text-sm font-medium text-accent shadow-lg backdrop-blur">
              🖼️ 여기에 놓아 이미지 삽입
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

      <footer className="flex h-7 shrink-0 items-center gap-3 border-t border-black/10 px-3 text-xs text-neutral-500 dark:border-white/10 dark:text-neutral-400">
        {/* LEFT: doc name · page X / N + a go-to-page input. */}
        {pageCount > 0 ? (
          <>
            {docName && <span className="max-w-[16rem] truncate font-medium text-neutral-600 dark:text-neutral-300">{docName}</span>}
            <span className="flex items-center gap-1 tabular-nums">
              <span>쪽</span>
              <input
                type="number"
                min={1}
                max={listCount}
                value={gotoText === "" ? currentPage : gotoText}
                onChange={(e) => setGotoText(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); goToPage(Number(e.currentTarget.value)); e.currentTarget.blur(); }
                  else if (e.key === "Escape") { e.preventDefault(); setGotoText(""); e.currentTarget.blur(); }
                }}
                onBlur={(e) => { if (gotoText !== "") goToPage(Number(e.currentTarget.value)); }}
                title="이동할 쪽 번호"
                className="w-10 rounded border border-black/10 bg-white px-1 py-0.5 text-center tabular-nums outline-none focus:border-accent dark:border-white/10 dark:bg-neutral-900"
              />
              <span>/ {listCount}</span>
            </span>
          </>
        ) : (
          <span>준비됨</span>
        )}

        <span className="flex-1" />

        {/* CENTER-RIGHT: zoom segmented control — 50 / 75 / 100 / 맞춤(가로). */}
        {pageCount > 0 && (
          <div className="flex items-center gap-0.5 rounded-md bg-black/5 p-0.5 dark:bg-white/10">
            {([
              { v: 0.5, label: "50%" },
              { v: 0.75, label: "75%" },
              { v: 1, label: "100%" },
              { v: 0, label: "맞춤" },
            ] as const).map((z) => (
              <button
                key={z.label}
                onClick={() => setZoom(z.v)}
                title={z.v === 0 ? "가로 맞춤" : `${z.label} 배율`}
                className={`rounded px-1.5 py-0.5 tabular-nums ${
                  zoom === z.v
                    ? "bg-white text-neutral-900 shadow-sm dark:bg-neutral-700 dark:text-neutral-100"
                    : "text-neutral-500 hover:bg-black/5 dark:text-neutral-400 dark:hover:bg-white/10"
                }`}
              >
                {z.label}
              </button>
            ))}
          </div>
        )}

        {/* RIGHT: provider badge · edited/saved dot · render spinner. */}
        {pageCount > 0 && (
          <>
            <span className="h-3.5 w-px bg-black/10 dark:bg-white/10" />
            <span title={`AI 제공자: ${provider}`} className="flex items-center gap-1 text-[11px]">
              <span className={`h-1.5 w-1.5 rounded-full ${provider !== "none" && provider !== "mock" ? "bg-emerald-500" : "bg-neutral-400"}`} />
              {provider === "none" ? "AI 없음" : provider}
            </span>
            <span title={edited ? "저장되지 않은 변경 있음" : "저장됨"} className="flex items-center gap-1 text-[11px]">
              <span className={`h-1.5 w-1.5 rounded-full ${edited ? "bg-amber-500" : "bg-emerald-500"}`} />
              {edited ? "수정됨" : "저장됨"}
            </span>
          </>
        )}
        {rendering && (
          <span className="flex items-center gap-1.5 text-neutral-400">
            <span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
            렌더 중…
          </span>
        )}
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
