import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { listen } from "@tauri-apps/api/event";
import { tinykeys } from "tinykeys";
import { api, type CellHit, type CaretRect, type CharFmt, type FindMatch, type ImageBox, type OutlineItem, type PageGeom, type Proposal, type ProposalOp, type RunDto, type TableBox } from "./api";
import { runsToHtml, serializeEditor, runsUnchanged, applyLiveStyle } from "./richedit";
import { sanitizeSvg } from "./sanitize";
import { advanceOffset, imageBoxToScreen, pageToScreen, screenToPage } from "./caret";
import ImageOverlay from "./ImageOverlay";
import TableOverlay from "./TableOverlay";
import { type Command } from "./commands";
import { Palette } from "./Palette";
import { Composer, type ComposerMode } from "./Composer";
import { Chat, type Scope } from "./Chat";
import { PendingInline } from "./PendingInline";
import { Button, IconButton, Sep, SegmentedControl } from "./ui";
import { toast, Toaster } from "./toast";

type CaretAnchor = { page: number; node: number; offset: number; len: number };

/// 1 cm in own-render px (HWPUNIT/cm = 7200/2.54 = 2834.6; ÷ HWPUNIT_PER_PX(75)). For the ruler ticks.
const CM_PX = 2834.6457 / 75;

/// Page geometry equality (own-render chrome diff) — skip re-rendering a page's margin/ruler overlay
/// when its geometry is unchanged after an edit.
const geomEq = (a: PageGeom | undefined, b: PageGeom) =>
  !!a && a.w === b.w && a.h === b.h && a.ml === b.ml && a.mt === b.mt && a.mr === b.mr && a.mb === b.mb;

/// Editor chrome over an own-render page (NOT in the SVG → never exported): the 한글식 printable-area
/// corner brackets + a top ruler with 1 cm ticks. Positioned as PERCENTAGES of the page box so it tracks
/// zoom for free (the wrapper is the page at the current zoom). `geom` is in own-render px at zoom 1.
function PageChrome({ geom }: { geom: PageGeom }) {
  const { w, h, ml, mt, mr, mb } = geom;
  if (w <= 0 || h <= 0) return null;
  const lp = (ml / w) * 100, tp = (mt / h) * 100, rp = ((w - mr) / w) * 100, bp = ((h - mb) / h) * 100;
  const ARM = 14; // px arm length of each corner bracket (constant on screen)
  const printW = Math.max(0, w - ml - mr);
  const nTicks = Math.min(60, Math.floor(printW / CM_PX)); // guard pathological tiny pages
  const ticks = Array.from({ length: nTicks + 1 }, (_, i) => ({ i, left: ((ml + i * CM_PX) / w) * 100 }));
  return (
    <div className="pointer-events-none absolute inset-0 z-[5]" aria-hidden>
      {/* printable-area corner brackets */}
      <div className="absolute border-l-2 border-t-2 border-accent/45" style={{ left: `${lp}%`, top: `${tp}%`, width: ARM, height: ARM }} />
      <div className="absolute border-r-2 border-t-2 border-accent/45" style={{ left: `${rp}%`, top: `${tp}%`, width: ARM, height: ARM, transform: "translateX(-100%)" }} />
      <div className="absolute border-l-2 border-b-2 border-accent/45" style={{ left: `${lp}%`, top: `${bp}%`, width: ARM, height: ARM, transform: "translateY(-100%)" }} />
      <div className="absolute border-r-2 border-b-2 border-accent/45" style={{ left: `${rp}%`, top: `${bp}%`, width: ARM, height: ARM, transform: "translate(-100%,-100%)" }} />
      {/* top ruler: printable span tinted + 1 cm ticks (taller every 5 cm) */}
      <div className="absolute left-0 right-0 top-0 h-3 border-b border-black/5 bg-neutral-100/70 dark:border-white/5 dark:bg-neutral-700/50">
        <div className="absolute inset-y-0 bg-accent/10" style={{ left: `${lp}%`, width: `${Math.max(0, rp - lp)}%` }} />
        {ticks.map(({ i, left }) => (
          <div key={i} className="absolute bottom-0 w-px bg-neutral-400/70 dark:bg-neutral-400/50" style={{ left: `${left}%`, height: i % 5 === 0 ? "100%" : "45%" }} />
        ))}
      </div>
    </div>
  );
}

/// A few common Korean faces offered in the manual format bar's 글꼴 picker. A font change re-DISPLAYS
/// in the chosen family (the webview renders it if installed); export resolves it via the serializer.
const FONT_CHOICES = ["맑은 고딕", "바탕", "굴림", "돋움", "함초롬바탕", "함초롬돋움", "궁서"];

/// The character-format controls (볼드/이태릭/크기/글꼴) — a position-free row used in the TOP edit
/// toolbar (like a normal document editor's ribbon), not floating over the content. Buttons
/// preventDefault their mousedown so clicking one doesn't blur an open inline editor / deselect the
/// target. `onPatch` sends ONLY the changed attribute (B/I toggle off the current state).
function FormatControls({ fmt, onPatch }: {
  fmt: CharFmt;
  onPatch: (p: { bold?: boolean; italic?: boolean; sizePt?: number; font?: string }) => void;
}) {
  const size = Math.round(fmt.size_pt);
  const keep = (e: React.MouseEvent) => e.preventDefault();
  return (
    <div className="flex items-center gap-0.5">
      <button title="굵게" onMouseDown={keep} onClick={() => onPatch({ bold: !fmt.bold })}
        className={`h-6 w-6 rounded font-bold ${fmt.bold ? "bg-accent text-white" : "hover:bg-black/5 dark:hover:bg-white/10"}`}>가</button>
      <button title="기울임" onMouseDown={keep} onClick={() => onPatch({ italic: !fmt.italic })}
        className={`h-6 w-6 rounded italic ${fmt.italic ? "bg-accent text-white" : "hover:bg-black/5 dark:hover:bg-white/10"}`}>가</button>
      <span className="mx-0.5 h-4 w-px bg-black/10 dark:bg-white/10" />
      <button title="작게" onMouseDown={keep} onClick={() => onPatch({ sizePt: Math.max(4, size - 1) })}
        className="h-6 w-6 rounded hover:bg-black/5 dark:hover:bg-white/10">−</button>
      <span className="min-w-[1.6rem] text-center tabular-nums" title="글자 크기(pt)">{size}</span>
      <button title="크게" onMouseDown={keep} onClick={() => onPatch({ sizePt: Math.min(96, size + 1) })}
        className="h-6 w-6 rounded hover:bg-black/5 dark:hover:bg-white/10">+</button>
      <span className="mx-0.5 h-4 w-px bg-black/10 dark:bg-white/10" />
      <select title="글꼴" value={fmt.font ?? ""} onMouseDown={(e) => e.stopPropagation()}
        onChange={(e) => onPatch({ font: e.target.value })}
        className="max-w-[7rem] cursor-pointer rounded bg-transparent text-xs outline-none">
        <option value="">(기본 글꼴)</option>
        {FONT_CHOICES.map((f) => <option key={f} value={f}>{f}</option>)}
      </select>
    </div>
  );
}

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
  // U4: document outline (left nav). `outlineOpen` toggles the panel (⌘\); `outline` is fetched on
  // open + after every edit (doc-changed) so headings + their pages stay current.
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [outline, setOutline] = useState<OutlineItem[]>([]);
  // U5: a tiny point-action popover (right-click a block → AI로 편집 / 이미지 삽입) + a ? cheat-sheet.
  const [pointMenu, setPointMenu] = useState<{ x: number; y: number; page: number; section: number; block: number | null; box?: { x: number; y: number; w: number; h: number } | null; kind?: string; text?: string } | null>(null);
  const [cheatOpen, setCheatOpen] = useState(false);
  // Discoverability: a one-time hint card surfacing the (otherwise hidden) manual-edit gestures —
  // click-to-edit, the ⋯/우클릭 quick-action popover, image drag&drop. Dismissed forever via a
  // localStorage flag so it never nags a returning user; shown only once a doc is editable.
  const HINT_KEY = "hankan.manualEditHintSeen";
  const [hintSeen, setHintSeen] = useState(() => {
    try { return localStorage.getItem(HINT_KEY) === "1"; } catch { return true; }
  });
  const dismissHint = useCallback(() => {
    setHintSeen(true);
    try { localStorage.setItem(HINT_KEY, "1"); } catch { /* private mode — just hide it this session */ }
  }, []);
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  // The full-screen busy overlay is BLOCKING, so only raise it for genuinely slow work: while busy, a
  // thin top progress bar shows immediately, and the dimming overlay only appears if the op is still
  // running after a short grace period (fast ops finish first → no jarring flash). `overlayBusy`
  // gates the full overlay; the top bar tracks `busyLabel` directly.
  const OVERLAY_DELAY_MS = 250;
  const [overlayBusy, setOverlayBusy] = useState(false);
  useEffect(() => {
    if (!busyLabel) {
      setOverlayBusy(false);
      return;
    }
    const t = window.setTimeout(() => setOverlayBusy(true), OVERLAY_DELAY_MS);
    return () => window.clearTimeout(t);
  }, [busyLabel]);
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
  // HWPUNIT per CSS px (the own SVG's HWPUNIT→px scale). Own-engine geometry commands speak the SVG's
  // px space (so clicks/handles line up), but the edit OPS (SetImageSize / MoveImage size) want
  // HWPUNIT — convert px→HWPUNIT at the commit boundary.
  const HWPUNIT_PER_PX = 7200 / 96;
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
  // Post-apply highlight PULSE: after a chat edit commits we flash a soft accent glow over the page
  // it landed on, then clear it (a one-shot timer) so the eye is led to "what changed". The pulse
  // overlay is drawn on the SVG page wrapper whose `data-index` matches `pulsePage`.
  const [pulsePage, setPulsePage] = useState<number | null>(null);
  const pulseTimer = useRef<number | undefined>(undefined);
  const pulse = useCallback((page: number | null) => {
    if (page === null) return;
    window.clearTimeout(pulseTimer.current);
    setPulsePage(page);
    pulseTimer.current = window.setTimeout(() => setPulsePage(null), 1500);
  }, []);
  useEffect(() => () => window.clearTimeout(pulseTimer.current), []);
  // IMPLEMENT B — INLINE pending review: when the chat proposer returns a (still dry-run) proposal,
  // we lift it here so the review moves INTO the document. `pending` carries the structured ops, the
  // page the user pointed at (or the page in view) to anchor the "제안됨" band + ✓확정/✕취소/✎다시
  // toolbar, the provider (mock = honest "예시 제안"), and the primary op's (section, block) so ✎다시
  // can re-open the chat scoped to exactly that block. The chat CARD still mirrors this (both call the
  // SAME commit_proposal/discard_proposal); `pendingSettle` is the signal that settles the card when
  // the user acts on the INLINE toolbar. Cleared on commit/discard/undo and on a new document.
  type Pending = { ops: ProposalOp[]; provider: string; rationale: string; page: number; section: number | null; block: number | null };
  const [pending, setPending] = useState<Pending | null>(null);
  const [pendingBusy, setPendingBusy] = useState(false);
  // A monotonic signal (+ the terminal state) the chat watches to settle its mirrored card when the
  // user confirms/rejects from the INLINE toolbar instead of the panel.
  const [pendingSettle, setPendingSettle] = useState<{ n: number; state: "applied" | "discarded" } | null>(null);
  const settleSeq = useRef(0);
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

  // ---- Image move/resize overlay (own-render only): the selected image + its CSS-px screen box. The
  // box is recomputed from the page-unit `ImageBox` against the live SVG rect/viewBox (so it tracks
  // zoom), mirroring `recomputeCaretBox`. Cleared on repaint / mode-switch / deselect. ----
  type ImageSel = {
    page: number;
    box: ImageBox; // page-unit geometry + (section, block) anchor
    screen: { left: number; top: number; width: number; height: number };
    pxPerPageX: number;
    pxPerPageY: number;
  };
  const [imageSel, setImageSel] = useState<ImageSel | null>(null);
  const imageSelRef = useRef<ImageSel | null>(null);
  imageSelRef.current = imageSel;

  // ---- Table drag-to-move + quick-edit overlay (own-render only): the selected table + its CSS-px
  // screen box, recomputed from the page-unit `TableBox` against the live SVG rect/viewBox (so it
  // tracks zoom), mirroring `imageSel`. Cleared on repaint / mode-switch / deselect. ----
  type TableSel = {
    page: number;
    box: TableBox; // page-unit geometry + (section, block) anchor + rows/cols
    screen: { left: number; top: number; width: number; height: number };
    pxPerPageY: number;
    colFracs: number[]; // cols+1 fractional column boundaries (0..1 across the table) for resize handles
    rowFracs: number[]; // rows+1 fractional row boundaries (0..1 down the table) for row-resize handles
  };
  const [tableSel, setTableSel] = useState<TableSel | null>(null);
  const tableSelRef = useRef<TableSel | null>(null);
  tableSelRef.current = tableSel;

  // ---- Active CELL (own-render): a SINGLE click inside a table marks one cell as active (alongside the
  // table overlay) so ⌘C/⌘V/Delete and 배경색 target THAT cell without entering the inline editor. A
  // subtle ring highlights it; double-click still opens inline edit. Cleared on repaint/deselect. ----
  type ActiveCell = {
    page: number;
    section: number;
    block: number;
    row: number;
    col: number;
    rows: number;
    cols: number;
    text: string;
    box: { x: number; y: number; w: number; h: number }; // own-engine px box → recompute screen on zoom
    screen: { left: number; top: number; width: number; height: number };
  };
  const [activeCell, setActiveCell] = useState<ActiveCell | null>(null);
  const activeCellRef = useRef<ActiveCell | null>(null);
  activeCellRef.current = activeCell;

  // ---- Point-to-scope PIN (the visible "여기" marker, own-render): when the user POINTS at a block
  // (a click on body text in 자체 렌더, or right-click/⋯ → AI 편집), we resolve it to a block band via
  // `own_hit_test` and pin a highlight + label over it so "가리키기"(pointing) is tangible and the
  // chat/insert knows the target. The pin mirrors the chat's scope chip; clearing the scope clears the
  // pin. Recomputed against the live SVG rect/viewBox on zoom (like the image/table overlays). ----
  type ScopePin = {
    page: number;
    section: number;
    block: number;
    box: { x: number; y: number; w: number; h: number }; // own-engine page units (anchor band)
    screen: { left: number; top: number; width: number; height: number };
    kind: string;
    text: string; // the pointed block's current text — for Cmd+C copy
  };
  const [scopePin, setScopePin] = useState<ScopePin | null>(null);
  const scopePinRef = useRef<ScopePin | null>(null);
  scopePinRef.current = scopePin;

  // ---- Drag drop INDICATOR (own-render): while dragging an image/table, a horizontal accent line marks
  // the block its drop would land before, so "들어갈 곳" is visible. `top` is screen-px in the page
  // wrapper. Resolved (throttled, one-in-flight) via own_hit_test on pointer-move; cleared on drop. ----
  const [dropHint, setDropHint] = useState<{ page: number; top: number } | null>(null);
  const dropHintBusy = useRef(false);
  // True only while a drag is in progress — an own_hit_test resolve that returns AFTER the drop must
  // NOT re-show the indicator (otherwise it sticks after the drag ends).
  const dropDragActive = useRef(false);

  // ---- Inline editor (own-render): an in-place text box laid directly OVER a table CELL or a simple
  // PARAGRAPH — double-click to type right there (no modal). `screen` is px relative to the page wrapper
  // (same space as the overlays); commit calls set_table_cell (kind 'cell') / set_paragraph_text
  // (kind 'para'). Replaces the old (row,col)-form modal. ----
  type InlineEdit = {
    kind: "cell" | "para";
    page: number;
    section: number;
    block: number;
    row?: number;
    col?: number;
    text: string;
    runs: RunDto[]; // the block's styled runs → rendered as the contentEditable's initial HTML (WYSIWYG)
    scale: number; // page zoom (rect.width/viewBox.width) at open — for run size px ↔ pt round-trip
    box: { x: number; y: number; w: number; h: number }; // own-engine px box → recompute screen on zoom
    screen: { left: number; top: number; width: number; height: number };
  };
  const [inlineEdit, setInlineEdit] = useState<InlineEdit | null>(null);
  const inlineEditRef = useRef<InlineEdit | null>(null);
  inlineEditRef.current = inlineEdit;
  // True once the open editor has been committed/cancelled — so the unmount blur that fires when the
  // textarea closes doesn't commit a SECOND time (Enter/Escape → close → unmount → blur). Reset by
  // `openInlineEdit` when a new editor opens.
  const inlineClosedRef = useRef(false);
  // A char-format op (whole-target or ⌘B/⌘I range) was applied to the IR while the editor stayed open,
  // so the SVG behind it is stale and must be repainted on the next commit/cancel (even a no-op commit).
  const fmtDeferredRef = useRef(false);
  // Diff-refresh the own page in place (no editor unmount) — used to flush a deferred format repaint.
  const flushDeferredRepaint = useRef<() => void>(() => {});
  const openInlineEdit = useCallback((ie: InlineEdit) => {
    inlineClosedRef.current = false;
    fmtDeferredRef.current = false; // a fresh editor starts with no pending format repaint
    setScopePin(null);
    setInlineEdit(ie);
  }, []);
  const cancelInlineEdit = useCallback(() => {
    inlineClosedRef.current = true; // the unmount blur must NOT commit a cancel
    setInlineEdit(null);
    if (fmtDeferredRef.current) { fmtDeferredRef.current = false; flushDeferredRepaint.current(); }
  }, []);

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
  // True while any modal/popover/palette is open — the own-mode key lane bails so a stray Backspace
  // behind a modal (focus not on its input yet) can't delete the pinned block.
  const modalOpenRef = useRef(false);
  modalOpenRef.current = !!(composer || paletteOpen || cheatOpen || pointMenu || findOpen);

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
  // Run `cb` once `page`'s SVG is back in the DOM after a repaint (an edit clears the cache, so the SVG
  // is briefly a skeleton while it re-fetches). Without this an overlay re-place fires too early —
  // `svgForPage` returns null → the selection/overlay vanishes (the "행 추가 시 UI가 튀는" flicker).
  // Polls a bounded number of frames so an off-screen page (never repainted) doesn't loop forever.
  // The in-flight own-render diff-refresh (set by invalidate). whenPagePainted awaits it so overlays
  // re-place against the FRESH post-edit SVG, not the pre-edit one still in the DOM (the diff-refresh
  // keeps the old SVG mounted until the new one swaps in — so svgForPage alone is no longer a "repaint
  // finished" signal). Resolved by default (no refresh pending / svg mode).
  const ownRefreshRef = useRef<Promise<void>>(Promise.resolve());
  const whenPagePainted = useCallback((page: number, cb: () => void) => {
    void ownRefreshRef.current.then(() => {
      let tries = 0;
      const tick = () => {
        if (svgForPage(page) || tries++ > 40) { cb(); return; }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }, []);
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
  const clearImageSel = useCallback(() => setImageSel(null), []);
  const clearTableSel = useCallback(() => setTableSel(null), []);
  // Clear the AI scope AND its visible pin together (the chip + the on-page marker are one concept).
  const clearScope = useCallback(() => {
    setScope(null);
    setScopePin(null);
  }, []);

  // Re-place a known image selection's overlay against the LIVE svg rect/viewBox (after zoom or a
  // repaint) — the move/resize twin of `recomputeCaretBox`. `null` box drops the selection.
  const recomputeImageBox = useCallback((page: number, box: ImageBox | null) => {
    if (!box) return setImageSel(null);
    const svg = svgForPage(page);
    if (!svg) return setImageSel(null);
    const rect = svg.getBoundingClientRect();
    const vb = svg.viewBox.baseVal;
    const screen = imageBoxToScreen(box, { width: rect.width, height: rect.height }, { width: vb.width, height: vb.height });
    if (!screen || vb.width === 0 || vb.height === 0) return setImageSel(null);
    setImageSel({ page, box, screen, pxPerPageX: rect.width / vb.width, pxPerPageY: rect.height / vb.height });
  }, []);

  // Re-place a known table selection's overlay against the LIVE svg rect/viewBox — the move twin of
  // `recomputeImageBox` (a `TableBox` shares the `x/y/w/h` shape so `imageBoxToScreen` maps it too).
  const recomputeTableBox = useCallback((page: number, box: TableBox | null) => {
    if (!box) return setTableSel(null);
    const svg = svgForPage(page);
    if (!svg) return setTableSel(null);
    const rect = svg.getBoundingClientRect();
    const vb = svg.viewBox.baseVal;
    const screen = imageBoxToScreen(box, { width: rect.width, height: rect.height }, { width: vb.width, height: vb.height });
    if (!screen || vb.width === 0 || vb.height === 0) return setTableSel(null);
    setTableSel((prev) => ({ page, box, screen, pxPerPageY: rect.height / vb.height, colFracs: prev?.colFracs ?? [], rowFracs: prev?.rowFracs ?? [] }));
    // Fetch the column + row boundary fractions (for the resize handles) — async, patched in when ready.
    void (async () => {
      try {
        const xs = await api.tableColBoundaries(page, box.section, box.block);
        if (xs && box.w > 0) {
          const fracs = xs.map((x) => (x - box.x) / box.w);
          setTableSel((cur) => (cur && cur.box.section === box.section && cur.box.block === box.block ? { ...cur, colFracs: fracs } : cur));
        }
      } catch { /* leave colFracs empty → no handles */ }
    })();
    void (async () => {
      try {
        const ys = await api.tableRowBoundaries(page, box.section, box.block);
        if (ys && box.h > 0) {
          const fracs = ys.map((y) => (y - box.y) / box.h);
          setTableSel((cur) => (cur && cur.box.section === box.section && cur.box.block === box.block ? { ...cur, rowFracs: fracs } : cur));
        }
      } catch { /* leave rowFracs empty → no handles */ }
    })();
  }, []);

  // Re-place the scope PIN against the LIVE svg rect/viewBox (zoom/repaint) — the pointing twin of
  // `recomputeTableBox` (a band box shares the `x/y/w/h` shape so `imageBoxToScreen` maps it too).
  const recomputeScopePin = useCallback((page: number, section: number, block: number, box: { x: number; y: number; w: number; h: number } | null, kind: string, text: string) => {
    if (!box) return setScopePin(null);
    const svg = svgForPage(page);
    if (!svg) return setScopePin(null);
    const rect = svg.getBoundingClientRect();
    const vb = svg.viewBox.baseVal;
    const screen = imageBoxToScreen(box, { width: rect.width, height: rect.height }, { width: vb.width, height: vb.height });
    if (!screen || vb.width === 0 || vb.height === 0) return setScopePin(null);
    setScopePin({ page, section, block, box, screen, kind, text });
  }, []);

  // Re-place the active-cell highlight against the live svg rect/viewBox (mirrors recomputeScopePin).
  const recomputeActiveCell = useCallback((page: number, cell: CellHit | null) => {
    if (!cell) return setActiveCell(null);
    const svg = svgForPage(page);
    if (!svg) return setActiveCell(null);
    const rect = svg.getBoundingClientRect();
    const vb = svg.viewBox.baseVal;
    const box = { x: cell.x, y: cell.y, w: cell.w, h: cell.h };
    const screen = imageBoxToScreen(box, { width: rect.width, height: rect.height }, { width: vb.width, height: vb.height });
    if (!screen || vb.width === 0 || vb.height === 0) return setActiveCell(null);
    setActiveCell({ page, section: cell.section, block: cell.block, row: cell.row, col: cell.col, rows: cell.rows, cols: cell.cols, text: cell.text, box, screen });
  }, []);

  // In 'own' mode the page list is paginated by OUR engine (its count can differ from rhwp's).
  const listCount = viewMode === "own" ? ownPageCount : pageCount;
  const listCountRef = useRef(listCount);
  listCountRef.current = listCount;
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
    // Re-place the image + table overlays too so they track the new zoom scale.
    if (imageSelRef.current) recomputeImageBox(imageSelRef.current.page, imageSelRef.current.box);
    if (tableSelRef.current) recomputeTableBox(tableSelRef.current.page, tableSelRef.current.box);
    if (scopePinRef.current) { const p = scopePinRef.current; recomputeScopePin(p.page, p.section, p.block, p.box, p.kind, p.text); }
    if (activeCellRef.current) {
      const a = activeCellRef.current;
      const svg = svgForPage(a.page);
      if (svg) {
        const r = svg.getBoundingClientRect();
        const vb = svg.viewBox.baseVal;
        const screen = imageBoxToScreen(a.box, { width: r.width, height: r.height }, { width: vb.width, height: vb.height });
        if (screen) setActiveCell((cur) => (cur ? { ...cur, screen } : cur));
      }
    }
    // Re-place the inline editor too so it stays over its cell/paragraph when the zoom changes.
    const ie = inlineEditRef.current;
    if (ie) {
      const svg = svgForPage(ie.page);
      if (svg) {
        const r = svg.getBoundingClientRect();
        const vb = svg.viewBox.baseVal;
        const screen = imageBoxToScreen(ie.box, { width: r.width, height: r.height }, { width: vb.width, height: vb.height });
        if (screen) setInlineEdit((cur) => (cur ? { ...cur, screen } : cur));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageWidth]);

  // Escape clears the scope pin (only attached while one exists; the image/table overlays own their
  // own Esc, and a pin never coexists with an overlay so there's no conflict).
  useEffect(() => {
    if (!scopePin) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") clearScope(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [scopePin, clearScope]);

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

  // Per-page geometry (own mode) for the editor chrome — margin corner marks + top ruler. Fetched
  // lazily per visible page, cleared on repaint (edits can change page size / margins / page count).
  const [pageGeom, setPageGeom] = useState<Record<number, PageGeom>>({});
  const pageGeomRef = useRef(pageGeom);
  pageGeomRef.current = pageGeom;
  const pageGeomInflight = useRef<Set<number>>(new Set());
  const ensurePageGeom = useCallback(async (i: number) => {
    if (pageGeomRef.current[i] !== undefined || pageGeomInflight.current.has(i)) return;
    pageGeomInflight.current.add(i);
    try {
      const g = await api.pageGeometry(i);
      if (g) setPageGeom((c) => ({ ...c, [i]: g }));
    } catch { /* no chrome for this page */ } finally {
      pageGeomInflight.current.delete(i);
    }
  }, []);

  // `scrollTo === null` keeps the current scroll (chat edits shouldn't yank the view to the doc end —
  // the "결과가 튀는" issue); a number scrolls to that page.
  // After an edit, REFRESH the own-render in place instead of emptying the cache: re-render only the
  // pages currently cached (the visible/scrolled set — bounded by the viewport, not the doc length),
  // and swap a page's SVG into the cache ONLY when it actually changed. An unchanged page returns the
  // byte-identical SVG (the engine renders deterministically) → same cache reference → React skips its
  // re-render and keeps its exact DOM node → no skeleton flash, no flicker. A single-cell edit thus
  // repaints just the 1 page that changed; pages an edit didn't touch don't re-render at all. Pages an
  // edit REMOVED (count shrank) error on re-render and are dropped; ADDED pages fetch lazily on scroll.
  const refreshOwnPages = useCallback(async () => {
    const idx = Object.keys(ownSvgCacheRef.current).map(Number);
    await Promise.all(idx.map(async (i) => {
      try {
        const svg = sanitizeSvg(await api.renderOwnPage(i));
        setOwnSvgCache((c) => (c[i] === svg ? c : { ...c, [i]: svg })); // swap only if changed
      } catch {
        setOwnSvgCache((c) => { if (!(i in c)) return c; const { [i]: _drop, ...rest } = c; return rest; });
      }
    }));
    const gidx = Object.keys(pageGeomRef.current).map(Number);
    await Promise.all(gidx.map(async (i) => {
      try {
        const g = await api.pageGeometry(i);
        if (g) setPageGeom((c) => (geomEq(c[i], g) ? c : { ...c, [i]: g }));
        else setPageGeom((c) => { if (!(i in c)) return c; const { [i]: _d, ...rest } = c; return rest; });
      } catch { /* keep the existing chrome */ }
    }));
  }, []);

  const invalidate = useCallback((n: number, scrollTo: number | null = 0) => {
    // Keep-scroll edits (scrollTo === null) must hold the viewport STILL: clearing the cache collapses
    // pages to skeletons for a frame, which otherwise yanks the scroll (the "행 추가 시 UI가 튀는"
    // jank). Snapshot scrollTop now and pin it back over the next few frames as pages re-measure.
    const holdScroll = scrollTo === null ? (scrollRef.current?.scrollTop ?? null) : null;
    if (holdScroll !== null) {
      let frames = 0;
      const pin = () => {
        if (scrollRef.current) scrollRef.current.scrollTop = holdScroll;
        if (frames++ < 6) requestAnimationFrame(pin);
      };
      requestAnimationFrame(pin);
    }
    setSvgCache({});
    setPageCount(n);
    clearCaret();
    clearImageSel();
    clearTableSel();
    // The pin's band box is stale after a repaint (block indices/positions shift) — drop the visible
    // marker (the chat scope chip is managed separately by the commit/clear paths).
    setScopePin(null);
    setActiveCell(null); // the cell's box/text is stale after a repaint
    setDropHint(null); // any in-progress drag indicator is moot after a repaint
    setInlineEdit(null); // a lingering inline editor's coords are stale after a repaint
    // Own-render repaint: when 'own' is ACTIVE, diff-refresh in place (no flicker, only changed pages
    // re-render — see refreshOwnPages). When it's NOT active (svg/html mode), just drop the stale own
    // cache so it re-fetches fresh on the next switch to 'own'.
    if (viewModeRef.current === "own") {
      // Hold the refresh promise so whenPagePainted (overlay re-placement) waits for the post-edit
      // SVGs to actually swap into the DOM before measuring.
      ownRefreshRef.current = refreshOwnPages();
    } else {
      setOwnSvgCache({});
      setPageGeom({});
    }
    if (viewModeRef.current === "html") void loadDocHtml();
    else if (viewModeRef.current === "own") void loadOwnPageCount();
    if (scrollTo !== null) {
      // Scroll within the active mode's list (own can have a different page count than rhwp).
      const max = (viewModeRef.current === "own" ? ownPageCountRef.current : n) - 1;
      queueMicrotask(() => virtualizer.scrollToIndex(Math.max(0, Math.min(scrollTo, max))));
    }
    // U4: refresh the outline (headings + their pages) after open/edit.
    if (n > 0) api.docOutline().then(setOutline).catch(() => setOutline([]));
    else setOutline([]);
  }, [clearCaret, virtualizer, loadDocHtml, loadOwnPageCount, refreshOwnPages]);
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

  // ---- U5: open the point-action popover (AI 편집 scope / 이미지 삽입) at a screen point, resolving the
  // (section, block) the point falls on. Shared by right-click AND the hover ⋯ 편집 handle so editing
  // isn't hidden behind right-click only. `host` is the page wrapper; `menuAt` is where the popover
  // anchors (the click point for right-click, the handle's corner for the hover affordance). ----
  const openPointMenu = useCallback(async (host: Element, pagePt: { clientX: number; clientY: number }, menuAt: { x: number; y: number }) => {
    if (!canEditRef.current) return;
    const page = Number(host.getAttribute("data-index"));
    const svg = host.querySelector("svg");
    if (!svg || !Number.isFinite(page)) return;
    const rect = svg.getBoundingClientRect();
    const vb = svg.viewBox.baseVal;
    const pt = screenToPage(pagePt.clientX, pagePt.clientY, { left: rect.left, top: rect.top, width: rect.width, height: rect.height }, { width: vb.width, height: vb.height });
    let section = 0;
    let block: number | null = null;
    let box: { x: number; y: number; w: number; h: number } | null = null;
    let kind = "";
    let text = "";
    if (pt) {
      try {
        if (viewModeRef.current === "own") {
          // Own-render: resolve the general block (paragraph included) so the popover anchors to what
          // was pointed at — and carry its band box so 'AI 편집' can drop the same visible pin.
          const hit = await api.ownHitTest(page, pt.x, pt.y);
          if (hit) { section = hit.section; block = hit.block; box = { x: hit.x, y: hit.y, w: hit.w, h: hit.h }; kind = hit.kind; text = hit.text; }
        } else {
          const hit = await api.hitTest(page, pt.x, pt.y);
          if (hit) { section = hit.section; block = hit.block; }
        }
      } catch { /* miss → section/doc-end scope */ }
    }
    setPointMenu({ x: menuAt.x, y: menuAt.y, page, section, block, box, kind, text });
  }, []);

  // ---- U5: right-click a block → the point-action popover anchored at the click point. ----
  async function onPageContextMenu(e: React.MouseEvent) {
    if (!canEditRef.current) return;
    const host = (e.target as Element).closest("[data-index]");
    if (!host) return;
    e.preventDefault();
    await openPointMenu(host, { clientX: e.clientX, clientY: e.clientY }, { x: e.clientX, y: e.clientY });
  }

  // ---- Discoverability: the hover ⋯ 편집 handle (top-right of an editable page) opens the SAME
  // point-action popover, hit-testing the page center so editing isn't hidden behind right-click. ----
  const onEditHandle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    const host = (e.currentTarget as Element).closest("[data-index]");
    if (!host) return;
    const svg = host.querySelector("svg");
    const r = svg?.getBoundingClientRect();
    // Hit-test the page's horizontal center near the handle's vertical position so the resolved scope
    // is a real block on that page (the handle sits in the margin, off any glyph).
    const cx = r ? r.left + r.width / 2 : e.clientX;
    const cy = r ? Math.min(Math.max(e.clientY, r.top + 8), r.bottom - 8) : e.clientY;
    const at = (e.currentTarget as Element).getBoundingClientRect();
    void openPointMenu(host, { clientX: cx, clientY: cy }, { x: at.right, y: at.bottom + 4 });
  }, [openPointMenu]);

  // ---- double-click (own-render) → INLINE text editing right where you point. A table cell opens an
  // in-place box over that cell; a simple paragraph (incl. an empty one — "무에서 텍스트 추가") opens one
  // over the paragraph band. Single-click still sets the AI pin; double-click = type directly. ----
  async function onPageDoubleClick(e: React.MouseEvent) {
    if (!canEditRef.current || viewModeRef.current !== "own") return;
    const host = (e.target as Element).closest("[data-index]");
    if (!host) return;
    const page = Number(host.getAttribute("data-index"));
    if (!Number.isFinite(page)) return;
    const clientX = e.clientX;
    const clientY = e.clientY; // capture before any await (React may reuse the event)
    // If an editor (A) is open, the first mousedown already blurred+committed it. Wait for that commit's
    // repaint to SETTLE before resolving/opening B — so B opens AFTER A's invalidate (no clear) and its
    // box is computed against the FRESH layout (A's edit may have shifted B). Otherwise open immediately.
    if (inlineEditRef.current) {
      try { await editQueue.current; } catch { /* edit error already toasted */ }
      await new Promise<void>((resolve) => whenPagePainted(page, resolve));
    }
    const svg = svgForPage(page);
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const vb = svg.viewBox.baseVal;
    const dim = { width: rect.width, height: rect.height };
    const vbd = { width: vb.width, height: vb.height };
    const pt = screenToPage(clientX, clientY, { left: rect.left, top: rect.top, ...dim }, vbd);
    if (!pt) return;
    try {
      // 1) A table cell → inline-edit that cell.
      const cell = await api.tableCellAt(page, pt.x, pt.y);
      if (cell) {
        const box = { x: cell.x, y: cell.y, w: cell.w, h: cell.h };
        const screen = imageBoxToScreen(box, dim, vbd);
        if (screen) {
          // The cell being edited IS the shading reference — mark it active so 🎨 배경색 → 이 칸만 has a
          // visible, unambiguous target right there during the edit (the user's "더블클릭 상태에 배경색").
          recomputeActiveCell(page, cell);
          const scale = dim.width / vbd.width;
          const runs = await api.getBlockRuns(cell.section, cell.block, cell.row, cell.col).catch(() => [{ text: cell.text }]);
          openInlineEdit({ kind: "cell", page, section: cell.section, block: cell.block, row: cell.row, col: cell.col, text: cell.text, runs, scale, box, screen });
        }
        return;
      }
      // 2) Else a simple paragraph (not a table/image band) → inline-edit its text in place.
      const hit = await api.ownHitTest(page, pt.x, pt.y);
      if (hit && hit.kind === "paragraph") {
        // Gate non-editable (structural/image/field) paragraphs BEFORE opening the editor so the user
        // never types into something that will refuse on commit — point at it + guide to chat instead.
        if (!hit.editable) {
          setScope({ section: hit.section, block: hit.block, page });
          recomputeScopePin(page, hit.section, hit.block, { x: hit.x, y: hit.y, w: hit.w, h: hit.h }, hit.kind, hit.text);
          toast("info", "이 문단은 직접 편집 대상이 아니에요 — ✦바이브(채팅)로 편집하세요");
          return;
        }
        const box = { x: hit.x, y: hit.y, w: hit.w, h: Math.max(hit.h, 320 / HWPUNIT_PER_PX) };
        const screen = imageBoxToScreen(box, dim, vbd);
        if (screen) {
          const scale = dim.width / vbd.width;
          const runs = await api.getBlockRuns(hit.section, hit.block, null, null).catch(() => [{ text: hit.text }]);
          openInlineEdit({ kind: "para", page, section: hit.section, block: hit.block, text: hit.text, runs, scale, box, screen });
        }
      }
    } catch (err) { toast("warn", `${err}`); }
  }

  // ---- caret: click-to-place ----
  async function onPageClick(e: React.MouseEvent) {
    if (!canEditRef.current) return;
    // A click landing ON an overlay (image handles / table grab+toolbar) is that overlay's own
    // gesture — don't re-hit-test (it would deselect mid-drag).
    if ((e.target as Element).closest("[data-image-overlay],[data-table-overlay]")) return;
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
    // In the 'own' (자체 렌더) fidelity view the displayed SVG is OUR engine's, so the rhwp caret
    // hit-test geometry doesn't apply — but the image overlay DOES use own-engine geometry. Click to
    // select the image under the pointer (or deselect on an empty click); no caret in own mode.
    if (viewModeRef.current === "own") {
      try {
        // Priority: an image (sits on top) → its move/resize overlay; else a table → its drag /
        // quick-edit overlay; else the top-level block under the point → an AI scope + a visible PIN.
        // EVERY case sets the chat scope to what was clicked, so "point-then-ask" ("이거 채워줘") works
        // and inserts land HERE, not at the document end. The overlay RING is the marker for an
        // image/table (no extra pin); a paragraph gets the explicit pin highlight.
        const img = await api.imageAt(page, pt.x, pt.y);
        if (img) {
          setTableSel(null);
          setActiveCell(null);
          recomputeImageBox(page, img);
          setScope({ section: img.section, block: img.block, page });
          setScopePin(null);
          return;
        }
        const tbl = await api.tableAt(page, pt.x, pt.y);
        if (tbl) {
          setImageSel(null);
          recomputeTableBox(page, tbl);
          setScope({ section: tbl.section, block: tbl.block, page });
          setScopePin(null);
          // Mark the clicked CELL active (for ⌘C/⌘V/Delete/배경색); the overlay still shows for the table.
          recomputeActiveCell(page, await api.tableCellAt(page, pt.x, pt.y));
          return;
        }
        setImageSel(null);
        setTableSel(null);
        setActiveCell(null);
        const hit = await api.ownHitTest(page, pt.x, pt.y);
        if (hit) {
          setScope({ section: hit.section, block: hit.block, page });
          recomputeScopePin(page, hit.section, hit.block, { x: hit.x, y: hit.y, w: hit.w, h: hit.h }, hit.kind, hit.text);
        } else {
          clearScope();
        }
      } catch (err) {
        toast("warn", `선택 실패: ${err}`);
      }
      return;
    }
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

  // ---- image overlay: commit (one undoable op on pointerup), then re-place the overlay on the image.
  // After the op the doc repaints (invalidate clears the SVG cache + selection); we re-fetch the new
  // bbox for the resolved anchor once the fresh page paints so the handles stay on the image. ----
  const reselectAfterRepaint = useCallback((page: number, section: number, block: number) => {
    // Wait for the actual repaint (cache cleared → SVG re-fetched) before the bbox query + re-place, so
    // the handles don't vanish on a still-skeleton page.
    whenPagePainted(page, () => {
      void (async () => {
        try {
          const box = await api.imageBbox(page, section, block);
          recomputeImageBox(page, box);
        } catch {
          setImageSel(null);
        }
      })();
    });
  }, [recomputeImageBox, whenPagePainted]);

  // ---- table overlay: re-place the overlay on the table after a repaint (mirrors reselectAfterRepaint).
  // Declared here (above the clipboard/edit handlers that use it) to avoid a use-before-declaration.
  const reselectTableAfterRepaint = useCallback((page: number, section: number, block: number) => {
    whenPagePainted(page, () => {
      void (async () => {
        try {
          const box = await api.tableBbox(page, section, block);
          recomputeTableBox(page, box);
        } catch {
          setTableSel(null);
        }
      })();
    });
  }, [recomputeTableBox, whenPagePainted]);

  // Resolve the document block under a DROP point (own-engine geometry), restricted to `section` (a
  // MoveBlock relocation stays within its section). Returns the target block index, or null on a miss /
  // cross-section drop. Shared by the table + image drag-to-move commits so a drop lands WHERE pointed.
  // The page wrapper under a screen point, SKIPPING the drag overlay (which sits on top and would
  // otherwise resolve to its ORIGINAL page even when dragged over a different one).
  const pageHostAt = useCallback((clientX: number, clientY: number): Element | null => {
    const els = document.elementsFromPoint(clientX, clientY);
    for (const el of els) {
      if (el.closest("[data-image-overlay],[data-table-overlay]")) continue;
      const host = el.closest("[data-index]");
      if (host) return host;
    }
    return null;
  }, []);

  const resolveDropBlock = useCallback(async (clientX: number, clientY: number, section: number): Promise<number | null> => {
    const host = pageHostAt(clientX, clientY);
    const svg = host?.querySelector("svg") ?? null;
    if (!host || !svg) return null;
    const page = Number(host.getAttribute("data-index"));
    if (!Number.isFinite(page)) return null;
    const rect = svg.getBoundingClientRect();
    const vb = svg.viewBox.baseVal;
    const pt = screenToPage(clientX, clientY, { left: rect.left, top: rect.top, width: rect.width, height: rect.height }, { width: vb.width, height: vb.height });
    if (!pt) return null;
    try {
      const hit = await api.ownHitTest(page, pt.x, pt.y);
      if (hit && hit.section === section) return hit.block;
    } catch { /* miss → no target */ }
    return null;
  }, [pageHostAt]);

  // Live drop indicator: resolve the block under the dragged pointer (throttled to one in-flight call)
  // and place a horizontal accent line at its top edge. Skips the overlay so the page under the pointer
  // is used, mirroring resolveDropBlock.
  const updateDropHint = useCallback((clientX: number, clientY: number) => {
    dropDragActive.current = true; // a drag is live
    if (dropHintBusy.current) return;
    const host = pageHostAt(clientX, clientY);
    const svg = host?.querySelector("svg") ?? null;
    if (!host || !svg) return;
    const page = Number(host.getAttribute("data-index"));
    if (!Number.isFinite(page)) return;
    const rect = svg.getBoundingClientRect();
    const vb = svg.viewBox.baseVal;
    const pt = screenToPage(clientX, clientY, { left: rect.left, top: rect.top, width: rect.width, height: rect.height }, { width: vb.width, height: vb.height });
    if (!pt) return;
    dropHintBusy.current = true;
    api.ownHitTest(page, pt.x, pt.y)
      .then((hit) => {
        // Drop already ended (this resolve lost the race) → don't resurrect the indicator.
        if (!hit || !dropDragActive.current) return;
        const screen = imageBoxToScreen({ x: hit.x, y: hit.y, w: hit.w, h: hit.h }, { width: rect.width, height: rect.height }, { width: vb.width, height: vb.height });
        if (screen) setDropHint({ page, top: screen.top });
      })
      .catch(() => {})
      .finally(() => { dropHintBusy.current = false; });
  }, [pageHostAt]);
  const clearDropHint = useCallback(() => { dropDragActive.current = false; setDropHint(null); }, []);

  const commitImageResize = useCallback((pageW: number, pageH: number) => {
    void enqueueEdit(async () => {
      const sel = imageSelRef.current;
      if (!sel || !canEditRef.current) return;
      // The overlay reports the new size in the SVG's px space; the op wants HWPUNIT.
      const w = Math.max(1, Math.round(pageW * HWPUNIT_PER_PX));
      const h = Math.max(1, Math.round(pageH * HWPUNIT_PER_PX));
      try {
        const pages = await api.setImageSize(sel.box.section, sel.box.block, w, h);
        setEdited(true);
        invalidate(pages, null); // keep scroll; clears caret + image selection
        reselectAfterRepaint(sel.page, sel.box.section, sel.box.block);
      } catch (err) {
        toast("warn", `크기 변경 실패: ${err}`);
      }
    });
  }, [enqueueEdit, invalidate, reselectAfterRepaint]);

  const commitImageMove = useCallback((dropClientX: number, dropClientY: number) => {
    void enqueueEdit(async () => {
      const sel = imageSelRef.current;
      if (!sel || !canEditRef.current) return;
      const from = sel.box.block;
      // Relocate the image to the block under the DROP point (own-engine hit-test). Dropping back on
      // itself (or a cross-section / off-page drop) is a no-op — just re-place the handles.
      const to = await resolveDropBlock(dropClientX, dropClientY, sel.box.section);
      if (to === null || to === from) { reselectAfterRepaint(sel.page, sel.box.section, from); return; }
      try {
        const pages = await api.moveImage(sel.box.section, from, to, Math.round(sel.box.w * HWPUNIT_PER_PX), Math.round(sel.box.h * HWPUNIT_PER_PX));
        setEdited(true);
        invalidate(pages, null);
        // MoveBlock removes at `from` then reinserts at the rebased `to`: the landed index is `to-1`
        // when moving down (the delete shifted it), else `to`. Re-place the handles there.
        const landed = to > from ? to - 1 : to;
        reselectAfterRepaint(sel.page, sel.box.section, landed);
      } catch (err) {
        toast("warn", `이동 실패: ${err}`);
      }
    });
  }, [enqueueEdit, invalidate, reselectAfterRepaint, resolveDropBlock]);

  // Delete the selected image block (Delete/Backspace on the overlay) — ONE undoable op, then drop the
  // selection. Mirrors 표 삭제 (commitTableDeleteTable).
  const commitImageDelete = useCallback(() => {
    void enqueueEdit(async () => {
      const sel = imageSelRef.current;
      if (!sel || !canEditRef.current) return;
      try {
        const pages = await api.deleteBlock(sel.box.section, sel.box.block);
        setEdited(true);
        invalidate(pages, null);
        setImageSel(null); // the image is gone — drop the selection
        toast("info", "이미지 삭제됨 (⌘Z로 되돌리기)");
      } catch (err) {
        toast("warn", `이미지 삭제 실패: ${err}`);
      }
    });
  }, [enqueueEdit, invalidate]);

  // Delete a pointed (pin) block — the empty-paragraph / 우클릭 삭제 / Backspace lane. Works for any
  // top-level block (paragraph/table/image) via DeleteBlock. Clears the pin (the block is gone).
  const deleteBlockAt = useCallback((section: number, block: number) => {
    void enqueueEdit(async () => {
      if (!canEditRef.current) return;
      try {
        const pages = await api.deleteBlock(section, block);
        setEdited(true);
        invalidate(pages, null);
        clearScope();
        toast("info", "블록 삭제됨 (⌘Z로 되돌리기)");
      } catch (err) {
        toast("warn", `삭제 실패: ${err}`);
      }
    });
  }, [enqueueEdit, invalidate, clearScope]);

  // Clear the active cell's text (Delete/Backspace on a single-click-selected cell — distinct from
  // deleting the whole table). Re-fetches the overlay/active-cell after the repaint.
  const clearActiveCellText = useCallback((c: ActiveCell) => {
    void enqueueEdit(async () => {
      if (!canEditRef.current) return;
      try {
        const pages = await api.setTableCell(c.section, c.block, c.row, c.col, "");
        setEdited(true);
        invalidate(pages, null);
        reselectTableAfterRepaint(c.page, c.section, c.block);
        toast("info", "칸 내용 지움 (⌘Z로 되돌리기)");
      } catch (err) {
        toast("warn", `${err}`);
      }
    });
  }, [enqueueEdit, invalidate, reselectTableAfterRepaint]);

  // ⌘C / ⌘V on the POINTED target (own-mode, not inline-editing — the inline <textarea> handles native
  // copy/paste). Targets the active CELL first, else the paragraph pin. Uses the OS clipboard via Rust
  // (the WKWebView clipboard read is unreliable). Both copy AND paste toast.
  const copyActiveText = useCallback(async () => {
    const c = activeCellRef.current;
    const p = scopePinRef.current;
    const text = c ? c.text : (p ? p.text : null);
    if (text === null) return;
    try {
      await api.clipboardWrite(text ?? "");
      toast("info", c ? "칸 복사됨" : "복사됨");
    } catch {
      toast("warn", "클립보드 복사 실패");
    }
  }, []);
  const pasteActiveText = useCallback(() => {
    const c = activeCellRef.current;
    const p = scopePinRef.current;
    if (!c && !(p && p.kind === "paragraph")) return;
    void (async () => {
      let text = "";
      try {
        text = await api.clipboardRead();
      } catch {
        toast("warn", "클립보드 읽기 실패");
        return;
      }
      if (!text) return;
      void enqueueEdit(async () => {
        if (!canEditRef.current) return;
        try {
          if (c) {
            const pages = await api.setTableCell(c.section, c.block, c.row, c.col, text);
            setEdited(true);
            invalidate(pages, null);
            reselectTableAfterRepaint(c.page, c.section, c.block);
            toast("info", "칸에 붙여넣음");
          } else if (p) {
            const pages = await api.setParagraphText(p.section, p.block, text);
            setEdited(true);
            invalidate(pages, null);
            toast("info", "붙여넣음");
          }
        } catch (err) {
          toast("warn", `${err}`);
        }
      });
    })();
  }, [enqueueEdit, invalidate, reselectTableAfterRepaint]);

  // own-mode keyboard lane for the POINTED target (active cell OR paragraph pin): ⌘C copy · ⌘V paste ·
  // Backspace/Delete (clear cell / delete block). Gated so it never fires while typing (inline editor /
  // chat / any input), composing (IME), a modal is open, or an image/table overlay owns the gesture.
  useEffect(() => {
    if (!scopePin && !activeCell) return;
    const isTyping = () => {
      if (inlineEditRef.current || composingRef.current) return true;
      const el = document.activeElement as HTMLElement | null;
      return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
    };
    const onKey = (e: KeyboardEvent) => {
      if (viewModeRef.current !== "own" || isTyping() || modalOpenRef.current) return;
      if (e.key === "Escape") { setActiveCell(null); clearScope(); return; }
      const mod = e.metaKey || e.ctrlKey;
      if (mod && (e.key === "c" || e.key === "C")) {
        if (window.getSelection()?.toString()) return; // don't hijack a real text selection copy
        e.preventDefault();
        void copyActiveText();
      } else if (mod && (e.key === "v" || e.key === "V")) {
        e.preventDefault();
        pasteActiveText();
      } else if (!mod && (e.key === "Backspace" || e.key === "Delete")) {
        const c = activeCellRef.current;
        if (c) { e.preventDefault(); clearActiveCellText(c); return; } // clear the cell, NOT the table
        if (imageSelRef.current || tableSelRef.current) return; // the overlay owns its own delete
        const p = scopePinRef.current;
        if (p) { e.preventDefault(); deleteBlockAt(p.section, p.block); }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [scopePin, activeCell, copyActiveText, pasteActiveText, clearActiveCellText, deleteBlockAt, clearScope]);

  // ---- table overlay: commit (one undoable op), then re-place the overlay on the table. Mirrors the
  // image overlay lane (reselectAfterRepaint / commitImageMove) but commits via MoveBlock + table ops.
  // (reselectTableAfterRepaint is declared earlier, next to reselectAfterRepaint.)
  const commitTableMove = useCallback((dropClientX: number, dropClientY: number) => {
    void enqueueEdit(async () => {
      const sel = tableSelRef.current;
      if (!sel || !canEditRef.current) return;
      const from = sel.box.block;
      // Relocate the table to the block under the DROP point (own-engine hit-test) — drops WHERE you
      // point, not a fixed ±1 nudge. Dropping back on itself / off-page / cross-section is a no-op.
      const to = await resolveDropBlock(dropClientX, dropClientY, sel.box.section);
      if (to === null || to === from) { reselectTableAfterRepaint(sel.page, sel.box.section, from); return; }
      try {
        const pages = await api.moveTable(sel.box.section, from, to);
        setEdited(true);
        invalidate(pages, null);
        // Where the table landed after removal: moving down → to-1 (delete shifted it), else `to`.
        const landed = to > from ? to - 1 : to;
        reselectTableAfterRepaint(sel.page, sel.box.section, landed);
      } catch (err) {
        toast("warn", `표 이동 실패: ${err}`);
      }
    });
  }, [enqueueEdit, invalidate, reselectTableAfterRepaint, resolveDropBlock]);

  const commitTableAddRow = useCallback(() => {
    void enqueueEdit(async () => {
      const sel = tableSelRef.current;
      if (!sel || !canEditRef.current) return;
      try {
        // Append one empty body row that REPLICATES the table's last-row column layout (merge-safe) —
        // a naive cols-cell row breaks tables with merged columns.
        const pages = await api.appendTableRow(sel.box.section, sel.box.block);
        setEdited(true);
        invalidate(pages, null);
        reselectTableAfterRepaint(sel.page, sel.box.section, sel.box.block);
      } catch (err) {
        toast("warn", `행 추가 실패: ${err}`);
      }
    });
  }, [enqueueEdit, invalidate, reselectTableAfterRepaint]);

  // Apply/clear a background color to the active cell's ROW / COLUMN / the CELL / ALL of the table
  // (SetTableCellShade). Row/col come from the single-click active cell (the palette is gated on one).
  const commitShade = useCallback((sel: "row" | "col" | "cell" | "all", color: string | null) => {
    // SNAPSHOT the target NOW, synchronously — refs are live at click time. The swatch button
    // preventDefaults its mousedown so it does NOT blur the editor, which means activeCell is still set
    // here (invalidate() would otherwise null it AND disable the swatch before the click lands). Also
    // grab the open editor's current text so a shade doesn't discard an in-progress cell edit.
    const a = activeCellRef.current;
    if (!a) return;
    const ie = inlineEditRef.current;
    const editorEl = ie && ie.kind === "cell" ? (document.querySelector("[data-inline-edit]") as HTMLElement | null) : null;
    const liveRuns = editorEl && ie ? serializeEditor(editorEl, ie.scale) : null;
    void enqueueEdit(async () => {
      if (!canEditRef.current) return;
      try {
        // 1) Commit the cell's STYLED runs FIRST (only if changed) so the shade repaint doesn't drop an
        //    in-progress edit; close the editor so its now-stale box doesn't linger.
        if (ie && ie.kind === "cell" && liveRuns && !runsUnchanged(liveRuns, ie.runs)) {
          inlineClosedRef.current = true;
          setInlineEdit(null);
          await api.setTableCellRuns(ie.section, ie.block, ie.row ?? 0, ie.col ?? 0, liveRuns);
        }
        // 2) Apply the shade to the focused cell (table anchor + row/col from activeCell).
        const pages = await api.setTableCellShade(a.section, a.block, sel, a.row, a.col, color);
        setEdited(true);
        invalidate(pages, null);
        reselectTableAfterRepaint(a.page, a.section, a.block);
        // Re-establish the active-cell ring after the repaint (shading doesn't move cells, so the stored
        // box is still valid) — so a follow-up 배경색 keeps targeting the same cell, not the header.
        whenPagePainted(a.page, () => {
          const svg = svgForPage(a.page);
          if (!svg) return;
          const rect = svg.getBoundingClientRect();
          const vb = svg.viewBox.baseVal;
          const screen = imageBoxToScreen(a.box, { width: rect.width, height: rect.height }, { width: vb.width, height: vb.height });
          if (screen) setActiveCell({ ...a, screen });
        });
        toast("info", color ? "배경색 적용됨" : "배경색 지움");
      } catch (err) {
        toast("warn", `배경색 변경 실패: ${err}`);
      }
    });
  }, [enqueueEdit, invalidate, reselectTableAfterRepaint, whenPagePainted]);

  // ---- Manual character format (볼드/이태릭/크기/글꼴) ----
  // The format TARGET is the focused cell (activeCell), else a pointed PARAGRAPH (scopePin). The bar
  // applies to the WHOLE target (own-render has no sub-cell caret yet — partial selection is v2).
  const [charFmtState, setCharFmtState] = useState<CharFmt | null>(null);
  const charFmtStateRef = useRef<CharFmt | null>(null);
  charFmtStateRef.current = charFmtState;
  const fmtTarget = useMemo(() => {
    if (activeCell) {
      return { section: activeCell.section, block: activeCell.block, row: activeCell.row as number | null, col: activeCell.col as number | null, page: activeCell.page, screen: activeCell.screen };
    }
    if (scopePin && scopePin.kind === "paragraph") {
      return { section: scopePin.section, block: scopePin.block, row: null as number | null, col: null as number | null, page: scopePin.page, screen: scopePin.screen };
    }
    return null;
  }, [activeCell, scopePin]);
  const fmtTargetRef = useRef(fmtTarget);
  fmtTargetRef.current = fmtTarget;
  // Fetch the target's current format when its identity changes (own mode only) so the bar shows the
  // right B/I/size/font + toggles correctly.
  useEffect(() => {
    if (!fmtTarget || viewModeRef.current !== "own") { setCharFmtState(null); return; }
    let cancelled = false;
    api.charFmt(fmtTarget.section, fmtTarget.block, fmtTarget.row, fmtTarget.col)
      .then((f) => { if (!cancelled) setCharFmtState(f); })
      .catch(() => { if (!cancelled) setCharFmtState(null); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fmtTarget?.section, fmtTarget?.block, fmtTarget?.row, fmtTarget?.col, viewMode]);

  // Re-place the active-cell ring from the FRESH cell geometry after a repaint (the row may have GROWN
  // from a size change — reusing the pre-edit box left the bigger text poking out of a stale ring).
  const reselectCellAfterRepaint = useCallback((section: number, block: number, row: number, col: number) => {
    whenPagePainted(activeCellRef.current?.page ?? 0, () => {
      void (async () => {
        try {
          const box = await api.tableCellBox(section, block, row, col);
          if (!box) return;
          const svg = svgForPage(box.page);
          if (!svg) return;
          const rect = svg.getBoundingClientRect();
          const vb = svg.viewBox.baseVal;
          const b = { x: box.x, y: box.y, w: box.w, h: box.h };
          const screen = imageBoxToScreen(b, { width: rect.width, height: rect.height }, { width: vb.width, height: vb.height });
          const a = activeCellRef.current;
          if (screen && a) setActiveCell({ ...a, page: box.page, box: b, screen });
        } catch { /* ring just won't re-show */ }
      })();
    });
  }, [whenPagePainted]);

  const commitCharFmt = useCallback((patch: { bold?: boolean; italic?: boolean; sizePt?: number; font?: string }) => {
    const t = fmtTargetRef.current;
    if (!t) return;
    const pin = scopePinRef.current; // paragraph pin to re-establish after the repaint
    const ie = inlineEditRef.current;
    // Are we inline-editing THIS exact target? If so, apply to the IR but DEFER the SVG repaint — the
    // open textarea occludes the (now-stale) page, so repainting only closes the editor + flickers
    // without showing anything (the textarea is plain). The deferred repaint runs on commit/cancel.
    const editingHere = !!ie && (
      (t.row != null && ie.kind === "cell" && ie.section === t.section && ie.block === t.block && ie.row === t.row && ie.col === t.col) ||
      (t.row == null && ie.kind === "para" && ie.section === t.section && ie.block === t.block)
    );
    // Optimistic: reflect the patch in the ribbon immediately (so B/I toggles light up).
    setCharFmtState((prev) => (prev ? {
      bold: patch.bold ?? prev.bold,
      italic: patch.italic ?? prev.italic,
      size_pt: patch.sizePt ?? prev.size_pt,
      font: patch.font !== undefined ? (patch.font || null) : prev.font,
    } : prev));
    void enqueueEdit(async () => {
      if (!canEditRef.current) return;
      try {
        const pages = await api.setCharFmt(t.section, t.block, t.row, t.col, patch);
        setEdited(true);
        if (editingHere) {
          // SMOOTH path: leave the editor mounted + focused; mark the page stale so commit/cancel repaints.
          // (A later text commit rebuilds the cell runs preserving this shape, so the format survives.)
          fmtDeferredRef.current = true;
          return;
        }
        invalidate(pages, null);
        if (t.row != null && t.col != null) {
          reselectTableAfterRepaint(t.page, t.section, t.block);
          reselectCellAfterRepaint(t.section, t.block, t.row, t.col); // fresh-box ring (handles grown row)
        } else if (pin) {
          whenPagePainted(t.page, () => recomputeScopePin(pin.page, pin.section, pin.block, pin.box, pin.kind, pin.text));
        }
      } catch (err) {
        toast("warn", `서식 변경 실패: ${err}`);
      }
    });
  }, [enqueueEdit, invalidate, reselectTableAfterRepaint, reselectCellAfterRepaint, whenPagePainted, recomputeScopePin]);

  // Wire the deferred-repaint flusher (used by commit/cancel after a mid-edit format): repaint the own
  // page in place (no editor unmount) + re-place the cell ring from the fresh box. Assigned to a ref so
  // the early-declared cancelInlineEdit/commitInlineEdit can call it without a declaration-order cycle.
  flushDeferredRepaint.current = () => {
    if (viewModeRef.current !== "own") return;
    ownRefreshRef.current = refreshOwnPages();
    void loadOwnPageCount();
    const a = activeCellRef.current;
    if (a) reselectCellAfterRepaint(a.section, a.block, a.row, a.col);
  };

  // (⌘B/⌘I and the ribbon now style the LIVE contentEditable selection via applyLiveStyle — visible
  // immediately, serialized to runs on commit. The old range op + the deferred-repaint machinery are
  // retired; whole-target format on a NON-editing cell/paragraph still goes through commitCharFmt.)

  const commitTableDeleteTable = useCallback(() => {
    void enqueueEdit(async () => {
      const sel = tableSelRef.current;
      if (!sel || !canEditRef.current) return;
      try {
        const pages = await api.deleteBlock(sel.box.section, sel.box.block);
        setEdited(true);
        invalidate(pages, null);
        setTableSel(null); // the table is gone — drop the selection
      } catch (err) {
        toast("warn", `표 삭제 실패: ${err}`);
      }
    });
  }, [enqueueEdit, invalidate]);

  // Column resize commit: fractional boundaries → integer column-width proportions (min 1), one undo
  // unit (SetTableColWidths). The renderer rescales the proportions to the body width.
  const commitTableColWidths = useCallback((fracs: number[]) => {
    void enqueueEdit(async () => {
      const sel = tableSelRef.current;
      if (!sel || !canEditRef.current) return;
      const widths: number[] = [];
      for (let c = 0; c < sel.box.cols; c++) {
        widths.push(Math.max(1, Math.round((fracs[c + 1] - fracs[c]) * 1000)));
      }
      try {
        const pages = await api.setTableColWidths(sel.box.section, sel.box.block, widths);
        setEdited(true);
        invalidate(pages, null);
        reselectTableAfterRepaint(sel.page, sel.box.section, sel.box.block);
      } catch (err) {
        toast("warn", `열 너비 변경 실패: ${err}`);
      }
    });
  }, [enqueueEdit, invalidate, reselectTableAfterRepaint]);

  // Row resize commit: fractional row boundaries → per-row MIN-height overrides (HWPUNIT), one undo
  // unit (SetTableRowHeights). Pins each row to its current displayed height (box.h is own-engine px,
  // ×HWPUNIT_PER_PX = HWPUNIT) with the dragged boundary moved. The override is a FLOOR, so a row never
  // clips below its content — dragging GROWS a row (e.g. a taller header); it can't shrink below text.
  const commitTableRowHeights = useCallback((fracs: number[]) => {
    void enqueueEdit(async () => {
      const sel = tableSelRef.current;
      if (!sel || !canEditRef.current) return;
      // `fracs` has one entry per row boundary of the SELECTED box. For a table split across pages the
      // overlay box is a per-page FRAGMENT (fewer boundaries than the whole table), so row-resize on a
      // split table isn't supported yet — bail with a toast rather than send a wrong-length op (the
      // op validates heights.len()==rows). The common single-page table has fracs.length == rows+1.
      if (fracs.length !== sel.box.rows + 1) {
        toast("info", "여러 페이지로 나뉜 표는 아직 행 높이 조정을 지원하지 않아요");
        return;
      }
      const total = sel.box.h * HWPUNIT_PER_PX; // table height in HWPUNIT
      const heights: number[] = [];
      for (let rr = 0; rr < sel.box.rows; rr++) {
        heights.push(Math.max(1, Math.round((fracs[rr + 1] - fracs[rr]) * total)));
      }
      try {
        const pages = await api.setTableRowHeights(sel.box.section, sel.box.block, heights);
        setEdited(true);
        invalidate(pages, null);
        reselectTableAfterRepaint(sel.page, sel.box.section, sel.box.block);
      } catch (err) {
        toast("warn", `행 높이 변경 실패: ${err}`);
      }
    });
  }, [enqueueEdit, invalidate, reselectTableAfterRepaint]);

  // The 칸 편집 toolbar button → open the INLINE editor over the selected table's first cell (the
  // double-click path is the primary one; this is the discoverable button). Resolves the cell rect via
  // the own-engine geometry at the table's top-left so the box lands on the real first cell.
  const openCellEditor = useCallback(() => {
    const sel = tableSelRef.current;
    if (!sel) return;
    const svg = svgForPage(sel.page);
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const vb = svg.viewBox.baseVal;
    const dim = { width: rect.width, height: rect.height };
    const vbd = { width: vb.width, height: vb.height };
    void (async () => {
      try {
        // A point just inside the table's top-left → its first cell.
        const cell = await api.tableCellAt(sel.page, sel.box.x + 2, sel.box.y + 2);
        if (!cell) return;
        const box = { x: cell.x, y: cell.y, w: cell.w, h: cell.h };
        const screen = imageBoxToScreen(box, dim, vbd);
        if (screen) {
          recomputeActiveCell(sel.page, cell); // focused cell = shading reference (see onPageDoubleClick)
          const scale = dim.width / vbd.width;
          const runs = await api.getBlockRuns(cell.section, cell.block, cell.row, cell.col).catch(() => [{ text: cell.text }]);
          openInlineEdit({ kind: "cell", page: sel.page, section: cell.section, block: cell.block, row: cell.row, col: cell.col, text: cell.text, runs, scale, box, screen });
        }
      } catch { /* ignore */ }
    })();
  }, []);

  // Commit the inline editor (cell or paragraph) as ONE undo unit, then re-place the table overlay. An
  // empty paragraph stays editable; a structural-paragraph refusal is surfaced as a toast.
  // Takes the EXACT target `ie` the value came from (captured in the textarea's render closure) — NOT
  // inlineEditRef — so a value can never be paired with a different cell's address (the A→B overwrite
  // bug: switching cells reused the uncontrolled textarea, leaving the ref pointing at B while the value
  // was still A's). The textarea is also keyed per-address so it remounts fresh on a cell switch.
  // Commit the WYSIWYG editor: SERIALIZE the contentEditable DOM → styled runs (RunDto[]) and write them
  // back, preserving per-run bold/italic/size/color/font (no run-collapse). The blur/Enter handlers pass
  // the already-serialized runs (captured from the live DOM at the exact moment of commit).
  const commitInlineEdit = useCallback((ie: InlineEdit, runs: RunDto[]) => {
    if (!ie || inlineClosedRef.current) return; // already committed/cancelled (e.g. the unmount blur)
    inlineClosedRef.current = true;
    setInlineEdit(null);
    fmtDeferredRef.current = false;
    // NO-OP short-circuit: nothing changed (text AND styling identical) → skip the op + repaint.
    if (runsUnchanged(runs, ie.runs)) return;
    void enqueueEdit(async () => {
      if (!canEditRef.current) return;
      try {
        if (ie.kind === "cell") {
          const pages = await api.setTableCellRuns(ie.section, ie.block, ie.row ?? 0, ie.col ?? 0, runs);
          setEdited(true);
          invalidate(pages, null);
          reselectTableAfterRepaint(tableSelRef.current?.page ?? ie.page, ie.section, ie.block);
        } else {
          const pages = await api.setParagraphRuns(ie.section, ie.block, runs);
          setEdited(true);
          invalidate(pages, null);
        }
      } catch (err) {
        toast("warn", `${err}`);
      }
    });
  }, [enqueueEdit, invalidate, reselectTableAfterRepaint]);

  // Serialize the live contentEditable, then commit (blur/Enter/✓). Reads the DOM at call time so the
  // value can never be paired with a stale snapshot.
  const commitInlineEditFromDom = useCallback((ie: InlineEdit) => {
    const el = document.querySelector("[data-inline-edit]") as HTMLElement | null;
    const runs = el ? serializeEditor(el, ie.scale) : ie.runs;
    commitInlineEdit(ie, runs);
  }, [commitInlineEdit]);

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
      setPending(null); // drop any stale inline proposal from a previous document
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
    setPending(null); // an undo changes the doc shape under any pending proposal — drop it
    invalidate(await api.undo(), null); // keep scroll — undo must not yank the view to page 1
    toast("info", "실행 취소");
  }, [invalidate]);
  const doRedo = useCallback(async () => {
    if (pageCountRef.current === 0) return;
    invalidate(await api.redo(), null); // keep scroll
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
    // The image + table overlays + the scope pin only exist in 'own' mode — drop them when leaving it.
    if (next !== "own") {
      clearImageSel();
      clearTableSel();
      setScopePin(null);
      setActiveCell(null);
      setInlineEdit(null);
    }
    if (next === "html") void loadDocHtml();
    else if (next === "own") void loadOwnPageCount();
  }, [loadDocHtml, loadOwnPageCount, clearImageSel, clearTableSel]);

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

  // Scroll the page list to a 0-based page index (the chat's jump-to-block link + the inline pending
  // band reuse this to bring the target into view). Clamps to the active list's bounds.
  const scrollToPage = useCallback((page: number) => {
    if (listCountRef.current === 0) return;
    const idx = Math.max(0, Math.min(page, listCountRef.current - 1));
    virtualizer.scrollToIndex(idx, { align: "center" });
  }, [virtualizer]);

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

  // Lift a returned (dry-run) proposal into the INLINE pending state: anchor it to the pointed page
  // (or the page currently in view), remember the primary op's (section, block) for ✎다시, then scroll
  // it into view so the "제안됨" band is visible — reusing the same scroll path the commit flow uses.
  const liftToPending = useCallback((proposal: Proposal, page: number | null) => {
    const primary = proposal.ops.find((o) => o.section !== null) ?? proposal.ops[0];
    const at = page ?? Math.max(0, (virtualizer.getVirtualItems()[0]?.index ?? 0));
    setPending({
      ops: proposal.ops,
      provider: proposal.provider,
      rationale: proposal.rationale,
      page: at,
      section: primary?.section ?? null,
      block: primary?.block ?? null,
    });
    queueMicrotask(() => scrollToPage(at));
  }, [virtualizer, scrollToPage]);

  // The vibe-docs chat: propose anchored edits (dry-run, optionally scoped to a clicked target). Each
  // proposal is lifted into the INLINE pending state (review ON the document) AND returned for the chat
  // card. 적용 commits through the same op-bus; on apply, scroll to the pointed page (or stay put) and
  // clear the spent scope + the inline pending state.
  const chatCtx = useMemo(
    () => ({
      propose: async (instruction: string, scopeArg: Scope | null) => {
        const p = await api.aiEdit(instruction, scopeArg ? { section: scopeArg.section, block: scopeArg.block } : undefined);
        liftToPending(p, scopeArg ? scopeArg.page : null);
        return p;
      },
      insertImage: async (name: string, dataB64: string, scopeArg: Scope | null, widthMm: number, heightMm: number) => {
        const p = await api.insertImage(name, dataB64, scopeArg ? { section: scopeArg.section, block: scopeArg.block } : null, widthMm, heightMm);
        liftToPending(p, scopeArg ? scopeArg.page : null);
        return p;
      },
      commit: async () => {
        const landed = scopeRef.current ? scopeRef.current.page : (pendingRef.current?.page ?? null);
        const n = await api.commitProposal();
        setEdited(true);
        invalidate(n, landed);
        setScope(null);
        setPending(null); // the proposal settled INTO the doc — drop the inline pending state
        // Flash a highlight pulse on the page the edit landed on (after the re-render settles).
        if (landed !== null) queueMicrotask(() => pulse(landed));
      },
      discard: async () => {
        await api.discardProposal();
        setPending(null);
      },
    }),
    [invalidate, pulse, liftToPending],
  );
  // pending read inside the (stable) chatCtx.commit closure needs the latest value.
  const pendingRef = useRef(pending);
  pendingRef.current = pending;

  // Settle the chat's mirrored card when the user acts on the INLINE toolbar (so both surfaces stay
  // in sync). Bumps a monotonic signal Chat watches; the card flips to ✓적용됨 / 취소됨.
  const signalSettle = useCallback((state: "applied" | "discarded") => {
    settleSeq.current += 1;
    setPendingSettle({ n: settleSeq.current, state });
  }, []);

  // ---- INLINE pending review actions (the ✓확정 / ✕취소 / ✎다시 toolbar on the document) ----
  // ✓ 확정: commit the pending proposal through the SAME op-bus the chat card uses.
  const confirmPending = useCallback(() => {
    setPendingBusy(true);
    void chatCtx.commit()
      .then(() => signalSettle("applied"))
      .catch((e) => toast("warn", `적용 실패: ${e}`))
      .finally(() => setPendingBusy(false));
  }, [chatCtx, signalSettle]);
  // ✕ 취소: discard the pending proposal (drops it on the Rust session too).
  const rejectPending = useCallback(() => {
    setPendingBusy(true);
    void chatCtx.discard()
      .then(() => signalSettle("discarded"))
      .catch(() => {})
      .finally(() => setPendingBusy(false));
  }, [chatCtx, signalSettle]);
  // ✎ 다시: keep the proposal pending, but re-open the chat scoped to the changed block so the user
  // can type more feedback / fill content ("이 표 채워줘"). Seeds the scope chip + focuses the panel.
  const refinePending = useCallback(() => {
    const p = pendingRef.current;
    if (!p) return;
    if (p.section !== null) setScope({ section: p.section, block: p.block, page: p.page });
    setChatOpen(true);
  }, []);

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
      "$mod+Backslash": (e) => { e.preventDefault(); setOutlineOpen((o) => !o); },
      "$mod+Slash": (e) => { e.preventDefault(); setCheatOpen((o) => !o); },
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
          setPending(null); // an out-of-band mutation can invalidate a pending proposal's anchors
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
          // The page the insert actually anchored to — drives the post-insert scroll/pulse so the view
          // follows where the image LANDED (the drop page on a hit, else the fallback scope's page).
          let landedPage: number | null = null;
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
                // Own-render uses the own-engine point→block resolver (rhwp geometry doesn't apply to
                // OUR SVG — that mismatch is exactly why drops used to miss and pile up at the doc end).
                const hit = viewModeRef.current === "own"
                  ? await api.ownHitTest(page, pt.x, pt.y)
                  : await api.hitTest(page, pt.x, pt.y);
                if (hit) { scopeArg = { section: hit.section, block: hit.block }; landedPage = page; }
              } catch {
                /* hit-test miss → fall through to the scope/end fallback below */
              }
            }
          }
          if (!scopeArg && scopeRef.current) {
            scopeArg = { section: scopeRef.current.section, block: scopeRef.current.block };
            landedPage = scopeRef.current.page;
          }
          // ONE undoable op, applied immediately (no propose→review) — the direct-manipulation contract.
          const n = await api.applyImageDrop(imgs[0], scopeArg);
          setEdited(true);
          // Scroll to where the image actually landed (the drop page / fallback-scope page); a pure
          // doc-end append (no anchor) keeps the scroll put (null) so the view doesn't yank to the end.
          invalidate(n, landedPage);
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
  // Robustness for the INLINE pending band: the on-page band only mounts when the target page is in
  // the virtual window AND we're in an SVG mode (the HTML iframe can't host the overlay). When it
  // isn't (HTML mode, or the user scrolled the target off-screen), show a sticky fallback bar so the
  // ✓확정/✕취소/✎다시 controls are NEVER lost — clicking ↪ scrolls the band back into view.
  const pendingPageVisible =
    pending !== null &&
    viewMode !== "html" &&
    virtualizer.getVirtualItems().some((v) => v.index === pending.page);
  // Go-to-page: clamp to [1, listCount], scroll, sync the input. Empty/NaN input is a no-op.
  const goToPage = useCallback((oneBased: number) => {
    if (listCount === 0 || !Number.isFinite(oneBased)) return;
    const idx = Math.max(0, Math.min(Math.round(oneBased) - 1, listCount - 1));
    virtualizer.scrollToIndex(idx, { align: "start" });
    setGotoText("");
  }, [virtualizer, listCount]);

  return (
    <div className="relative flex h-full flex-col bg-neutral-100 text-neutral-900 dark:bg-neutral-900 dark:text-neutral-100">
      <header
        data-tauri-drag-region
        className="flex h-11 shrink-0 items-center gap-2 border-b border-black/10 bg-neutral-50/70 pl-24 pr-3 backdrop-blur-xl dark:border-white/10 dark:bg-neutral-800/60"
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
        {pageCount > 0 && (
          <IconButton onClick={() => setOutlineOpen((o) => !o)} title="문서 개요 (⌘\\)" active={outlineOpen}>
            ☰ 개요
          </IconButton>
        )}
        {canEdit && (
          <IconButton onClick={() => setChatOpen((o) => !o)} title="AI 바이브 편집 (⌘L)" active={chatOpen} tone="ai">
            ✦ 바이브 <kbd className="rounded bg-black/5 px-1 dark:bg-white/10">⌘L</kbd>
          </IconButton>
        )}
        <IconButton onClick={() => setPaletteOpen(true)} title="명령 팔레트 (⌘K)">
          명령 <kbd className="rounded bg-black/5 px-1 dark:bg-white/10">⌘K</kbd>
        </IconButton>
      </header>

      {pageCount > 0 && (
        <div className="flex h-10 shrink-0 items-center gap-0.5 border-b border-black/10 bg-neutral-50/40 px-2 dark:border-white/10 dark:bg-neutral-800/30">
          <Button onClick={doOpen} icon="📂" label="열기" keys="⌘O" />
          <Button onClick={doExport} icon="⬇︎" label="HWPX" keys="⌘S" />
          <Button onClick={doExportHtml} icon="🅷" label="HTML" />
          <Button onClick={doExportPdf} icon="📄" label="PDF" />
          <Sep />
          <Button onClick={() => setChatOpen((o) => !o)} icon="✦" label="바이브 편집" tone="ai" keys="⌘L" disabled={!canEdit} />
          <Button onClick={() => setComposer("table")} icon="▦" label="표" keys="⌘T" disabled={!canEdit} />
          <Sep />
          {/* View surface: 원본(rhwp layout-preserve) · HTML(JSX/CSS pivot) · 자체 렌더(OUR engine).
              원본 is disabled once edited (rhwp can't re-render edits); the other two render the live IR. */}
          <SegmentedControl
            value={viewMode}
            onChange={setMode}
            segments={[
              { value: "svg", label: "원본", icon: "🖹", title: "원본 보기 (rhwp · 레이아웃 보존)", disabled: edited },
              { value: "html", label: "HTML", icon: "🅷", title: "HTML 미리보기 (JSX/CSS · 내보내기와 동일)" },
              { value: "own", label: "자체 렌더", icon: "◈", title: "자체 렌더 (우리 엔진 · place_doc → SVG)" },
            ]}
          />
          <Sep />
          <Button onClick={doUndo} icon="↩︎" label="실행취소" keys="⌘Z" disabled={!canEdit} />
          <Button onClick={doRedo} icon="↪︎" label="다시실행" disabled={!canEdit} />
        </div>
      )}

      {/* EDIT RIBBON (own-render) — a PERSISTENT format toolbar at the TOP, like a normal document
          editor, so formatting + save/cancel never float over the text being edited / drag-selected
          (the old floating bars obscured the content). Always present in 편집 mode so selecting a cell
          doesn't shift the page (which would also stale the overlay positions); its CONTENT is
          contextual: format controls for the focused cell/paragraph, save/cancel while inline-editing. */}
      {viewMode === "own" && canEdit && pageCount > 0 && (
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-black/10 bg-neutral-50/40 px-3 text-xs dark:border-white/10 dark:bg-neutral-800/30">
          {charFmtState && fmtTarget ? (
            <>
              <span className="shrink-0 font-medium text-neutral-600 dark:text-neutral-300">
                {inlineEdit ? "✏️ 편집 중" : "✦ 서식"}
                {fmtTarget.row != null ? ` · ${fmtTarget.row + 1}행 ${(fmtTarget.col ?? 0) + 1}열` : " · 문단"}
              </span>
              <span className="h-4 w-px bg-black/10 dark:bg-white/10" />
              {/* While EDITING, the ribbon styles the LIVE contentEditable selection (visible now);
                  otherwise it applies a whole-target format op to the clicked cell/paragraph. */}
              <FormatControls
                fmt={charFmtState}
                onPatch={(p) => { if (inlineEditRef.current) applyLiveStyle(p, inlineEditRef.current.scale); else commitCharFmt(p); }}
              />
            </>
          ) : (
            <span className="text-neutral-400">칸이나 문단을 클릭하면 글자 서식(굵게·기울임·크기·글꼴)을 바꿀 수 있어요</span>
          )}
          {inlineEdit && (
            <div className="ml-auto flex shrink-0 items-center gap-1.5">
              <span className="hidden text-neutral-400 lg:inline">드래그 선택 후 ⌘B/⌘I · ↵ 저장 · ⇧↵ 줄바꿈 · esc 취소</span>
              <button
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => { const ie = inlineEditRef.current; if (ie) commitInlineEditFromDom(ie); }}
                className="rounded bg-accent px-2.5 py-1 font-medium text-white hover:bg-accent/90"
              >✓ 저장</button>
              <button
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => cancelInlineEdit()}
                className="rounded px-2 py-1 text-neutral-600 hover:bg-black/5 dark:text-neutral-300 dark:hover:bg-white/10"
              >취소</button>
            </div>
          )}
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
        {/* U4: document outline (left nav) — read-only orientation; click a heading → scroll its page. */}
        {outlineOpen && pageCount > 0 && (
          <aside className="flex w-56 shrink-0 flex-col border-r border-black/10 bg-neutral-50/60 dark:border-white/10 dark:bg-neutral-900/40">
            <div className="flex h-9 shrink-0 items-center justify-between px-3 text-xs font-medium text-neutral-500 dark:text-neutral-400">
              <span>문서 개요</span>
              <button onClick={() => setOutlineOpen(false)} title="닫기 (⌘\\)" className="rounded px-1 text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200">✕</button>
            </div>
            <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
              {outline.length === 0 ? (
                <p className="px-2 py-1 text-xs text-neutral-400">개요 항목이 없습니다</p>
              ) : (
                outline.map((it, i) => (
                  <button
                    key={`${it.section}-${it.block}-${i}`}
                    onClick={() => scrollToPage(it.page)}
                    title={`${it.text} · ${it.page + 1}쪽`}
                    className="flex w-full items-baseline gap-2 truncate rounded-md px-2 py-1 text-left text-xs text-neutral-700 hover:bg-black/5 dark:text-neutral-300 dark:hover:bg-white/10"
                    style={{ paddingLeft: `${0.5 + (it.level - 1) * 0.75}rem` }}
                  >
                    <span className="truncate">{it.text}</span>
                    <span className="ml-auto shrink-0 tabular-nums text-[10px] text-neutral-400">{it.page + 1}</span>
                  </button>
                ))
              )}
            </nav>
          </aside>
        )}
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
          {/* Discoverability: a one-time hint that the document is directly editable (the manual-edit
              gestures are otherwise hidden). Dismissed forever via localStorage. Editing stays
              chat-primary — this just points at the quieter manual paths. */}
          {pageCount > 0 && canEdit && !hintSeen && (
            <div className="mx-auto mb-4 flex max-w-2xl items-start gap-3 rounded-lg border border-black/10 bg-neutral-50/90 px-4 py-3 text-sm shadow-sm ring-1 ring-black/5 backdrop-blur dark:border-white/10 dark:bg-neutral-800/90">
              <span className="mt-0.5 text-base leading-none text-ai" aria-hidden>✦</span>
              <div className="min-w-0 flex-1 text-neutral-600 dark:text-neutral-300">
                <p className="font-medium text-neutral-800 dark:text-neutral-100">직접 편집할 수 있어요</p>
                <p className="mt-1 leading-relaxed">
                  <span className="text-neutral-800 dark:text-neutral-100">✦ 바이브 편집</span>이 가장 빠른 길이에요.
                  세부 조정은 <span className="font-medium">블록을 클릭해 입력</span> ·
                  <span className="font-medium"> 우클릭 / ⋯</span>으로 빠른 작업 ·
                  <span className="font-medium"> 이미지 드래그&드롭</span>으로 삽입하세요.
                  <button onClick={() => setCheatOpen(true)} className="ml-1 text-accent underline-offset-2 hover:underline">단축키 (⌘/)</button>
                </p>
              </div>
              <button
                onClick={dismissHint}
                title="다시 보지 않기"
                className="shrink-0 rounded px-1.5 py-0.5 text-xs text-neutral-400 hover:bg-black/5 hover:text-neutral-600 dark:hover:bg-white/10 dark:hover:text-neutral-200"
              >
                알겠어요 ✕
              </button>
            </div>
          )}
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
              onDoubleClick={(e) => void onPageDoubleClick(e)}
              onContextMenu={(e) => void onPageContextMenu(e)}
            >
              {virtualizer.getVirtualItems().map((item) => {
                void (viewMode === "own" ? ensureOwnPage(item.index) : ensurePage(item.index));
                if (viewMode === "own") void ensurePageGeom(item.index);
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
                      className="group relative w-full rounded-lg bg-white shadow-md ring-1 ring-black/5"
                      // Zoom-derived intrinsic height (was a fixed 920px) so off-screen pages reserve
                      // the right space before their SVG paints.
                      style={{ contentVisibility: "auto", containIntrinsicSize: `auto ${Math.round(pageHeight)}px` }}
                    >
                      {/* Discoverability: a subtle ⋯ 편집 grip that fades in on hover (editable SVG
                          modes) so the point-action popover — click-to-edit / AI 편집 / 이미지 삽입 —
                          isn't hidden behind right-click only. Keeps chat the primary path; this is a
                          quiet margin affordance, not a Notion block toolbar. */}
                      {canEdit && viewMode !== "html" && pageSvg !== undefined && (
                        <button
                          type="button"
                          onClick={onEditHandle}
                          title="빠른 편집 (또는 우클릭)"
                          className="absolute right-2 top-2 z-30 flex items-center gap-1 rounded-token border border-black/10 bg-white/90 px-2 py-1 text-[11px] text-neutral-500 opacity-0 shadow-sm backdrop-blur transition-opacity hover:bg-neutral-100 hover:text-neutral-800 focus-visible:opacity-100 group-hover:opacity-100 dark:border-white/10 dark:bg-neutral-800/90 dark:text-neutral-400 dark:hover:bg-neutral-700 dark:hover:text-neutral-100"
                        >
                          <span aria-hidden className="leading-none">⋯</span>
                          <span>편집</span>
                        </button>
                      )}
                      {pageSvg !== undefined ? (
                        <div className="page-svg" dangerouslySetInnerHTML={{ __html: pageSvg }} />
                      ) : (
                        // Page-shaped skeleton (A4 1:1.414) with a subtle shimmer while the SVG renders —
                        // reads as a loading page, not a blank box. The page number sits faintly centered.
                        <div className="page-skeleton relative grid aspect-[1/1.414] place-items-center overflow-hidden rounded-lg">
                          <span className="text-xs font-medium tabular-nums text-neutral-300 dark:text-neutral-600">
                            {item.index + 1}쪽
                          </span>
                        </div>
                      )}
                      {/* Editor chrome (own-render): 한글식 printable-area corner marks + top ruler. Drawn
                          only once the page SVG has painted so it aligns with the rendered page box. */}
                      {viewMode === "own" && pageSvg !== undefined && pageGeom[item.index] && (
                        <PageChrome geom={pageGeom[item.index]} />
                      )}
                      {viewMode === "svg" && caret && caretRect && caretBox && caret.page === item.index && (
                        <div
                          className="caret-blink pointer-events-none absolute z-10 w-px bg-accent"
                          style={{ left: `${caretBox.left}px`, top: `${caretBox.top}px`, height: `${caretBox.height}px` }}
                        />
                      )}
                      {/* Image move/resize overlay (own-render only): 8 handles over the selected
                          image, live-drag = CSS-only, pointerup = ONE undoable op (resize/move). */}
                      {viewMode === "own" && imageSel && imageSel.page === item.index && (
                        <div data-image-overlay className="pointer-events-none absolute inset-0 z-20">
                          <ImageOverlay
                            box={imageSel.screen}
                            pxPerPageX={imageSel.pxPerPageX}
                            pxPerPageY={imageSel.pxPerPageY}
                            onCommitResize={commitImageResize}
                            onCommitMove={commitImageMove}
                            onDelete={commitImageDelete}
                            deletable={!inlineEdit}
                            onMovePoint={updateDropHint}
                            onMoveEnd={clearDropHint}
                            onDismiss={clearImageSel}
                          />
                        </div>
                      )}
                      {/* Table drag-to-move + quick-edit overlay (own-render only): press-drag the box
                          to relocate the table (MoveBlock), or use the toolbar verbs (행 추가 / 칸 편집
                          / 표 삭제). Live-drag = CSS-only, pointerup = ONE undoable op. */}
                      {viewMode === "own" && tableSel && tableSel.page === item.index && (
                        <div data-table-overlay className="pointer-events-none absolute inset-0 z-20">
                          <TableOverlay
                            box={tableSel.screen}
                            colFracs={tableSel.colFracs}
                            rowFracs={tableSel.rowFracs}
                            activeCell={activeCell ? { row: activeCell.row, col: activeCell.col } : null}
                            onCommitMove={commitTableMove}
                            onCommitColWidths={commitTableColWidths}
                            onCommitRowHeights={commitTableRowHeights}
                            onAddRow={commitTableAddRow}
                            onEditCell={openCellEditor}
                            onDeleteTable={commitTableDeleteTable}
                            onShade={commitShade}
                            deletable={!inlineEdit && !activeCell}
                            onMovePoint={updateDropHint}
                            onMoveEnd={clearDropHint}
                            onDismiss={clearTableSel}
                          />
                        </div>
                      )}
                      {/* Focused CELL highlight (own-render): a FILLED accent tint + a solid "N행 M열"
                          badge on the clicked/edited cell so ⌘C/⌘V/Delete/배경색 have an unmistakable
                          target (a bare ring blended into the table-selection ring — "이 칸을 어떻게
                          알아?"). Click-through; double-click edits; the badge sits just above the cell
                          so it stays readable over an open inline editor. */}
                      {viewMode === "own" && activeCell && activeCell.page === item.index && (
                        <div
                          className="pointer-events-none absolute z-30 rounded-[1px] bg-accent/10 ring-2 ring-accent"
                          style={{ left: `${activeCell.screen.left}px`, top: `${activeCell.screen.top}px`, width: `${activeCell.screen.width}px`, height: `${activeCell.screen.height}px` }}
                        >
                          <span className="absolute -top-[1.15rem] left-0 whitespace-nowrap rounded-t bg-accent px-1 py-0.5 text-[9px] font-medium leading-none text-white shadow-sm">
                            {activeCell.row + 1}행 {activeCell.col + 1}열
                          </span>
                        </div>
                      )}
                      {/* (Format controls + save/cancel moved to the TOP edit toolbar — see below the
                          main toolbar — so they don't float over and obscure the text being edited.) */}
                      {/* Point-to-scope PIN (own-render): a dashed accent box + a "✦ 여기" tag over the
                          block the user pointed at, so "가리키기"(pointing) is visible and the chat/insert
                          target is unmistakable. The box is click-through (pointer-events-none) so a new
                          click re-points; the tag's ✕ clears it. Mirrors the chat's scope chip. */}
                      {viewMode === "own" && scopePin && scopePin.page === item.index && (
                        <div data-scope-pin className="pointer-events-none absolute inset-0 z-20">
                          <div
                            className="absolute rounded-md border-2 border-dashed border-ai/70 bg-ai/5"
                            style={{ left: `${scopePin.screen.left}px`, top: `${scopePin.screen.top}px`, width: `${scopePin.screen.width}px`, height: `${scopePin.screen.height}px` }}
                          >
                            <span className="pointer-events-auto absolute -left-px -top-[1.3rem] flex items-center gap-1 rounded-t-md bg-ai px-1.5 py-0.5 text-[10px] font-medium text-white shadow-sm">
                              <button
                                onClick={(e) => { e.stopPropagation(); setChatOpen(true); }}
                                title="이 위치를 AI에게 요청 (채팅 열기)"
                                className="flex items-center gap-1 leading-none"
                              >
                                <span aria-hidden>✦</span>
                                여기{scopePin.kind === "table" ? " · 표" : scopePin.kind === "image" ? " · 그림" : ""}에 요청
                              </button>
                              <button
                                onClick={(e) => { e.stopPropagation(); deleteBlockAt(scopePin.section, scopePin.block); }}
                                title="이 블록 삭제 (Delete)"
                                className="ml-0.5 rounded px-0.5 leading-none hover:bg-white/25"
                              >🗑</button>
                              <button
                                onClick={(e) => { e.stopPropagation(); clearScope(); }}
                                title="가리키기 해제 (Esc)"
                                className="rounded px-0.5 leading-none hover:bg-white/25"
                              >✕</button>
                            </span>
                          </div>
                        </div>
                      )}
                      {/* Drag drop INDICATOR (own-render): a horizontal accent line at the block the
                          drop would land before, so "들어갈 곳" is visible while dragging an image/table. */}
                      {viewMode === "own" && dropHint && dropHint.page === item.index && (
                        <div className="pointer-events-none absolute inset-x-0 z-30" style={{ top: `${dropHint.top}px` }}>
                          <div className="mx-2 flex items-center gap-1">
                            <span className="h-2 w-2 -translate-y-1/2 rounded-full bg-accent" />
                            <span className="h-0.5 flex-1 -translate-y-1/2 rounded-full bg-accent" />
                            <span className="-translate-y-1/2 rounded bg-accent px-1 py-0.5 text-[9px] font-medium text-white">여기로 이동</span>
                          </div>
                        </div>
                      )}
                      {/* WYSIWYG INLINE editor (own-render): a contentEditable laid over the double-clicked
                          CELL or PARAGRAPH, rendering the block's STYLED runs so bold/italic/size/color/
                          font are visible WHILE typing. ⌘B/⌘I + the ribbon style the live selection;
                          Enter commits (Shift+Enter = newline), Esc cancels, blur commits. innerHTML is set
                          ONCE (uncontrolled) — never on render — so the caret + Korean IME survive. */}
                      {viewMode === "own" && inlineEdit && inlineEdit.page === item.index && (
                        <div
                          // Keyed per address so a cell SWITCH remounts fresh (no stale content carryover).
                          key={`ie-${inlineEdit.section}-${inlineEdit.block}-${inlineEdit.row ?? "p"}-${inlineEdit.col ?? "p"}`}
                          data-inline-edit
                          contentEditable
                          suppressContentEditableWarning
                          // Set the styled HTML ONCE on mount (uncontrolled) + focus. Never re-set from React.
                          ref={(el) => {
                            if (el && el.dataset.init !== "1") {
                              el.dataset.init = "1";
                              el.innerHTML = runsToHtml(inlineEdit.runs, inlineEdit.scale);
                              el.focus();
                              const r = document.createRange();
                              r.selectNodeContents(el);
                              r.collapse(false); // caret at end
                              const sel = window.getSelection();
                              sel?.removeAllRanges();
                              sel?.addRange(r);
                            }
                          }}
                          onClick={(e) => e.stopPropagation()}
                          onDoubleClick={(e) => e.stopPropagation()}
                          onPointerDown={(e) => e.stopPropagation()}
                          onPaste={(e) => {
                            // Strip to PLAIN text so pasted HTML never injects styles the serializer can't map.
                            e.preventDefault();
                            const text = e.clipboardData.getData("text/plain");
                            document.execCommand("insertText", false, text);
                          }}
                          onBlur={() => commitInlineEditFromDom(inlineEdit)}
                          onKeyDown={(e) => {
                            // ⌘B / ⌘I / ⌘U → toggle the LIVE selection (visible immediately, serialized on commit).
                            if ((e.metaKey || e.ctrlKey) && /^[biu]$/i.test(e.key)) {
                              e.preventDefault();
                              const k = e.key.toLowerCase();
                              applyLiveStyle(k === "b" ? { bold: true } : k === "i" ? { italic: true } : { underline: true }, inlineEdit.scale);
                              return;
                            }
                            if (e.key === "Escape") { e.preventDefault(); cancelInlineEdit(); }
                            else if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); commitInlineEditFromDom(inlineEdit); }
                          }}
                          style={{
                            position: "absolute",
                            left: `${inlineEdit.screen.left}px`,
                            top: `${inlineEdit.screen.top}px`,
                            width: `${Math.max(inlineEdit.screen.width, 40)}px`,
                            minHeight: `${Math.max(inlineEdit.screen.height, 22)}px`,
                            // PURE black (not neutral-900 ≈ rgb(23,23,23)): default-color runs inherit this,
                            // and serializeEditor maps exact rgb(0,0,0) → color-less, so untouched black text
                            // round-trips without writing a spurious #171717 (which also recolored true black
                            // and defeated the engine's shape-preservation no-op).
                            color: "#000000",
                          }}
                          // White bg (the page is white even in app dark mode); an accent ring marks the
                          // active editor. leading-snug ≈ the own-render line spacing. The span styles carry
                          // the per-run font/size/weight so the text reads WYSIWYG.
                          className="z-40 overflow-auto whitespace-pre-wrap break-words rounded-[2px] bg-white px-1 py-0.5 text-left leading-snug text-neutral-900 shadow-[0_0_0_2px_var(--color-accent,#2563eb)] outline-none ring-2 ring-accent/40"
                        />
                      )}
                      {/* (Save/cancel + keymap hint moved to the TOP edit toolbar so they don't float over
                          the text being edited — see the edit toolbar below the main toolbar.) */}
                      {/* Post-apply highlight pulse — a one-shot accent glow over the page a chat edit
                          just landed on (cleared by a timer in `pulse`). */}
                      {pulsePage === item.index && (
                        <div key={`pulse-${pulseTimer.current}`} className="apply-pulse pointer-events-none absolute inset-0 z-10" />
                      )}
                      {/* IMPLEMENT B — INLINE pending review: a distinct "제안됨" band + the
                          ✓확정/✕취소/✎다시 toolbar pinned to the page the proposal targets, so the AI
                          content is reviewed ON the document (the chat card mirrors these actions). */}
                      {pending && pending.page === item.index && (
                        <PendingInline
                          ops={pending.ops}
                          provider={pending.provider}
                          busy={pendingBusy}
                          onConfirm={confirmPending}
                          onReject={rejectPending}
                          onRefine={refinePending}
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
          {/* IMPLEMENT B — robust FALLBACK for the inline pending review: when the target page's band
              isn't on screen (HTML mode, or scrolled away), pin a clearly-styled 확정/취소/다시 bar so
              the controls are never lost. ↪ scrolls the "제안됨" band back into view. */}
          {pending && !pendingPageVisible && (
            <div className="sticky bottom-4 z-30 mx-auto flex w-fit items-center gap-2 rounded-full border-2 border-dashed border-ai/50 bg-ai/10 px-3 py-1.5 text-sm shadow-lg backdrop-blur">
              <span className="font-medium text-ai">✦ {pending.provider === "mock" || pending.provider === "none" ? "예시 제안" : "AI 제안"} 검토 중</span>
              <button
                onClick={() => scrollToPage(pending.page)}
                className="rounded px-1.5 py-0.5 text-xs text-ai hover:bg-ai/15"
                title="제안된 위치로 이동"
              >
                ↪ p.{pending.page + 1}
              </button>
              <span className="mx-0.5 h-4 w-px bg-ai/30" />
              <button onClick={confirmPending} disabled={pendingBusy} className="rounded-md bg-ai px-2.5 py-1 text-xs font-medium text-white hover:opacity-90 disabled:opacity-40">✓ 확정</button>
              <button onClick={rejectPending} disabled={pendingBusy} className="rounded-md px-2.5 py-1 text-xs text-neutral-600 hover:bg-neutral-200/70 disabled:opacity-40 dark:text-neutral-300 dark:hover:bg-neutral-700/60">✕ 취소</button>
              <button onClick={refinePending} disabled={pendingBusy} className="rounded-md border border-ai/30 px-2.5 py-1 text-xs text-ai hover:bg-ai/10 disabled:opacity-40">✎ 다시</button>
            </div>
          )}
          {/* (The cell/paragraph editor is now INLINE — rendered over the target in the page list above —
              so there's no modal here. Double-click a cell or a paragraph to edit in place.) */}
        </main>

        <Chat
          open={chatOpen && pageCount > 0}
          canEdit={canEdit}
          provider={provider}
          scope={scope}
          onClearScope={clearScope}
          onJumpToPage={scrollToPage}
          ctx={chatCtx}
          // The inline toolbar (on the document) and the chat card are the SAME review — when the
          // user acts inline, this signal flips the mirrored card to ✓적용됨 / 취소됨 so they agree.
          settleSignal={pendingSettle}
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
          <SegmentedControl
            size="sm"
            value={zoom}
            onChange={setZoom}
            segments={[
              { value: 0.5, label: "50%", title: "50% 배율" },
              { value: 0.75, label: "75%", title: "75% 배율" },
              { value: 1, label: "100%", title: "100% 배율" },
              { value: 0, label: "맞춤", title: "가로 맞춤" },
            ]}
          />
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

      {/* Top progress bar — appears instantly while busy so quick ops give immediate feedback without
          the blocking dim. A slim accent sliver slides across the very top edge. */}
      {busyLabel && (
        <div className="pointer-events-none absolute inset-x-0 top-0 z-[60] h-0.5 overflow-hidden">
          <div className="top-progress absolute top-0 h-full rounded-full bg-accent" />
        </div>
      )}

      {/* Blocking overlay — gated behind a short delay (overlayBusy) so it ONLY dims for slow ops. */}
      {busyLabel && overlayBusy && (
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

      {/* U5: minimal point-action popover (right-click a block). NOT a Notion block toolbar — 2 verbs
          so the chat stays the obvious editing path. AI 편집 seeds the chat scope; 이미지 삽입 is direct. */}
      {pointMenu && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setPointMenu(null)} onContextMenu={(e) => { e.preventDefault(); setPointMenu(null); }} />
          <div
            className="fixed z-50 w-64 overflow-hidden rounded-lg border border-black/10 bg-white py-1 text-sm shadow-xl dark:border-white/10 dark:bg-neutral-800"
            style={{ left: Math.min(pointMenu.x, window.innerWidth - 264), top: Math.min(pointMenu.y, window.innerHeight - 150) }}
          >
            {/* Header: what was pointed at, so the verbs below read as "do this TO this block". */}
            <div className="px-3 py-1.5 text-[11px] text-neutral-400 dark:text-neutral-500">
              {pointMenu.kind === "table" ? "표" : pointMenu.kind === "image" ? "그림" : "문단"} 위치 · {pointMenu.page + 1}쪽 기준
            </div>
            <button
              className="flex w-full flex-col items-start gap-0.5 px-3 py-1.5 text-left hover:bg-ai/10"
              onClick={() => {
                setScope({ section: pointMenu.section, block: pointMenu.block, page: pointMenu.page });
                // A pin and an image/table overlay are mutually exclusive (else two Backspace lanes arm
                // at once → double-delete). Drop any overlay before pinning.
                clearImageSel();
                clearTableSel();
                // Own-render: drop the visible pin on the resolved band so the target is unmistakable.
                if (pointMenu.box) recomputeScopePin(pointMenu.page, pointMenu.section, pointMenu.block ?? 0, pointMenu.box, pointMenu.kind ?? "", pointMenu.text ?? "");
                setChatOpen(true);
                setPointMenu(null);
              }}
            >
              <span className="font-medium text-ai">✦ 여기를 AI로 편집</span>
              <span className="text-[11px] leading-snug text-neutral-500 dark:text-neutral-400">이 위치를 대상으로 채팅을 엽니다 — “이 표 채워줘”처럼 요청</span>
            </button>
            <button
              className="flex w-full flex-col items-start gap-0.5 px-3 py-1.5 text-left hover:bg-accent/10"
              onClick={() => {
                const sel = pointMenu; setPointMenu(null);
                void (async () => {
                  const path = await openDialog({ multiple: false, filters: [{ name: "이미지", extensions: ["png", "jpg", "jpeg", "gif", "bmp", "webp"] }] });
                  if (typeof path !== "string") return;
                  try { const n = await api.applyImageDrop(path, { section: sel.section, block: sel.block }); setEdited(true); invalidate(n, sel.page); toast("info", "이미지 삽입됨 (⌘Z로 되돌리기)"); }
                  catch (err) { toast("warn", `이미지 삽입 실패: ${err}`); }
                })();
              }}
            >
              <span className="font-medium">🖼️ 여기에 이미지 삽입</span>
              <span className="text-[11px] leading-snug text-neutral-500 dark:text-neutral-400">파일을 골라 이 위치 바로 뒤에 넣습니다 (문서 끝 아님)</span>
            </button>
            {pointMenu.block !== null && (
              <button
                className="flex w-full flex-col items-start gap-0.5 px-3 py-1.5 text-left hover:bg-red-500/10"
                onClick={() => { const sel = pointMenu; setPointMenu(null); deleteBlockAt(sel.section, sel.block as number); }}
              >
                <span className="font-medium text-red-600 dark:text-red-400">🗑 여기 블록 삭제</span>
                <span className="text-[11px] leading-snug text-neutral-500 dark:text-neutral-400">이 {pointMenu.kind === "table" ? "표" : pointMenu.kind === "image" ? "그림" : "문단"}을 삭제합니다 (⌘Z로 되돌리기)</span>
              </button>
            )}
          </div>
        </>
      )}
      {/* U6: keyboard cheat-sheet (⌘/). */}
      {cheatOpen && (
        <div className="fixed inset-0 z-[60] grid place-items-center bg-black/30 p-4 backdrop-blur-sm" onClick={() => setCheatOpen(false)}>
          <div className="w-[22rem] rounded-xl border border-black/10 bg-white p-5 shadow-2xl dark:border-white/10 dark:bg-neutral-800" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 text-base font-semibold">키보드 단축키</div>
            <div className="flex flex-col gap-1.5 text-sm text-neutral-700 dark:text-neutral-300">
              {([["⌘O", "문서 열기"], ["⌘K", "명령 팔레트"], ["⌘L", "AI 바이브 편집"], ["⌘\\", "문서 개요"], ["⌘F", "찾기"], ["⌘= / ⌘-", "확대 / 축소"], ["⌘0", "100%"], ["⌘S / ⌘E", "내보내기(HWPX)"], ["⌘Z / ⌘⇧Z", "실행취소 / 다시실행"], ["⌘/", "이 도움말"]] as [string, string][]).map(([k, d]) => (
                <div key={k} className="flex items-center justify-between gap-4">
                  <span>{d}</span>
                  <kbd className="shrink-0 rounded bg-black/5 px-1.5 py-0.5 text-xs dark:bg-white/10">{k}</kbd>
                </div>
              ))}
            </div>
            {/* Discoverability: the manual-edit GESTURES (mouse, not keys) live here too so the chat-
                primary model's quieter direct-manipulation paths are findable. */}
            <div className="mb-1.5 mt-4 text-xs font-medium uppercase tracking-wide text-neutral-400">직접 편집</div>
            <div className="flex flex-col gap-1.5 text-sm text-neutral-700 dark:text-neutral-300">
              {([["클릭(자체 렌더)", "블록 클릭 → ✦여기 핀 (AI 대상 지정)"], ["더블클릭", "표 칸·문단 → 그 자리에서 바로 텍스트 입력"], ["클릭 후 ⌘C/⌘V", "가리킨 문단 복사 / 붙여넣기"], ["클릭 후 Delete", "가리킨 블록 삭제 (또는 핀의 🗑 · 우클릭)"], ["우클릭 · ⋯", "여기를 AI로 편집 / 이미지 삽입 / 삭제"], ["드래그&드롭", "이미지 파일을 페이지에 끌어다 삽입"], ["이미지·표", "클릭 선택 → 끌어서 이동 · 크기 · 열 너비 / Delete"]] as [string, string][]).map(([k, d]) => (
                <div key={k} className="flex items-center justify-between gap-4">
                  <span>{d}</span>
                  <kbd className="shrink-0 rounded bg-black/5 px-1.5 py-0.5 text-xs dark:bg-white/10">{k}</kbd>
                </div>
              ))}
            </div>
            <div className="mt-4 text-right"><button onClick={() => setCheatOpen(false)} className="rounded-md px-3 py-1 text-xs text-neutral-500 hover:bg-black/5 dark:hover:bg-white/10">닫기</button></div>
          </div>
        </div>
      )}
      <Palette open={paletteOpen} onOpenChange={setPaletteOpen} commands={commands} />
      <Composer mode={composer} onClose={() => setComposer(null)} ctx={composerCtx} />
      <Toaster />
    </div>
  );
}
