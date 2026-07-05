import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Box, CellDir, DocContext, EngineAdapter, Intent, MatchBox, OutlineItem, PageGeom, PointerInput, RunSpec, Selection, TableBox } from "@tf-hwp/editor-core";
import { boundariesToRatios, remapFragmentHeights, appliedReflectsDrag, firstRunStyle } from "@tf-hwp/editor-core";
import { OutlinePanel } from "./OutlinePanel";
import { StatusBar } from "./StatusBar";
import { pageAtReference } from "../outline";
import { runsUnchanged } from "../richedit";
import { modLabel } from "../platform";
import { ZOOM_STEP, clampZoom, isEditableTarget, panBy, wheelToZoomFactor, zoomAt } from "../viewport";
import { useHwpEditor } from "../useHwpEditor";
import { ChatPanel } from "./ChatPanel";
import { HwpPageView, type PageClick } from "./HwpPageView";
import { SelectionOverlay, type Mark } from "./SelectionOverlay";
import { MarqueeLayer } from "./MarqueeLayer";
import { HoverLayer } from "./HoverLayer";
import { useHover } from "../useHover";
import { FontPicker } from "./FontPicker";
import { ColumnResizeOverlay, RowResizeOverlay } from "./ColumnResizeOverlay";
import { TableInsertButton } from "./TableInsertButton";
import { Ruler } from "./Ruler";
import { InPlaceCellEditor } from "./InPlaceCellEditor";
import { FloatingToolbar } from "./FloatingToolbar";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { TableSizeGrid } from "./TableSizeGrid";
import { FindBar } from "./FindBar";
import { FindMatchOverlay } from "./FindMatchOverlay";
import { useSelectionActions } from "../useSelectionActions";
import { readViewBox, screenToPage } from "../coords";
import { buildFontFaceCss, type FontCatalogEntry } from "../fonts";

const A4_W = 794; // CSS px for 210mm @ 96dpi (mirrors HwpPageView) — the 100% page width.

// issue 046: the outline panel remembers its collapsed state across sessions (localStorage). Guarded so a
// non-browser / private-mode environment (or a test without storage) degrades to "expanded" silently.
const OUTLINE_COLLAPSED_KEY = "tf-hwp:outline-collapsed";
function readOutlineCollapsed(): boolean {
  try {
    return globalThis.localStorage?.getItem(OUTLINE_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}
function writeOutlineCollapsed(v: boolean): void {
  try {
    globalThis.localStorage?.setItem(OUTLINE_COLLAPSED_KEY, v ? "1" : "0");
  } catch {
    /* storage unavailable — the in-memory state still works for this session */
  }
}

// Arrow key → cell-nav direction (issue 036). Only these four keys navigate; everything else falls through
// to the document default (native scroll / editor caret).
const ARROW_DIR: Record<string, CellDir | undefined> = {
  ArrowRight: "right",
  ArrowLeft: "left",
  ArrowUp: "up",
  ArrowDown: "down",
};

// ── dev-only render instrumentation (issue 030) ─────────────────────────────────────────────────────
// Counts how many times HwpWorkspace itself commits. The marquee decoupling means a pointermove during a
// drag no longer bumps a workspace `useState`, so this counter stays FLAT across a 30-move drag (only the
// isolated MarqueeLayer updates). `DEV_INSTRUMENT` is a build-time constant so the branch is stripped
// from production bundles (Vite folds `import.meta.env.PROD`).
const DEV_INSTRUMENT: boolean = (import.meta as { env?: { PROD?: boolean } }).env?.PROD !== true;
type WsRenderGlobal = { __hwWorkspaceRenders?: number };
function bumpWorkspaceRenderCount(): void {
  if (!DEV_INSTRUMENT) return;
  const g = globalThis as WsRenderGlobal;
  g.__hwWorkspaceRenders = (g.__hwWorkspaceRenders ?? 0) + 1;
}
/** DEV/test helper: how many times HwpWorkspace has committed since the last reset. */
export function __getWorkspaceRenderCount(): number {
  return (globalThis as WsRenderGlobal).__hwWorkspaceRenders ?? 0;
}
/** DEV/test helper: zero the workspace render counter (call right before a measured gesture). */
export function __resetWorkspaceRenderCount(): void {
  (globalThis as WsRenderGlobal).__hwWorkspaceRenders = 0;
}

/** The single-selection edit target the issue-027 editing chrome hangs off (column handles / format
 *  toolbar / text popover). Resolved async from the current selection (adds the table box + column
 *  boundaries + current bold/italic for a table selection). */
interface EditTarget {
  page: number;
  section: number;
  block: number;
  kind: string;
  box: Box;
  rows?: [number, number];
  cols?: [number, number];
  text: string;
  /** The placed table box (own-render px) — carries `first_row`/`rows` for the split-table row remap. */
  tableBox?: TableBox | null;
  /** `cols + 1` column-boundary x's for the column-resize handles (issue 027). */
  boundaries?: number[] | null;
  /** `rows + 1` row-boundary y's (per-page fragment on a split table) for the row-resize handles (031). */
  rowBoundaries?: number[] | null;
  curBold: boolean;
  curItalic: boolean;
}

export interface HwpWorkspaceProps {
  /** The backend seam (WasmAdapter for the web, or a host adapter). */
  adapter: EngineAdapter;
  /** The document to open (bytes + optional name). Re-opens when the `bytes` reference changes. When
   *  omitted, the workspace shows an empty state (the host drives opening). */
  document?: { bytes: Uint8Array; name?: string } | null;
  /** The host AI bridge (R6): instruction + anchors + doc context → Intents. Never an LLM in-package. */
  onAiRequest: import("@tf-hwp/editor-core").OnAiRequest;
  /** Show the honest mock badge in the chat panel. */
  isMock?: boolean;
  /** Supply a TTF/OTF face for PDF export on demand (R8). Called when PDF is requested and no font is
   *  registered yet. Return null to cancel. The DEMO wires this to a local .ttf picker / Noto fetch. */
  requestFont?: () => Promise<{ family: string; bytes: Uint8Array } | null>;
  /** The curated OFL font catalog (issue 022). When present, a FontPicker is shown in the toolbar so
   *  the user can pick/upload a font that drives screen + layout + PDF alike. Omit to hide the picker. */
  fontCatalog?: readonly FontCatalogEntry[];
  /** A default font `{ family, bytes }` auto-registered right after opening (issue 022) — screen SVG,
   *  pagination and PDF all use it immediately (PDF button usable without a manual pick). */
  defaultFont?: { family: string; bytes: Uint8Array } | null;
  /** Base URL the catalog fonts are served from (default `/fonts`); forwarded to the FontPicker. */
  fontUrlBase?: string;
  /** Opt-in: enable the issue-027 MANUAL editing chrome (표 추가 버튼 · 상단 룰러 · 열너비 드래그 ·
   *  더블클릭 텍스트 팝오버 · 선택 서식 툴바). Default OFF — the workspace behaves exactly as before
   *  (chat-only) when omitted, so existing hosts/tests are unaffected. */
  enableEditing?: boolean;
  /** Opt-in (issue 044): intercept the HTML/PDF export buttons. Called with the export payload
   *  (`Uint8Array` for PDF, `string` for HTML), a suggested filename, and the MIME type. When omitted
   *  the workspace uses the WEB default — a browser `<a download>` — UNCHANGED (web vitest pins this).
   *  A DESKTOP host supplies this to route the output to a native save dialog + atomic write instead of
   *  a browser download (the `<a download>` web convention must not leak into the Tauri shell). */
  onExport?: (data: Uint8Array | string, filename: string, mime: string) => void | Promise<void>;
  className?: string;
}

/** Map a page-local click (client-px converted to page-px in HwpPageView) to the core's DOM-free pointer
 *  input. The client point rides along ONLY for the zoom-independent drag threshold (§함정). */
const toPointerInput = (c: PageClick): PointerInput => ({ page: c.page, x: c.x, y: c.y, mod: c.meta, client: c.client });

/// HwpWorkspace — the one-line assembly (issue 016): page view + selection overlay + chat panel. Open a
/// document, SELECT blocks (OS-style: click = replace, ⌘/Ctrl-click = toggle, drag over empty space =
/// marquee — issue 021), say what to change, review the previewed Intents, apply, and download HTML/PDF.
///
/// After issue 026 this is a THIN React binding: all editing state + logic (selection, undo, apply, doc
/// lifecycle) live in @tf-hwp/editor-core (via `useHwpEditor`); this component only renders that state
/// and owns the genuinely DOM-y bits (toasts, the screen @font-face blob, file download, page scroll).
/// The AI is delegated to `onAiRequest` (R6); SVG is sanitized in HwpPageView (R7); fonts are injected
/// via `requestFont`/`defaultFont` (R8).
export function HwpWorkspace(props: HwpWorkspaceProps) {
  bumpWorkspaceRenderCount(); // dev-only; folded out of production bundles (issue 030 render-count proof)
  const { adapter } = props;
  const { core, meta, selection, refreshToken, bumpRefresh } = useHwpEditor(adapter);
  const [zoom, setZoom] = useState(0.9);
  const [status, setStatus] = useState<string>("");
  // ── issue 046: outline panel + status bar (leftbar/bottombar layout only — 045 owns keydown/toolbar) ──
  // The document outline (engine headings), the page currently at the top of the viewport (a SCROLL-
  // POSITION calc, independent of the 037 virtualization visible set), and the panel's persisted collapse.
  const [outline, setOutline] = useState<OutlineItem[]>([]);
  const [currentPage, setCurrentPage] = useState(0);
  const [outlineCollapsed, setOutlineCollapsed] = useState<boolean>(() => readOutlineCollapsed());
  // ── issue 035 pan/zoom viewport ────────────────────────────────────────────────────────────────────
  // The scroll container (`.hw-canvas`) + the transform layer wrapping the pages. Continuous ⌘/pinch zoom
  // mutates `zoomLayer.style.transform` DIRECTLY (0 React renders per tick — see the gesture refs below);
  // the debounced commit is the single `setZoom` that re-lays-out the sheets at the new scale.
  const canvasRef = useRef<HTMLDivElement>(null);
  const zoomLayerRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef(zoom); // live mirror so the once-attached wheel listener reads the current zoom
  zoomRef.current = zoom;
  // Space-hold pan: `panMode` = Space is down (grab cursor); `panning` = a pan drag is in progress
  // (grabbing cursor). The drag itself mutates scroll via refs (no per-move render, issue 030 discipline).
  const [panMode, setPanMode] = useState(false);
  const [panning, setPanning] = useState(false);
  const panModeRef = useRef(false);
  panModeRef.current = panMode;
  const panLastRef = useRef<{ x: number; y: number } | null>(null);
  const panningRef = useRef(false);
  // The in-flight continuous-zoom gesture (null between gestures). Cached at gesture start so every wheel
  // tick reuses the SAME transform-origin/scroll/baseZoom while only the accumulated `factor` grows.
  const zoomGestureRef = useRef<{ originX: number; originY: number; scrollLeft: number; scrollTop: number; baseZoom: number; factor: number } | null>(null);
  const zoomCommitTimerRef = useRef<number | null>(null);
  const pendingScrollRef = useRef<{ left: number; top: number } | null>(null);
  // Selected font for the SCREEN (issue 022): family + a blob URL of the SAME bytes registered for
  // metrics + PDF, so the @font-face'd SVG matches the exported PDF exactly. (The engine-side register +
  // re-pagination is owned by the core; this state is the DOM/@font-face half only.)
  const [selectedFont, setSelectedFont] = useState<{ family: string; url: string } | null>(null);
  const defaultFontAppliedFor = useRef<Uint8Array | null>(null);
  // Last pointer-up (time + client px) for the double-click detector. We can't use the DOM `dblclick`
  // event: HwpPageView `setPointerCapture`s on pointerdown, which redirects the pointerup so the browser
  // never synthesizes click/dblclick. So we detect "two quick ups at ~the same spot" ourselves.
  const lastUpRef = useRef<{ t: number; x: number; y: number } | null>(null);
  // Issue 027 editing chrome (opt-in): the resolved single-selection edit target, the ruler geometry,
  // and the open text popover. All null/off when `enableEditing` is not set.
  const editingOn = !!props.enableEditing;
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null);
  const [pageGeom0, setPageGeom0] = useState<PageGeom | null>(null);
  // Issue 028 floating toolbar surface: hide the toolbar while a pointer gesture (drag/marquee) is in
  // progress, and a monotonic token the "AI에게 전달" button bumps to focus the chat composer.
  const [pointerActive, setPointerActive] = useState(false);
  const [aiFocusToken, setAiFocusToken] = useState(0);
  // Issue 032: the OPEN in-place text editor (Figma-style), replacing the 027 popover card. Carries the
  // cell's FIRST-run size (px→pt via firstRunStyle) so InPlaceCellEditor renders at the cell's own font
  // size. `fontSizePt` is undefined when the run size is unknown (editor inherits the sheet default).
  // Issue 040: the editor now carries the target's CURRENT styled `runs` (not just plain `text`) so the
  // contentEditable rich editor renders + round-trips per-run formatting, and the commit compares against
  // them for the no-op (미접촉 셀 재커밋 = no-op) check. `text` is kept for the anchor/label snippet.
  const [editor, setEditor] = useState<
    { page: number; box: Box; section: number; block: number; kind: string; rows?: [number, number]; cols?: [number, number]; text: string; runs: RunSpec[]; fontSizePt?: number } | null
  >(null);
  // Issue 039: the OPEN right-click context menu. `kind` branches the item set (셀/문단/바탕); `click`
  // carries the page-local point so 텍스트 편집 re-opens the in-place editor exactly where the user
  // right-clicked; `cell` carries the address + column count for 행 삽입 (existing TableInsertRows path).
  const [contextMenu, setContextMenu] = useState<
    | {
        x: number;
        y: number;
        kind: "cell" | "paragraph" | "background";
        click: PageClick;
        cell?: { section: number; block: number; row: number; cols: number };
      }
    | null
  >(null);
  // A hidden native color input the context menu's 배경색 item triggers — so that item delegates to the
  // SAME shadeCellRange action as the 028 toolbar's 배경 swatch (신규 액션 0), just entered via a menu click.
  const shadeInputRef = useRef<HTMLInputElement>(null);

  // ── Issue 045: 찾기/바꾸기 state ─────────────────────────────────────────────────────────────────────
  // The ⌘F bar drives the editor-core FindController (core.find). `findCount` is null until a search runs
  // for the CURRENT query (typing invalidates it → the "n/m" readout hides), matching the desktop bar.
  // `findBoxes` are the caretRect-resolved match boxes the FindMatchOverlay draws (null where geometry is
  // unavailable). Refs mirror the values the (stable) ⌘F keydown listener + search callbacks read.
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findReplace, setFindReplace] = useState("");
  const [findCase, setFindCase] = useState(false);
  const [findCount, setFindCount] = useState<number | null>(null);
  const [findOrdinal, setFindOrdinal] = useState(0);
  const [findBoxes, setFindBoxes] = useState<(MatchBox | null)[]>([]);
  const [findBusy, setFindBusy] = useState(false);
  const [findFocusToken, setFindFocusToken] = useState(0);
  const findQueryRef = useRef(findQuery);
  findQueryRef.current = findQuery;
  const findCaseRef = useRef(findCase);
  findCaseRef.current = findCase;
  const findReplaceRef = useRef(findReplace);
  findReplaceRef.current = findReplace;
  const findBoxesRef = useRef(findBoxes);
  findBoxesRef.current = findBoxes;
  const findOpenRef = useRef(findOpen);
  findOpenRef.current = findOpen;
  // Live mirror of `meta` so the once-attached ⌘F keydown listener knows a document is open without
  // re-subscribing on every meta change.
  const metaRef = useRef(meta);
  metaRef.current = meta;
  // Serializes ALL find engine ops (search / re-find-after-edit / replace) through one async chain so two
  // never race on the shared FindController state (e.g. a replace's auto re-find colliding with a fresh
  // user search would interleave `search()` calls and corrupt the match set). Last-enqueued wins.
  const findChainRef = useRef<Promise<void>>(Promise.resolve());

  // The live selection is the single source of truth (in the core); the chat anchors + page marks are
  // views of it, mapped here for the components.
  const anchors = useMemo(() => selection.map((s) => s.anchor), [selection]);
  const marks = useMemo<Mark[]>(() => selection.map((s) => s.mark), [selection]);
  const mod = useMemo(() => modLabel(), []);

  // Live mirrors so the (once-attached) cell-nav keydown listener reads the CURRENT selection/editor
  // without re-subscribing on every change (issue 036 — coexists with the 035 window keydown). `tabMoving`
  // suppresses the refreshToken editor-close while a Tab commit-move re-enters the next cell.
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const editorRef = useRef(editor);
  editorRef.current = editor;
  const tabMovingRef = useRef(false);
  // Live boolean mirror for the hover suppression gate (issue 038) — true while the in-place editor is open.
  const editorOpenRef = useRef(false);
  editorOpenRef.current = editor != null;

  const toast = useCallback((s: string) => {
    setStatus(s);
    window.setTimeout(() => setStatus((cur) => (cur === s ? "" : cur)), 4000);
  }, []);

  const clearSelection = useCallback(() => core.selection.clear(), [core]);

  // ── issue 035: continuous zoom (CSS transform) → debounced real-scale commit ─────────────────────────
  // Commit the accumulated gesture: convert the transient transform into a real `setZoom` (single
  // re-layout) + the cursor-anchored scroll. The transform stays applied until the useLayoutEffect below
  // clears it in the SAME frame the new width lands, so there is no double-scale flash on settle.
  const commitZoomGesture = useCallback(() => {
    const g = zoomGestureRef.current;
    const canvas = canvasRef.current;
    const layer = zoomLayerRef.current;
    zoomGestureRef.current = null;
    if (zoomCommitTimerRef.current != null) {
      window.clearTimeout(zoomCommitTimerRef.current);
      zoomCommitTimerRef.current = null;
    }
    if (!g || !canvas || !layer) return;
    const res = zoomAt({
      zoom: g.baseZoom,
      factor: g.factor,
      pointerX: g.originX - g.scrollLeft, // on-screen offset of the anchor from the content-box top-left
      pointerY: g.originY - g.scrollTop,
      scrollLeft: g.scrollLeft,
      scrollTop: g.scrollTop,
    });
    // Zoom didn't change (already clamped at 25%/400%): reset the transform + apply scroll now, since a
    // no-change setZoom would NOT fire the useLayoutEffect that normally does it.
    if (res.zoom === zoomRef.current) {
      layer.style.transform = "";
      layer.style.transformOrigin = "";
      canvas.scrollLeft = res.scrollLeft;
      canvas.scrollTop = res.scrollTop;
      return;
    }
    pendingScrollRef.current = { left: res.scrollLeft, top: res.scrollTop };
    setZoom(res.zoom);
  }, []);

  // ⌘/Ctrl + wheel (and macOS trackpad pinch = ctrlKey wheel): zoom about the cursor. Plain wheel is left
  // to native scroll (no preventDefault). Each tick mutates ONLY the layer transform (no React render); a
  // 150ms-idle debounce fires the real commit once. Attached passive:false on the scroll container so the
  // ⌘-wheel preventDefault actually takes (§함정: wheel 리스너는 스크롤 컨테이너에만 passive:false).
  const onWheelZoom = useCallback(
    (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return; // plain wheel → native scroll (do NOT preventDefault)
      const canvas = canvasRef.current;
      const layer = zoomLayerRef.current;
      if (!canvas || !layer) return;
      e.preventDefault();
      const tick = wheelToZoomFactor(e.deltaY);
      let g = zoomGestureRef.current;
      if (!g) {
        const rect = layer.getBoundingClientRect(); // untransformed at gesture start → stable anchor
        g = { originX: e.clientX - rect.left, originY: e.clientY - rect.top, scrollLeft: canvas.scrollLeft, scrollTop: canvas.scrollTop, baseZoom: zoomRef.current, factor: 1 };
        zoomGestureRef.current = g;
      }
      // Accumulate + clamp so baseZoom×factor stays in [25%,400%]; keep the transform-origin fixed.
      const desired = clampZoom(g.baseZoom * g.factor * tick);
      g.factor = desired / g.baseZoom;
      layer.style.transformOrigin = `${g.originX}px ${g.originY}px`;
      layer.style.transform = `scale(${g.factor})`;
      if (zoomCommitTimerRef.current != null) window.clearTimeout(zoomCommitTimerRef.current);
      zoomCommitTimerRef.current = window.setTimeout(commitZoomGesture, 150);
    },
    [commitZoomGesture],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.addEventListener("wheel", onWheelZoom, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheelZoom);
  }, [onWheelZoom]);

  // Reset the transform + apply the anchored scroll in the SAME frame the new sheet widths land (settle).
  useLayoutEffect(() => {
    const p = pendingScrollRef.current;
    if (!p) return;
    pendingScrollRef.current = null;
    const canvas = canvasRef.current;
    const layer = zoomLayerRef.current;
    if (layer) {
      layer.style.transform = "";
      layer.style.transformOrigin = "";
    }
    if (canvas) {
      canvas.scrollLeft = p.left;
      canvas.scrollTop = p.top;
    }
  }, [zoom]);

  // Discrete zoom about the viewport CENTER (toolbar ± and ⌘+/-/0). Reuses the SAME zoomAt math + the
  // single setZoom-then-settle path — the toolbar buttons and keys are one unified zoom state.
  const zoomAtCenter = useCallback((factor: number) => {
    const canvas = canvasRef.current;
    const layer = zoomLayerRef.current;
    if (!canvas || !layer) {
      setZoom((z) => clampZoom(z * factor));
      return;
    }
    const cRect = canvas.getBoundingClientRect();
    const lRect = layer.getBoundingClientRect();
    const cx = cRect.left + canvas.clientWidth / 2;
    const cy = cRect.top + canvas.clientHeight / 2;
    const res = zoomAt({
      zoom: zoomRef.current,
      factor,
      pointerX: cx - lRect.left - canvas.scrollLeft,
      pointerY: cy - lRect.top - canvas.scrollTop,
      scrollLeft: canvas.scrollLeft,
      scrollTop: canvas.scrollTop,
    });
    if (res.zoom === zoomRef.current) return;
    pendingScrollRef.current = { left: res.scrollLeft, top: res.scrollTop };
    setZoom(res.zoom);
  }, []);

  const zoomReset = useCallback(() => {
    const cur = zoomRef.current;
    if (Math.abs(cur - 1) < 1e-6) return;
    zoomAtCenter(1 / cur); // → 100%
  }, [zoomAtCenter]);

  // ⌘/Ctrl +/−/0 zoom keys + Space pan-mode toggle. The zoom keys work regardless of focus (Figma/browser
  // convention); Space is NEVER stolen from a text-entry surface (§함정) — that guard is isEditableTarget.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey) {
        if (e.key === "=" || e.key === "+") { e.preventDefault(); zoomAtCenter(ZOOM_STEP); return; }
        if (e.key === "-" || e.key === "_") { e.preventDefault(); zoomAtCenter(1 / ZOOM_STEP); return; }
        if (e.key === "0") { e.preventDefault(); zoomReset(); return; }
      }
      if (e.code === "Space") {
        // NEVER steal Space from a text-entry surface (in-place editor / chat composer / size input).
        if (isEditableTarget(e.target as Element | null) || isEditableTarget(document.activeElement)) return;
        e.preventDefault(); // suppress page-scroll for the WHOLE hold (incl. key auto-repeat) — Space is the pan modifier
        if (!e.repeat) setPanMode(true);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space") setPanMode(false);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [zoomAtCenter, zoomReset]);

  // Clear any pending zoom-commit timer on unmount.
  useEffect(() => () => { if (zoomCommitTimerRef.current != null) window.clearTimeout(zoomCommitTimerRef.current); }, []);

  // Space-pan pointer drag (capture phase on the canvas → wins over the sheet's selection handlers, so a
  // pan never marquees/selects). Scroll is mutated directly on the container each move (no React render).
  const onPanPointerDown = useCallback((e: React.PointerEvent) => {
    if (!panModeRef.current || e.button !== 0) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    e.preventDefault();
    e.stopPropagation(); // keep the selection model / background-clear from firing under a pan
    panningRef.current = true;
    panLastRef.current = { x: e.clientX, y: e.clientY };
    try { canvas.setPointerCapture(e.pointerId); } catch { /* jsdom / unsupported */ }
    setPanning(true);
  }, []);
  const onPanPointerMove = useCallback((e: React.PointerEvent) => {
    if (!panningRef.current) return;
    e.stopPropagation();
    const canvas = canvasRef.current;
    const last = panLastRef.current;
    if (!canvas || !last) return;
    const next = panBy({ scrollLeft: canvas.scrollLeft, scrollTop: canvas.scrollTop }, e.clientX - last.x, e.clientY - last.y);
    panLastRef.current = { x: e.clientX, y: e.clientY };
    canvas.scrollLeft = next.scrollLeft;
    canvas.scrollTop = next.scrollTop;
  }, []);
  const onPanPointerUp = useCallback((e: React.PointerEvent) => {
    if (!panningRef.current) return;
    e.stopPropagation();
    panningRef.current = false;
    panLastRef.current = null;
    try { canvasRef.current?.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    setPanning(false);
  }, []);

  // A wasm trap poisons the engine instance; the adapter recovers it (reopen). Surface a toast + force a
  // page re-fetch (the recovered doc lost the last edit). Returns whether it handled a trap.
  const onTrap = useCallback(
    (e: unknown, msg: string): boolean => {
      if (String(e).includes("wasm_trap")) {
        toast(msg);
        bumpRefresh();
        return true;
      }
      return false;
    },
    [toast, bumpRefresh],
  );

  // Esc anywhere clears the whole selection + any in-progress marquee (issue 021).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") core.selection.clear();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [core]);

  // A selection-model adapter query trapped (hit-test / marquee) → recover + toast.
  useEffect(() => core.selection.onError((e) => onTrap(e, "엔진을 복구했습니다 — 다시 시도하세요")), [core, onTrap]);

  // Open the document whenever the bytes reference changes (delegated to the core session).
  useEffect(() => {
    let cancelled = false;
    if (!props.document) {
      core.session.close();
      return;
    }
    (async () => {
      try {
        const r = await core.session.open(props.document!.bytes, props.document!.name);
        if (cancelled) return;
        core.selection.clear();
        toast(`열림: ${props.document!.name ?? "문서"} · ${r.pages}쪽`);
      } catch (e) {
        if (!cancelled) toast(`열기 실패: ${e}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [core, props.document, toast]);

  // Apply a font to EVERYTHING (issue 022): the core registers it into the engine (metrics + PDF) and
  // re-paginates + invalidates layout; here we build the screen @font-face (blob URL of the SAME bytes →
  // screen == PDF). Shared by the auto-registered defaultFont and the FontPicker.
  const applyFont = useCallback(
    async (family: string, bytes: Uint8Array) => {
      try {
        await core.session.registerFont(family, bytes);
      } catch (e) {
        const code = (e as { code?: string })?.code;
        if (code === "ttc_unsupported") toast("TTC(글꼴 컬렉션)는 지원하지 않습니다 — 단일 TTF/OTF 폰트를 선택하세요");
        else toast(`글꼴 적용 실패: ${e}`);
        return;
      }
      // Copy into a fresh ArrayBuffer so the Blob part is a concrete ArrayBuffer (not a possibly-shared
      // view) — same pattern as the download() helper.
      const buf = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(buf).set(bytes);
      const url = URL.createObjectURL(new Blob([buf], { type: "font/ttf" }));
      setSelectedFont((prev) => {
        if (prev) URL.revokeObjectURL(prev.url);
        return { family, url };
      });
      toast(`글꼴 적용: ${family}`);
    },
    [core, toast],
  );

  // Auto-register the default font once per opened document (issue 022 §5): the PDF button is usable
  // immediately and the screen matches. Guarded by a ref keyed on the document bytes so it runs once.
  useEffect(() => {
    if (!meta || !props.defaultFont || !props.document) return;
    if (defaultFontAppliedFor.current === props.document.bytes) return;
    defaultFontAppliedFor.current = props.document.bytes;
    void applyFont(props.defaultFont.family, props.defaultFont.bytes);
  }, [meta, props.defaultFont, props.document, applyFont]);

  // Revoke the blob URL when the component unmounts (avoid leaking the object URL).
  useEffect(
    () => () => {
      setSelectedFont((prev) => {
        if (prev) URL.revokeObjectURL(prev.url);
        return null;
      });
    },
    [],
  );

  const canEdit = !!meta?.editable;

  // The read-only doc context handed to the host AI callback (doc meta + the live marked anchors).
  const docContext: DocContext = core.edit.docContext();

  // ── issue 027 editing chrome (opt-in) ────────────────────────────────────────────────────────────
  // Resolve the single-selection edit target: for a table/cell/range add its table box + column
  // boundaries (for the resize handles) + current bold/italic (for the toolbar toggles). Non-table
  // selections carry just the box. Cleared whenever the selection isn't exactly one item.
  useEffect(() => {
    if (!editingOn) return;
    let cancelled = false;
    const sel: Selection[] = selection;
    const one = sel.length === 1 ? sel[0] : null;
    if (!one) {
      setEditTarget(null);
      return;
    }
    const { anchor, mark } = one;
    (async () => {
      const base: EditTarget = {
        page: mark.page,
        section: anchor.section,
        block: anchor.block,
        kind: mark.kind,
        box: mark.box,
        rows: anchor.rows,
        cols: anchor.cols,
        text: anchor.text ?? "",
        curBold: false,
        curItalic: false,
      };
      if (mark.kind === "table" || mark.kind === "cell" || mark.kind === "range") {
        const cx = mark.box.x + mark.box.w / 2;
        const cy = mark.box.y + mark.box.h / 2;
        try {
          const [tableBox, boundaries, rowBoundaries, runs] = await Promise.all([
            adapter.tableAt(mark.page, cx, cy),
            core.session.colBoundaries(mark.page, anchor.section, anchor.block),
            core.session.rowBoundaries(mark.page, anchor.section, anchor.block),
            core.session.runsAt(anchor.section, anchor.block, anchor.rows?.[0], anchor.cols?.[0]),
          ]);
          if (cancelled) return;
          const style = firstRunStyle(runs);
          setEditTarget({ ...base, tableBox: tableBox as TableBox | null, boundaries, rowBoundaries, curBold: !!style.bold, curItalic: !!style.italic });
        } catch {
          if (!cancelled) setEditTarget(base);
        }
      } else {
        setEditTarget(base);
      }
    })();
    return () => {
      cancelled = true;
    };
    // `refreshToken` is a dep so the resize geometry (col/row boundaries + table box) RE-RESOLVES after an
    // applied edit — the handles then track the NEW layout instead of floating over stale px (issue 031).
  }, [editingOn, selection, adapter, core, refreshToken]);

  // Fetch page-0 geometry for the top ruler (own-render px) whenever the doc / layout changes.
  useEffect(() => {
    if (!editingOn || !meta) {
      setPageGeom0(null);
      return;
    }
    let cancelled = false;
    core.session
      .pageGeom(0)
      .then((g) => {
        if (!cancelled) setPageGeom0(g);
      })
      .catch(() => {
        if (!cancelled) setPageGeom0(null);
      });
    return () => {
      cancelled = true;
    };
  }, [editingOn, meta, refreshToken, core]);

  // Close the editor when the layout re-flows (an applied edit) so it never floats over stale geometry.
  // EXCEPTION (issue 036): a Tab commit-move re-flows too, but it re-opens the editor at the NEXT cell
  // itself — so skip the close while `tabMoving` is set, or it would clobber that re-entry.
  useEffect(() => {
    if (tabMovingRef.current) return;
    setEditor(null);
  }, [refreshToken]);

  const onInsertTable = useCallback(
    async (rows: number, cols: number) => {
      try {
        await core.edit.insertTable(rows, cols);
        toast(`${rows}×${cols} 표를 문서 끝에 추가했습니다`);
      } catch (e) {
        if (!onTrap(e, "엔진 트랩 — 문서를 복구했습니다")) toast(`표 추가 실패: ${e}`);
      }
    },
    [core, toast, onTrap],
  );

  // 열 너비 커밋 (issue 031): apply SetTableColWidths, then RE-QUERY the boundaries and confirm the
  // dragged edge actually MOVED (apply-verify). A no-op apply (frozen engine / ratio collapse) → error
  // toast, never the old FALSE success. The px→ratio conversion stays in the core (single point).
  const onColCommit = useCallback(
    async (newBoundaries: number[]) => {
      if (!editTarget || !editTarget.boundaries) return;
      const before = editTarget.boundaries;
      try {
        await core.edit.setColumnWidths(editTarget.section, editTarget.block, boundariesToRatios(newBoundaries));
        const after = await core.session.colBoundaries(editTarget.page, editTarget.section, editTarget.block);
        if (after && !appliedReflectsDrag(before, newBoundaries, after)) {
          toast("열 너비 변경이 반영되지 않았습니다 — 다시 시도하세요");
          return;
        }
        toast("열 너비를 변경했습니다");
      } catch (e) {
        if (!onTrap(e, "엔진 트랩 — 문서를 복구했습니다")) toast(`열 너비 변경 실패: ${e}`);
      }
    },
    [core, editTarget, toast, onTrap],
  );

  // 행 높이 커밋 (issue 031): remap the dragged FRAGMENT boundaries to a WHOLE-table HWPUNIT `heights`
  // vector (rows outside the on-page fragment stay 0 = content-sized — the v2 split-table fix), apply
  // SetTableRowHeights, then RE-QUERY + verify the dragged edge moved (apply-verify — false-success 차단).
  const onRowCommit = useCallback(
    async (newBoundaries: number[]) => {
      if (!editTarget || !editTarget.rowBoundaries || !editTarget.tableBox) return;
      const before = editTarget.rowBoundaries;
      const { first_row, rows } = editTarget.tableBox;
      const heights = remapFragmentHeights(newBoundaries, first_row, rows);
      try {
        await core.edit.setRowHeights(editTarget.section, editTarget.block, heights);
        const after = await core.session.rowBoundaries(editTarget.page, editTarget.section, editTarget.block);
        if (after && !appliedReflectsDrag(before, newBoundaries, after)) {
          toast("행 높이 변경이 반영되지 않았습니다 — 다시 시도하세요");
          return;
        }
        toast("행 높이를 변경했습니다");
      } catch (e) {
        if (!onTrap(e, "엔진 트랩 — 문서를 복구했습니다")) toast(`행 높이 변경 실패: ${e}`);
      }
    },
    [core, editTarget, toast, onTrap],
  );

  const onMarginsCommit = useCallback(
    async (mm: { left: number; right: number; top: number; bottom: number }) => {
      // SetPageMargins is DOCUMENT-WIDE (all pages) — confirm before applying (issue 027 §함정).
      const ok = window.confirm(
        `문서 전체의 페이지 여백을 바꿉니다 (모든 페이지에 적용):\n` +
          `좌 ${mm.left}mm · 우 ${mm.right}mm · 상 ${mm.top}mm · 하 ${mm.bottom}mm\n\n계속할까요?`,
      );
      if (!ok) return;
      try {
        await core.edit.setPageMargins(0, mm);
        toast("페이지 여백을 변경했습니다 (문서 전체)");
      } catch (e) {
        if (!onTrap(e, "엔진 트랩 — 문서를 복구했습니다")) toast(`여백 변경 실패: ${e}`);
      }
    },
    [core, toast, onTrap],
  );

  // Open the in-place text editor for the point `c` by resolving the hit DIRECTLY (cell → paragraph). Used
  // by the double-click detector below. Race-free: it re-hit-tests the (x,y) rather than reading the
  // async selection. It ALSO reads the target's FIRST-run size (issue 032: the editor renders at the
  // cell's own font size) via the SAME 027 runs path (`runsAt` → `firstRunStyle`) that preserves style.
  const openEditorAt = useCallback(
    async (c: PageClick) => {
      try {
        const cell = adapter.tableCellAt ? await adapter.tableCellAt(c.page, c.x, c.y) : null;
        if (cell) {
          const runs = await core.session.runsAt(cell.section, cell.block, cell.row, cell.col);
          setEditor({ page: c.page, box: { x: cell.x, y: cell.y, w: cell.w, h: cell.h }, section: cell.section, block: cell.block, kind: "cell", rows: [cell.row, cell.row], cols: [cell.col, cell.col], text: cell.text, runs, fontSizePt: firstRunStyle(runs).size_pt });
          return;
        }
        if (await adapter.tableAt(c.page, c.x, c.y)) return; // on a table border but not a cell → no editor
        const hit = await adapter.hitTest(c.page, c.x, c.y);
        if (hit && hit.kind === "paragraph" && hit.editable) {
          const runs = await core.session.runsAt(hit.section, hit.block);
          setEditor({ page: c.page, box: { x: hit.x, y: hit.y, w: hit.w, h: hit.h }, section: hit.section, block: hit.block, kind: "paragraph", text: hit.text, runs, fontSizePt: firstRunStyle(runs).size_pt });
        }
      } catch (e) {
        onTrap(e, "엔진을 복구했습니다 — 다시 시도하세요");
      }
    },
    [adapter, core, onTrap],
  );

  // Open the in-place editor directly over a SELECTED cell (issue 036 Enter/Tab entry). Unlike
  // `openEditorAt` (which re-hit-tests a click point) this reads the cell address + rect straight off the
  // selection, then reads the FIRST-run size (027 runs path) so the editor renders at the cell's own size.
  const openCellEditor = useCallback(
    async (sel: Selection): Promise<void> => {
      const { anchor, mark } = sel;
      if (anchor.kind !== "cell") return;
      const row = anchor.rows?.[0] ?? 0;
      const col = anchor.cols?.[0] ?? 0;
      try {
        const runs = await core.session.runsAt(anchor.section, anchor.block, row, col);
        setEditor({ page: mark.page, box: mark.box, section: anchor.section, block: anchor.block, kind: "cell", rows: [row, row], cols: [col, col], text: anchor.text ?? "", runs, fontSizePt: firstRunStyle(runs).size_pt });
      } catch (e) {
        onTrap(e, "엔진을 복구했습니다 — 다시 시도하세요");
      }
    },
    [core, onTrap],
  );

  // Minimal scrollIntoView for a cell rect (own-render PAGE px on `page`): scroll the canvas ONLY enough to
  // bring the cell inside the viewport (with a small margin), like a spreadsheet's scroll-on-nav. The
  // page-px → client-px scale is read from the sheet's own SVG (rendered width / viewBox width).
  const scrollCellIntoView = useCallback((page: number, box: Box) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const sheet = canvas.querySelector(`.hw-sheet[data-page="${page}"]`);
    const svg = sheet?.querySelector("svg") as SVGSVGElement | null;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const vbW = svg.viewBox?.baseVal?.width || rect.width;
    const scale = vbW > 0 ? rect.width / vbW : 1;
    const cRect = canvas.getBoundingClientRect();
    const M = 24; // keep a little breathing room around the target cell
    const cellTop = rect.top + box.y * scale;
    const cellBottom = rect.top + (box.y + box.h) * scale;
    const cellLeft = rect.left + box.x * scale;
    const cellRight = rect.left + (box.x + box.w) * scale;
    let dTop = 0;
    if (cellTop < cRect.top + M) dTop = cellTop - (cRect.top + M);
    else if (cellBottom > cRect.bottom - M) dTop = cellBottom - (cRect.bottom - M);
    let dLeft = 0;
    if (cellLeft < cRect.left + M) dLeft = cellLeft - (cRect.left + M);
    else if (cellRight > cRect.right - M) dLeft = cellRight - (cRect.right - M);
    if (dTop) canvas.scrollTop += dTop;
    if (dLeft) canvas.scrollLeft += dLeft;
  }, []);

  // Arrow-key nav: move the active cell one step (core owns the geometry), then scroll it into view.
  const moveCellAndScroll = useCallback(
    async (dir: CellDir): Promise<boolean> => {
      const moved = await core.selection.moveCell(dir);
      if (moved) {
        const sel = core.selection.activeCell();
        if (sel) scrollCellIntoView(sel.mark.page, sel.mark.box);
      }
      return moved;
    },
    [core, scrollCellIntoView],
  );

  // ── Issue 045: 찾기/바꾸기 verbs ─────────────────────────────────────────────────────────────────────
  // Scroll the CURRENT match into view — reuses the generalized 036 scrollCellIntoView (page, box); the
  // match box is already own-render PAGE px, so it scrolls exactly like a cell nav.
  const scrollToMatch = useCallback(
    (boxes: (MatchBox | null)[], cursor: number) => {
      const mb = cursor >= 0 ? boxes[cursor] : null;
      if (mb) scrollCellIntoView(mb.page, mb.box);
    },
    [scrollCellIntoView],
  );

  // Serialize a find engine op onto the single chain (no concurrent FindController mutation).
  const enqueueFind = useCallback((fn: () => Promise<void>): Promise<void> => {
    const next = findChainRef.current.then(fn, fn);
    findChainRef.current = next.catch(() => {});
    return next;
  }, []);

  // Run a fresh search for the current query: search → resolve match boxes (caretRect) → surface count +
  // (optionally) scroll to the first hit. Serialized so it can't interleave with a post-edit re-find. The
  // empty-query / no-doc / no-match paths clear cleanly.
  const runFind = useCallback(
    (scrollToFirst: boolean): Promise<void> =>
      enqueueFind(async () => {
        const q = findQueryRef.current;
        if (!q) {
          core.find.clear();
          setFindCount(null);
          setFindOrdinal(0);
          setFindBoxes([]);
          return;
        }
        setFindBusy(true);
        try {
          await core.find.search(q, { caseSensitive: findCaseRef.current });
          const boxes = await core.find.locateAll(core.session.pages);
          setFindBoxes(boxes);
          setFindCount(core.find.count);
          setFindOrdinal(core.find.ordinal);
          if (scrollToFirst) scrollToMatch(boxes, core.find.cursor);
        } catch (e) {
          if (!onTrap(e, "엔진을 복구했습니다 — 다시 시도하세요")) toast(`찾기 실패: ${e}`);
        } finally {
          setFindBusy(false);
        }
      }),
    [core, onTrap, toast, scrollToMatch, enqueueFind],
  );

  // Next / previous match: advance the FindController cursor, reflect the ordinal, scroll the new current
  // match into view (minimal scroll — 스크롤-투-매치).
  const findStep = useCallback(
    (dir: "next" | "prev") => {
      if (dir === "next") core.find.next();
      else core.find.prev();
      setFindOrdinal(core.find.ordinal);
      scrollToMatch(findBoxesRef.current, core.find.cursor);
    },
    [core, scrollToMatch],
  );

  // Replace the first match / every match as ONE undo unit. The replace records an undo batch + re-flows
  // the doc (recordExternalEdit → refreshToken bump), and the refreshToken effect below re-finds + re-
  // locates the (now shifted) matches. Undo is the workspace ↶ button (one undo reverts a 모두 바꾸기).
  const runReplace = useCallback(
    (all: boolean): Promise<void> =>
      enqueueFind(async () => {
        if (!canEdit || !findQueryRef.current) return;
        setFindBusy(true);
        try {
          const res = all ? await core.find.replaceAll(findReplaceRef.current) : await core.find.replaceCurrent(findReplaceRef.current);
          if (res.replaced > 0) toast(`${res.replaced}개 바꿈 — 실행취소는 ↶`);
          else toast("바꿀 내용을 찾지 못했습니다");
        } catch (e) {
          if (!onTrap(e, "엔진 트랩 — 문서를 복구했습니다")) toast(`바꾸기 실패: ${e}`);
        } finally {
          setFindBusy(false);
        }
      }),
    [core, canEdit, onTrap, toast, enqueueFind],
  );

  // ⌘F opens the bar (or re-focuses it if already open, via the focus token). Decision (issue 045 §함정 —
  // 제자리 에디터 열림 중 동작): when the in-place editor is OPEN we IGNORE ⌘F (no close) so an uncommitted
  // edit is never silently discarded (규율 6 — 콘텐츠 삭제 금지); the user Esc's out first. Otherwise the
  // isEditableTarget guard is deliberately NOT applied (⌘F must work even from a text field — the norm).
  const openFind = useCallback(() => {
    if (editorRef.current) return; // in-place editor open → let the user finish/cancel first
    setFindOpen(true);
    setFindFocusToken((t) => t + 1);
  }, []);

  const closeFind = useCallback(() => {
    setFindOpen(false);
    core.find.clear();
    setFindCount(null);
    setFindOrdinal(0);
    setFindBoxes([]);
  }, [core]);

  // ⌘/Ctrl+F opens the find bar — a SEPARATE window listener that coexists with the 035 zoom/Space
  // listener and the 036 cell-nav listener (which bails on any ⌘/Ctrl combo, so it never fights this).
  // Only intercepts when a document is open (else the browser's native find still works).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && (e.key === "f" || e.key === "F")) {
        if (!metaRef.current) return; // no document → leave native browser find alone
        e.preventDefault();
        openFind();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [openFind]);

  // 함정 fix: an edit (AI apply / manual commit / our own replace) re-flows the doc, so the match char
  // offsets go stale. On every layout invalidation (refreshToken) while the bar is open with a live query,
  // re-find + re-locate WITHOUT scrolling (a background invalidation, not a user navigation). A find/next
  // is read-only (no refreshToken bump), so this never double-runs a plain search.
  useEffect(() => {
    if (!findOpenRef.current || !findQueryRef.current) return;
    let cancelled = false;
    // Serialized onto the SAME chain as runFind so a post-edit re-find never interleaves with a user search
    // (issue 045 concurrency: two search() calls would corrupt the shared match set).
    void enqueueFind(async () => {
      if (cancelled || !findOpenRef.current || !findQueryRef.current) return;
      try {
        await core.find.refresh();
        if (cancelled) return;
        const boxes = await core.find.locateAll(core.session.pages);
        if (cancelled) return;
        setFindBoxes(boxes);
        setFindCount(core.find.count);
        setFindOrdinal(core.find.ordinal);
      } catch {
        /* a transient re-find failure keeps the last results; the next search recovers */
      }
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshToken, core, enqueueFind]);

  // Issue 040: commit the editor's SERIALIZED runs run-preserving. A cell → SetTableCellRuns, a paragraph →
  // SetParagraphRuns (never a plain-text variant — 교훈 6), applied as ONE undo batch via the SAME
  // session.applyBatch path editCellText uses (page re-flow + layoutInvalidated → the refreshToken close).
  const applyEditorRuns = useCallback(
    (ed: { kind: string; section: number; block: number; rows?: [number, number]; cols?: [number, number] }, runs: RunSpec[]) => {
      const intent: Intent =
        ed.kind === "paragraph"
          ? { intent: "SetParagraphRuns", section: ed.section, block: ed.block, runs }
          : { intent: "SetTableCellRuns", section: ed.section, index: ed.block, row: ed.rows?.[0] ?? 0, col: ed.cols?.[0] ?? 0, runs };
      return core.session.applyBatch([intent]);
    },
    [core],
  );

  const onEditorCommit = useCallback(
    async (runs: RunSpec[]) => {
      if (!editor) return;
      // No-op guard (교훈 1 / 미접촉 셀 재커밋 = no-op): if nothing changed, close WITHOUT a write + undo unit.
      if (runsUnchanged(runs, editor.runs)) {
        setEditor(null);
        return;
      }
      try {
        await applyEditorRuns(editor, runs);
        toast("텍스트를 수정했습니다");
        // Success: the applied edit bumps refreshToken which ALSO closes the editor; clearing here too keeps
        // it closed even when the layout didn't reflow (a no-op re-flow).
        setEditor(null);
      } catch (e) {
        if (!onTrap(e, "엔진 트랩 — 문서를 복구했습니다")) toast(`텍스트 수정 실패: ${e}`);
        // Re-raise WITHOUT clearing `editor`: the InPlaceCellEditor un-latches on rejection and STAYS open
        // so the user can retry (issue 032 step 2: 저장 실패 시 에디터 유지 + 에러 토스트).
        throw e;
      }
    },
    [applyEditorRuns, editor, toast, onTrap],
  );

  // Tab / Shift+Tab inside a cell editor (issue 036): commit the current text, and ONLY on a successful
  // commit move one cell right/left and re-enter edit. A commit FAILURE rethrows so the InPlaceCellEditor
  // un-latches and stays open with the move CANCELLED (031 apply-verify spirit). `tabMoving` shields the
  // refreshToken close effect for the whole transition (the commit re-flows), so the re-entered editor
  // isn't clobbered; it's reset one macrotask later, AFTER React has flushed that render.
  const onEditorCommitMove = useCallback(
    async (dir: "left" | "right", runs: RunSpec[]) => {
      const ed = editorRef.current;
      if (!ed) return;
      tabMovingRef.current = true;
      try {
        // Commit run-preserving ONLY when the runs actually changed (a bare Tab through cells is a no-op —
        // no write, no undo unit); the move happens either way (issue 040 no-op guard + 036 Tab nav).
        if (!runsUnchanged(runs, ed.runs)) {
          await applyEditorRuns(ed, runs);
          toast("텍스트를 수정했습니다");
        }
        // Move + re-enter. moveCell probes from the just-committed cell's box (stable x/w for a text edit)
        // and returns the NEIGHBOUR's fresh post-edit geometry; a clamp (table edge) just closes.
        const moved = await core.selection.moveCell(dir === "right" ? "right" : "left");
        const next = moved ? core.selection.activeCell() : null;
        if (next && next.anchor.kind === "cell") {
          scrollCellIntoView(next.mark.page, next.mark.box);
          await openCellEditor(next);
        } else {
          setEditor(null);
        }
        // Release the shield only after this task's React flush (macrotask) so the refreshToken close from
        // the commit can't reopen-then-close the re-entered editor.
        window.setTimeout(() => (tabMovingRef.current = false), 0);
      } catch (e) {
        tabMovingRef.current = false; // failed commit: no re-flow to shield; editor stays open on rethrow
        if (!onTrap(e, "엔진 트랩 — 문서를 복구했습니다")) toast(`텍스트 수정 실패: ${e}`);
        throw e;
      }
    },
    [core, toast, onTrap, scrollCellIntoView, openCellEditor],
  );

  // Cell-nav keydown (issue 036), a SEPARATE window listener that coexists with the 035 zoom/Space listener
  // and the 021 Esc listener. It only acts when a SINGLE cell is selected and the focus is NOT a text-entry
  // surface (reusing the 035 `isEditableTarget` guard — no new arithmetic): 방향키 → moveCell (셀 선택이
  // 있을 때만 preventDefault, 페이지 스크롤과 경합 방지), Enter → 그 셀 제자리 편집. ⌘/Ctrl 조합은
  // 035(줌)에 양보한다. Tab/Shift+Tab 은 편집 중일 때 InPlaceCellEditor 안에서 처리된다.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return; // ⌘/Ctrl combos belong to 035 (zoom) etc.
      // A text-entry surface (in-place editor / chat composer / size input) keeps its own arrows + Enter.
      if (isEditableTarget(e.target as Element | null) || isEditableTarget(document.activeElement)) return;
      const sels = selectionRef.current;
      const single = sels.length === 1 && sels[0].anchor.kind === "cell" ? sels[0] : null;
      if (!single) return; // 비셀 선택 / 다중선택 / 무선택 → 방향키·Enter 는 문서 기본동작 유지
      const dir = ARROW_DIR[e.key];
      if (dir) {
        e.preventDefault(); // 셀 선택이 있을 때만 스크롤 기본동작을 막는다 (issue 036 §함정)
        void moveCellAndScroll(dir);
        return;
      }
      if (e.key === "Enter" && editingOn && !editorRef.current) {
        e.preventDefault();
        void openCellEditor(single);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [editingOn, moveCellAndScroll, openCellEditor]);

  // Format toolbar → SetCellRangeFmt / SetCellRangeShade over the selected cell/range.
  const runFmt = useCallback(
    async (fn: () => Promise<number>, ok: string) => {
      try {
        await fn();
        toast(ok);
      } catch (e) {
        if (!onTrap(e, "엔진 트랩 — 문서를 복구했습니다")) toast(`서식 적용 실패: ${e}`);
      }
    },
    [toast, onTrap],
  );

  // The SHARED selection-format action set (issue 039): the 028 FloatingToolbar AND the 039 context menu
  // drive these SAME handlers (중복 코드 금지) — each is a pure delegation to editor-core's
  // formatCellRange/shadeCellRange (027 core, 신규 op 0), resolved against the current single-cell/range
  // target. `runFmt` owns the apply+toast+trap-recovery, so the emitted Intents/toasts match the pre-039
  // inline handlers exactly (028 무회귀).
  const fmtActions = useSelectionActions(core, editTarget, runFmt);
  const fmtRange = fmtActions.fmtRange;

  // "AI에게 전달" (issue 028): the marked selection is ALREADY the anchor chip (anchors = selection); this
  // only bumps the token that focuses the chat composer. No new prompt logic, and the selection is NOT
  // cleared so the chips ride along with the next message (the existing captureAnchor flow).
  const onSendToAi = useCallback(() => setAiFocusToken((t) => t + 1), []);

  // 행 삽입 (issue 039): delegate to the EXISTING TableInsertRows op via editor-core (신규 op 0). The op-bus
  // refuses an out-of-range row / a non-table block, so a mistargeted insert surfaces an error toast rather
  // than a false success (031). `at == row` inserts above, `row + 1` below.
  const onInsertRows = useCallback(
    async (section: number, block: number, at: number, cols: number) => {
      try {
        await core.edit.insertRows(section, block, at, cols);
        toast("행을 삽입했습니다");
      } catch (e) {
        if (!onTrap(e, "엔진 트랩 — 문서를 복구했습니다")) toast(`행 삽입 실패: ${e}`);
      }
    },
    [core, toast, onTrap],
  );

  // 우클릭 → 컨텍스트 메뉴 (issue 039). Only over a page sheet (시트 위에서만 브라우저 기본 메뉴 차단 —
  // 채팅 패널·회색 여백·그립·제자리 에디터 위에서는 기본 메뉴 유지). The right-click point updates the
  // selection with the SAME rule as a click (023/021 replace), then the resolved hit branches the menu
  // (셀/문단/바탕). Actions always target "현재 선택" (028과 같은 계약).
  const onSheetContextMenu = useCallback(
    async (e: React.MouseEvent) => {
      if (!editingOn) return; // read-only host → native menu (the editing chrome is opt-in)
      if (editorRef.current) return; // in-place text editor open → keep the native text menu
      const target = e.target as Element | null;
      const sheet = target?.closest?.(".hw-sheet") as HTMLElement | null;
      if (!sheet || sheet.dataset.page == null) return; // off a page → native menu (§함정)
      const svg = sheet.querySelector("svg") as SVGSVGElement | null;
      if (!svg) return; // a virtualized placeholder has no SVG → native menu
      e.preventDefault(); // 시트 위에서만 기본 메뉴 차단
      const page = Number(sheet.dataset.page);
      const rect = svg.getBoundingClientRect();
      const pt = screenToPage(e.clientX, e.clientY, rect, readViewBox(svg));
      if (!pt) return;
      const clientX = e.clientX;
      const clientY = e.clientY;
      const click: PageClick = { page, x: pt.x, y: pt.y, meta: false, client: { x: clientX, y: clientY } };
      // 1) Update the selection exactly like a click here (so the marks show + actions target this spot).
      try {
        await core.selection.pointerDown(toPointerInput(click));
        await core.selection.pointerUp(toPointerInput(click));
      } catch (err) {
        onTrap(err, "엔진을 복구했습니다 — 다시 시도하세요");
      }
      // 2) Resolve what's under the point to branch the menu (cell > table/paragraph > 바탕).
      try {
        const cell = adapter.tableCellAt ? await adapter.tableCellAt(page, pt.x, pt.y) : null;
        if (cell) {
          setContextMenu({ x: clientX, y: clientY, kind: "cell", click, cell: { section: cell.section, block: cell.block, row: cell.row, cols: cell.cols } });
          return;
        }
        const table = await adapter.tableAt(page, pt.x, pt.y);
        const hit = table ? null : await adapter.hitTest(page, pt.x, pt.y);
        const strictInside = !!hit && pt.x >= hit.x && pt.x <= hit.x + hit.w && pt.y >= hit.y && pt.y <= hit.y + hit.h;
        if (hit && hit.kind === "paragraph" && hit.editable && strictInside) {
          setContextMenu({ x: clientX, y: clientY, kind: "paragraph", click });
          return;
        }
        // A whole-table border / image / empty page area → 바탕(비개체) menu (표 추가).
        setContextMenu({ x: clientX, y: clientY, kind: "background", click });
      } catch (err) {
        if (!onTrap(err, "엔진을 복구했습니다 — 다시 시도하세요")) setContextMenu({ x: clientX, y: clientY, kind: "background", click });
      }
    },
    [editingOn, adapter, core, onTrap],
  );

  // The 서체 catalog family names for the toolbar's font dropdown (reuses the existing fontCatalog prop);
  // falls back to just the currently-applied face when no catalog is supplied.
  const fontFamilies = useMemo<readonly string[] | undefined>(() => {
    if (props.fontCatalog && props.fontCatalog.length > 0) return props.fontCatalog.map((f) => f.family);
    return selectedFont ? [selectedFont.family] : undefined;
  }, [props.fontCatalog, selectedFont]);

  // The page the floating toolbar anchors to = the FIRST mark's page (multi-page selection → first mark's
  // page, per the issue). Its format controls stay enabled only for a single cell/range target (027 scope);
  // any other combination is disabled with a Korean reason tooltip (never a silent no-op).
  const toolbarPage = marks.length ? marks[0].page : null;
  const formatDisabledReason: string | undefined = !editTarget
    ? "여러 곳을 함께 선택하면 서식은 한 번에 적용할 수 없습니다 — 표의 한 셀/범위를 선택하세요"
    : editTarget.kind === "cell" || editTarget.kind === "range"
      ? fmtRange
        ? undefined
        : "이 셀에는 서식을 적용할 수 없습니다"
      : "표 셀/범위를 선택하면 서식을 적용할 수 있습니다";

  // pointer lifecycle → the core selection model (issues 021/023). React fires them fire-and-forget; the
  // core emits selection/marquee changes that useHwpEditor mirrors back into state.
  const onPointerDown = useCallback(
    (c: PageClick) => {
      setPointerActive(true); // a gesture began → hide the floating toolbar until it settles (028)
      void core.selection.pointerDown(toPointerInput(c));
    },
    [core],
  );
  const onPointerMove = useCallback((c: PageClick) => core.selection.pointerMove(toPointerInput(c)), [core]);
  const onPointerUp = useCallback(
    (c: PageClick) => {
      setPointerActive(false); // gesture ended → the toolbar re-appears once the new selection resolves
      void core.selection.pointerUp(toPointerInput(c));
      if (!editingOn) return;
      // Detect a double-click (two ups within 400ms, ~same client point) → open the in-place editor.
      const now = Date.now();
      const prev = lastUpRef.current;
      if (prev && now - prev.t < 400 && Math.hypot(c.client.x - prev.x, c.client.y - prev.y) < 6) {
        lastUpRef.current = null;
        void openEditorAt(c);
      } else {
        lastUpRef.current = { t: now, x: c.client.x, y: c.client.y };
      }
    },
    [core, editingOn, openEditorAt],
  );

  // ── issue 038: hover pre-highlight + cursor system (FG-09 + FG-06) ────────────────────────────────
  // Hover rides the WORKSPACE's own pointer surface (the zoom layer), never HwpPageView (037-owned): a
  // hover move bubbles to `hover.onPointerMove`, which rAF-throttles + dedups + hit-tests via the adapter
  // and pushes the result into `hover.store` that HoverLayer draws by ref (0 workspace/sheet renders,
  // mirroring 030). Suppressed during a drag/marquee, Space-pan, an open in-place editor, or over a 031
  // resize grip; the cursor is written straight to `.hw-canvas[data-hover-cursor]` (a DOM write, no render).
  // issue 039: an OPEN context menu joins the 038 suppression gate — no pre-highlight/cursor churn while
  // the menu owns the interaction (the menu is the active surface until it closes).
  const hoverSuppressed = panMode || panning || editor != null || pointerActive || contextMenu != null;
  const hover = useHover({
    adapter,
    editingOn,
    cursorHostRef: canvasRef,
    panModeRef,
    panningRef,
    editorOpenRef,
    suppressed: hoverSuppressed,
  });

  const onApply = useCallback(
    async (intents: Intent[]): Promise<number> => {
      try {
        const applied = await core.edit.apply(intents);
        toast(`적용됨: ${applied}개 편집`);
        return applied;
      } catch (e) {
        if (!onTrap(e, "엔진 트랩 — 문서를 복구했습니다. 마지막 편집은 취소되었습니다")) {
          /* non-trap error: surfaced by the chat panel's own catch */
        }
        throw e;
      }
    },
    [core, toast, onTrap],
  );

  const undo = useCallback(async () => {
    if (await core.session.undo()) toast("실행취소");
  }, [core, toast]);

  const redo = useCallback(async () => {
    if (await core.session.redo()) toast("다시 실행");
  }, [core, toast]);

  const download = (bytes: Uint8Array | string, name: string, mime: string) => {
    // Copy into a fresh ArrayBuffer so the Blob part is a plain ArrayBuffer (not a wasm memory view).
    const part =
      typeof bytes === "string" ? bytes : (() => { const c = new Uint8Array(bytes.length); c.set(bytes); return c; })();
    const a = window.document.createElement("a");
    a.href = URL.createObjectURL(new Blob([part], { type: mime }));
    a.download = name;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  };

  const exportHtml = useCallback(async () => {
    try {
      const html = await adapter.exportHtml();
      const name = `${props.document?.name ?? "document"}.html`;
      // Issue 044: a host `onExport` (desktop) replaces the browser download; omitted (web) = unchanged.
      if (props.onExport) await props.onExport(html, name, "text/html");
      else download(html, name, "text/html");
    } catch (e) {
      toast(`HTML 내보내기 실패: ${e}`);
    }
  }, [adapter, props.document, props.onExport, toast]);

  const exportPdf = useCallback(async () => {
    try {
      if (!adapter.hasFont()) {
        if (props.requestFont) {
          const f = await props.requestFont();
          if (!f) return;
          await adapter.registerFont(f.family, f.bytes);
        } else {
          toast("PDF를 내보내려면 폰트를 먼저 주입하세요 (registerFont) — 한컴/함초롬 폰트는 번들되지 않습니다");
          return;
        }
      }
      const pdf = await adapter.exportPdf();
      const name = `${props.document?.name ?? "document"}.pdf`;
      // Issue 044: a host `onExport` (desktop) replaces the browser download; omitted (web) = unchanged.
      if (props.onExport) await props.onExport(pdf, name, "application/pdf");
      else download(pdf, name, "application/pdf");
    } catch (e) {
      const code = (e as { code?: string })?.code;
      if (code === "font_missing") toast("폰트가 주입되지 않았습니다 — .ttf/.otf 파일을 선택하세요");
      else toast(`PDF 내보내기 실패: ${e}`);
    }
  }, [adapter, props.requestFont, props.document, props.onExport, toast]);

  const jumpToPage = useCallback((page: number) => {
    const el = window.document.querySelector(`.hw-sheet[data-page="${page}"]`);
    el?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  }, []);

  // ── issue 046: fetch the document outline (engine headings) whenever the doc / layout changes ─────────
  // Read-only query (no undo unit) through the SAME facade both backends share (`session.outline` →
  // `adapter.outline?`), so the web and the new-shell desktop get identical headings. A backend that omits
  // `outline` (or a doc with none) yields `[]` → the panel shows the page-list fallback (§함정 빈 패널 금지).
  useEffect(() => {
    if (!meta) {
      setOutline([]);
      return;
    }
    let cancelled = false;
    core.session
      .outline()
      .then((items) => {
        if (!cancelled) setOutline(items);
      })
      .catch(() => {
        if (!cancelled) setOutline([]);
      });
    return () => {
      cancelled = true;
    };
  }, [meta, refreshToken, core]);

  // ── issue 046: current-page tracking = a SCROLL-POSITION calc (NOT the 037 visible set — §함정) ───────
  // A rAF-throttled scroll listener reads each page WRAPPER's top (every page has an exact-height wrapper,
  // real sheet or virtualization placeholder) and picks the last one at/above a reference line near the
  // viewport top (pure `pageAtReference`). This drives BOTH the outline highlight and the status-bar page,
  // and is correct even while pages are virtualized. It writes only `currentPage` (a cheap scalar) and
  // dedups, so a scroll never churns the heavy sheets (030 discipline).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !meta) {
      setCurrentPage(0);
      return;
    }
    let raf = 0;
    const compute = () => {
      raf = 0;
      const cRect = canvas.getBoundingClientRect();
      const wraps = canvas.querySelectorAll<HTMLElement>(".hw-sheet-wrap[data-page]");
      if (wraps.length === 0) return;
      const rows = Array.from(wraps, (w) => ({ page: Number(w.dataset.page), top: w.getBoundingClientRect().top - cRect.top }));
      const ref = cRect.height * 0.3; // a reference line ~30% down from the viewport top
      const p = pageAtReference(rows, ref);
      setCurrentPage((prev) => (prev === p ? prev : p));
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(compute);
    };
    compute(); // seed immediately (before the first scroll)
    canvas.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      canvas.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [meta, refreshToken, zoom]);

  // Toggle + persist the outline panel's collapsed state (issue 046: 접기 상태 기억, localStorage).
  const toggleOutlineCollapse = useCallback(() => {
    setOutlineCollapsed((c) => {
      const next = !c;
      writeOutlineCollapsed(next);
      return next;
    });
  }, []);

  // The status-bar selection summary reuses the ANCHOR label (no new arithmetic): a single selection shows
  // its label ("3행 2열" / 문단 …); a multi-selection shows the count. Null when nothing is selected.
  const selectionSummary = useMemo<string | null>(() => {
    if (selection.length === 0) return null;
    if (selection.length === 1) return selection[0].anchor.label;
    return `${selection.length}개 선택`;
  }, [selection]);

  return (
    <div className={`hw-workspace ${props.className ?? ""}`}>
      {/* Screen font-face + alias (issue 022 §3): map every document font name to the selected face so
          the SVG on screen matches the exported PDF. Injected only when a font is selected. */}
      {selectedFont && <style data-testid="hw-fontface">{buildFontFaceCss(selectedFont.family, selectedFont.url)}</style>}
      <div className="hw-toolbar">
        <span className="hw-brand">tf-hwp</span>
        <span className="hw-doc-meta">{meta ? `${meta.format.toUpperCase()} · ${meta.pages}쪽` : "문서 없음"}</span>
        <span className="hw-spacer" />
        <button className="hw-tool" onClick={() => zoomAtCenter(1 / ZOOM_STEP)} title="축소 (⌘−)" disabled={!meta}>
          －
        </button>
        <button className="hw-zoom" onClick={zoomReset} title="100% (⌘0)" disabled={!meta}>
          {Math.round(zoom * 100)}%
        </button>
        <button className="hw-tool" onClick={() => zoomAtCenter(ZOOM_STEP)} title="확대 (⌘+)" disabled={!meta}>
          ＋
        </button>
        <button className="hw-tool" onClick={undo} disabled={!meta} title="실행취소">
          ↶
        </button>
        <button className="hw-tool" onClick={redo} disabled={!meta} title="다시 실행">
          ↷
        </button>
        {editingOn && <TableInsertButton disabled={!canEdit} onPick={(r, c) => void onInsertTable(r, c)} />}
        {props.fontCatalog && (
          <FontPicker
            catalog={props.fontCatalog}
            selected={selectedFont?.family ?? null}
            urlBase={props.fontUrlBase}
            disabled={!meta}
            onPick={({ family, bytes }) => void applyFont(family, bytes)}
            onError={(m) => toast(m)}
          />
        )}
        <button className="hw-tool" onClick={exportHtml} disabled={!meta} title="HTML 다운로드">
          HTML
        </button>
        <button className="hw-tool hw-tool-accent" onClick={exportPdf} disabled={!meta} title="PDF 다운로드">
          PDF
        </button>
      </div>

      {/* issue 045: the ⌘F 찾기/바꾸기 capsule — a top-right overlay over the document (keyboard-effect +
          top-area surface; it never touches the 046 sidebar/status-bar containers). Rendered only when a
          document is open AND the bar is toggled on (⌘F). */}
      {meta && findOpen && (
        <FindBar
          query={findQuery}
          replaceValue={findReplace}
          caseSensitive={findCase}
          count={findCount}
          ordinal={findOrdinal}
          busy={findBusy}
          supported={core.find.supported}
          canReplace={canEdit}
          canLocate={core.find.canLocate}
          focusToken={findFocusToken}
          onQueryChange={(v) => {
            setFindQuery(v);
            // Typing invalidates the current results (hide the "n/m" until the next search) — desktop parity.
            core.find.clear();
            setFindCount(null);
            setFindOrdinal(0);
            setFindBoxes([]);
          }}
          onReplaceChange={setFindReplace}
          onCaseToggle={(v) => {
            setFindCase(v);
            core.find.clear();
            setFindCount(null);
            setFindOrdinal(0);
            setFindBoxes([]);
          }}
          onSearch={() => void runFind(true)}
          onNext={() => findStep("next")}
          onPrev={() => findStep("prev")}
          onReplaceOne={() => void runReplace(false)}
          onReplaceAll={() => void runReplace(true)}
          onClose={closeFind}
        />
      )}

      <div className="hw-body">
        {/* issue 046: the left, collapsible outline nav. Only the hw-body LEFT slot (045 owns keydown /
            top bar). Clicking an item reuses `jumpToPage` (the EXISTING scroll source — 035 줌 정합), and
            the current-page highlight rides the scroll-position `currentPage` (037 무관). */}
        {meta && (
          <OutlinePanel
            items={outline}
            pageCount={meta.pages}
            currentPage={currentPage}
            collapsed={outlineCollapsed}
            onToggleCollapse={toggleOutlineCollapse}
            onJump={jumpToPage}
          />
        )}
        <div
          ref={canvasRef}
          className={`hw-canvas${panMode ? " hw-pan" : ""}${panning ? " hw-panning" : ""}`}
          // issue 035: Space-pan drag is captured here (capture phase) so it wins over the sheet's
          // selection handlers — a pan never marquees or selects. No-ops unless panMode is on.
          onPointerDownCapture={onPanPointerDown}
          onPointerMoveCapture={onPanPointerMove}
          onPointerUpCapture={onPanPointerUp}
          onPointerDown={(e) => {
            // A press on the gray canvas background (outside every page sheet) clears the selection.
            if (!(e.target as HTMLElement).closest(".hw-sheet")) clearSelection();
          }}
          // issue 039: right-click → context menu (only on a page sheet; §함정 시트 위에서만 기본 메뉴 차단).
          onContextMenu={(e) => void onSheetContextMenu(e)}
        >
          {meta ? (
            <>
              {/* 상단 룰러 (issue 027 step 3): 페이지 폭·좌우 여백 표시 + (편집 모드) 여백 드래그.
                  issue 035: the ruler is OUTSIDE the zoom-transform layer on purpose — its height is fixed
                  (it does not scale with zoom), so keeping it out of the transform makes the cursor-anchored
                  vertical fixed point hold exactly (the ruler height cancels out of the pages layer's top). */}
              {editingOn && pageGeom0 && (
                <div className="hw-ruler-wrap" style={{ width: A4_W * zoom }}>
                  <Ruler geom={pageGeom0} scale={(A4_W * zoom) / pageGeom0.w} onCommitMargins={canEdit ? onMarginsCommit : undefined} />
                </div>
              )}
              {/* issue 035: the zoom TRANSFORM layer wraps ONLY the pages — continuous ⌘/pinch zoom scales
                  this via a direct style mutation (0 React renders) until the debounced commit re-lays-out
                  the sheets at the real scale. */}
              {/* issue 038: the hover pointer surface. Hover moves bubble here (never into HwpPageView,
                  037-owned); onPointerLeave clears the highlight when the pointer leaves the pages. */}
              <div className="hw-zoom-layer" ref={zoomLayerRef} onPointerMove={hover.onPointerMove} onPointerLeave={hover.onPointerLeave}>
              <HwpPageView
                adapter={adapter}
                pageCount={meta.pages}
                zoom={zoom}
                refreshToken={refreshToken}
                onPagePointerDown={onPointerDown}
                onPagePointerMove={onPointerMove}
                onPagePointerUp={onPointerUp}
                renderOverlay={(page, scale) => (
                  <>
                    {/* issue 038: the hover pre-highlight sits UNDER the selection marks (rendered first) and
                        is pointer-events:none, so it never interferes with clicks/marks — it only points. */}
                    <HoverLayer store={hover.store} page={page} scale={scale} />
                    <SelectionOverlay marks={marks} page={page} scale={scale} />
                    {/* issue 045: the 찾기 match highlight (current 강조 / rest 옅게), visually distinct from
                        the selection marks. pointer-events:none — purely visual, like the selection overlay. */}
                    {findOpen && <FindMatchOverlay boxes={findBoxes} current={core.find.cursor} page={page} scale={scale} />}
                    {/* issue 030: the marquee is an ISOLATED layer — it subscribes to the core itself, so a
                        drag re-renders neither this workspace nor the SVG sheets (only the rect moves). */}
                    <MarqueeLayer core={core} page={page} scale={scale} />
                    {editingOn && editTarget && editTarget.page === page && editTarget.boundaries && editTarget.tableBox && (
                      <ColumnResizeOverlay
                        boundaries={editTarget.boundaries}
                        top={editTarget.tableBox.y}
                        height={editTarget.tableBox.h}
                        scale={scale}
                        onCommit={(b) => void onColCommit(b)}
                      />
                    )}
                    {editingOn && editTarget && editTarget.page === page && editTarget.rowBoundaries && editTarget.tableBox && (
                      <RowResizeOverlay
                        boundaries={editTarget.rowBoundaries}
                        left={editTarget.tableBox.x}
                        width={editTarget.tableBox.w}
                        scale={scale}
                        onCommit={(b) => void onRowCommit(b)}
                      />
                    )}
                    {/* issue 028: hide the floating toolbar mid-gesture. `pointerActive` is true for the
                        WHOLE press→release (set on pointerDown, cleared on pointerUp), so it already covers
                        a marquee drag — the marquee state (now isolated, issue 030) is no longer needed here.
                        issue 032: also hide it while the in-place editor is open (two chromes must not fight).
                        issue 039: also hide it while the right-click context menu is open (one surface at a
                        time). Both surfaces drive the SAME `fmtActions` handlers (공용 유틸). */}
                    {editingOn && toolbarPage === page && marks.length > 0 && !pointerActive && !editor && !contextMenu && (
                      <FloatingToolbar
                        marks={marks.filter((m) => m.page === page).map((m) => m.box)}
                        scale={scale}
                        viewportWidth={A4_W * zoom}
                        kind={editTarget?.kind ?? "multi"}
                        formatDisabledReason={formatDisabledReason}
                        fonts={fontFamilies}
                        aiEnabled={canEdit}
                        onBold={fmtActions.bold}
                        onItalic={fmtActions.italic}
                        onSize={fmtActions.setSize}
                        onFont={fmtActions.setFont}
                        onColor={fmtActions.setColor}
                        onShade={fmtActions.setShade}
                        onAlign={fmtActions.setAlign}
                        onSendToAi={onSendToAi}
                      />
                    )}
                    {/* issue 032/040: the Figma-style IN-PLACE rich editor sits over the cell rect at the
                        cell's own font size (no popover card). It renders the cell's styled RUNS so partial
                        formatting shows + round-trips; onCommit returns the serialized runs as a Promise so
                        the editor un-latches + stays open on failure; onCancel (Esc) just closes it. */}
                    {editingOn && editor && editor.page === page && (
                      // `key` = the cell address so a Tab move REMOUNTS the editor at the next cell (fresh
                      // latch + focus/select-all) instead of reusing the committed instance (issue 036).
                      <InPlaceCellEditor
                        key={`${editor.section}:${editor.block}:${editor.rows?.[0] ?? "p"}:${editor.cols?.[0] ?? "p"}:${editor.page}`}
                        box={editor.box}
                        scale={scale}
                        initialRuns={editor.runs}
                        fontSizePt={editor.fontSizePt}
                        onCommit={onEditorCommit}
                        onCancel={() => setEditor(null)}
                        onCommitMove={editor.kind === "cell" ? onEditorCommitMove : undefined}
                      />
                    )}
                  </>
                )}
              />
              </div>
            </>
          ) : (
            <div className="hw-empty-canvas">문서를 열면 여기에 페이지가 표시됩니다.</div>
          )}
        </div>
        <ChatPanel
          canEdit={canEdit}
          anchors={anchors}
          modLabel={mod}
          onRemoveAnchor={(i) => core.selection.removeAt(i)}
          onClearAnchors={clearSelection}
          onConsumeAnchors={clearSelection}
          onAiRequest={props.onAiRequest}
          docContext={docContext}
          onApply={onApply}
          onJumpToPage={jumpToPage}
          isMock={props.isMock}
          focusToken={aiFocusToken}
        />
      </div>

      {/* issue 046: the thin bottom status bar (hw-body BOTTOM slot). Current page/total = the scroll
          -position `currentPage`; the selection summary reuses the anchor label; the edit badge tracks
          `enableEditing`. Zoom % is intentionally omitted (owned by the top toolbar — 중복 금지). */}
      {meta && (
        <StatusBar
          currentPage={currentPage}
          pageCount={meta.pages}
          selectionSummary={selectionSummary}
          editing={editingOn}
          canEdit={canEdit}
        />
      )}

      {/* issue 039: the right-click context menu. Its actions are ALL delegations to existing paths —
          텍스트 편집 → the 032 in-place editor (openEditorAt), 굵게/배경색 → the shared `fmtActions`
          (formatCellRange/shadeCellRange, 028과 동일 액션), 행 삽입 → editor-core `insertRows`
          (existing TableInsertRows op), ✨AI에게 전달 → the 028 chat-focus, 표 추가 → the 027 picker
          (onInsertTable). No new intent/action is introduced. */}
      {contextMenu && (() => {
        const cm = contextMenu;
        const close = () => setContextMenu(null);
        if (cm.kind === "background") {
          // 바탕(비개체): 표 추가 — the SAME 027 grid picker (TableSizeGrid) the top toolbar uses.
          return (
            <ContextMenu x={cm.x} y={cm.y} heading="표 추가" onClose={close}>
              <TableSizeGrid onPick={(r, c) => { close(); void onInsertTable(r, c); }} />
            </ContextMenu>
          );
        }
        const items: ContextMenuItem[] = [];
        items.push({ type: "action", key: "edit", label: "텍스트 편집", icon: "✎", onSelect: () => void openEditorAt(cm.click) });
        if (cm.kind === "cell") {
          const fmtOk = !!fmtActions.fmtRange;
          const fmtWhy = fmtOk ? undefined : "이 셀에는 서식을 적용할 수 없습니다";
          items.push({ type: "action", key: "bold", label: editTarget?.curBold ? "굵게 해제" : "굵게", icon: "B", disabled: !fmtOk, title: fmtWhy, onSelect: fmtActions.bold });
          items.push({ type: "action", key: "shade", label: "배경색", icon: "◧", disabled: !fmtOk, title: fmtWhy, onSelect: () => shadeInputRef.current?.click() });
          if (cm.cell) {
            const { section, block, row, cols } = cm.cell;
            items.push({ type: "separator", key: "sep-row" });
            items.push({ type: "action", key: "row-above", label: "위에 행 삽입", icon: "↥", onSelect: () => void onInsertRows(section, block, row, cols) });
            items.push({ type: "action", key: "row-below", label: "아래에 행 삽입", icon: "↧", onSelect: () => void onInsertRows(section, block, row + 1, cols) });
          }
        }
        items.push({ type: "separator", key: "sep-ai" });
        items.push({ type: "action", key: "ai", label: "✨ AI에게 전달", disabled: !canEdit, title: canEdit ? undefined : "편집하려면 먼저 문서를 여세요", onSelect: onSendToAi });
        return <ContextMenu x={cm.x} y={cm.y} items={items} onClose={close} />;
      })()}
      {/* issue 039: the hidden color input the context menu's 배경색 item clicks — routes to the SAME
          shadeCellRange action as the 028 toolbar swatch (신규 액션 0). Kept mounted so the ref is stable. */}
      {editingOn && (
        <input
          ref={shadeInputRef}
          type="color"
          data-testid="hw-ctx-shade-input"
          defaultValue="#ffff00"
          style={{ position: "fixed", left: -9999, top: -9999, width: 1, height: 1, opacity: 0, pointerEvents: "none" }}
          onChange={(e) => fmtActions.setShade(e.target.value)}
        />
      )}

      {status && <div className="hw-status">{status}</div>}
    </div>
  );
}
