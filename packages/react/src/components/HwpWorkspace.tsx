import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Anchor, Box, CellAddr, CellDir, DocContext, EngineAdapter, ImageBox, Intent, IntentCard, MatchBox, OutlineItem, PageGeom, PointerInput, RunSpec, Selection, TableBox, XYWH } from "@tf-hwp/editor-core";
import { boundariesToRatios, remapFragmentHeights, appliedReflectsDrag, firstRunStyle, columnWidthMm, setColumnWidthMm, equalizeColumns, imageInsertSize, imageSizeToHwpunit, appliedReflectsResize, DRAG_THRESHOLD_PX } from "@tf-hwp/editor-core";
import { OutlinePanel } from "./OutlinePanel";
import { StatusBar } from "./StatusBar";
import { pageAtReference } from "../outline";
import { runsUnchanged, applyLiveStyle, readCaretStyle } from "../richedit";
import { modLabel } from "../platform";
import { ZOOM_STEP, clampZoom, isEditableTarget, panBy, wheelToZoomFactor, zoomAt } from "../viewport";
import { useHwpEditor } from "../useHwpEditor";
import { ChatPanel } from "./ChatPanel";
import { HwpPageView, type PageClick } from "./HwpPageView";
import { SelectionOverlay, type Mark } from "./SelectionOverlay";
import { MarqueeLayer } from "./MarqueeLayer";
import { CaretLayer } from "./CaretLayer";
import { ImeCompositionLayer } from "./ImeCompositionLayer";
import { CompositionStore } from "../composition";
import { HoverLayer } from "./HoverLayer";
import { useHover } from "../useHover";
import { FontPicker } from "./FontPicker";
import { ColumnResizeOverlay, RowResizeOverlay } from "./ColumnResizeOverlay";
import { ImageOverlay } from "./ImageOverlay";
import { InlineEditPanel } from "./InlineEditPanel";
import { TableInsertButton } from "./TableInsertButton";
import { Ruler } from "./Ruler";
import { InPlaceCellEditor } from "./InPlaceCellEditor";
import { FormatRibbon, type RibbonFmt, type FormatRibbonPatch } from "./FormatRibbon";
import { unionPageBox } from "../floatingPosition";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { ColumnWidthDialog } from "./ColumnWidthDialog";
import { CellShadePalette } from "./CellShadePalette";
import { TableSizeGrid } from "./TableSizeGrid";
import { FindBar } from "./FindBar";
import { FindMatchOverlay } from "./FindMatchOverlay";
import { useSelectionActions } from "../useSelectionActions";
import { readViewBox, screenToPage, type PageBox } from "../coords";
import { buildFontFaceCss, catalogUrl, SERIF_SUBSTITUTE, type FontCatalogEntry } from "../fonts";

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
  /** The marked cell/range first-run size (pt) + text color — reflected in the 048 format ribbon's size
   *  box / 글자색 swatch when NOT editing (issue 048: 현재 상태 반영). Defaults when unstyled/unknown. */
  curSizePt?: number;
  curColor?: string | null;
}

/** The INLINE per-element edit target (issue 06x) — a SNAPSHOT captured when the user opens the inline
 *  panel from a single selection (cell/paragraph/table) or a selected image. Decoupled from the live
 *  selection so the panel stays anchored (and its applied summary stays visible) across the apply's own
 *  re-flow. `box`/`page` position the panel BELOW the element (own-render px × scale); `anchor` rides to
 *  `onAiRequest` as the sole anchor (identical grid/context to the chat); `label` is the chip caption. */
interface InlineTarget {
  page: number;
  box: Box;
  kind: string;
  anchor: Anchor;
  label: string;
}

// issue 048: the ribbon's size box shows an inherited (size unset) run at the doc default ~10pt — matching
// richedit's DEFAULT_PT so the reflected size and applyLiveStyle's size wrap agree.
const RIBBON_DEFAULT_PT = 10;

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
  /** Opt-in (issue 058): also fetch + register the OFL SERIF substitute (Nanum Myeongjo, from the
   *  `fontCatalog`) so the EXPORTED PDF renders 명조 runs serif (the screen already does via `@font-face`).
   *  Best-effort — a 404/offline fetch is swallowed and 명조 falls back to the gothic body in the PDF
   *  (pre-058). Off by default so the injected-font set (and hosts/tests that pin it) is unchanged. */
  injectSerifSubstitute?: boolean;
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
  /** Opt-in (issue 050): a DOCUMENT file (.hwp/.hwpx) was DROPPED onto the page area. The workspace opens
   *  documents from `props.document` (host-controlled), so it does NOT open a dropped doc itself — it hands
   *  the bytes to the host here (which sets `document`). When omitted, a document drop shows an honest
   *  "상단에서 파일 열기" toast. An IMAGE drop (PNG/JPEG) is ALWAYS handled in place (inserted), independent
   *  of this prop — the drop branch rule (문서=열기 / 이미지=삽입) lives in the workspace. */
  onOpenFile?: (bytes: Uint8Array, name: string) => void | Promise<void>;
  className?: string;
}

/** Drop-branch classifiers (issue 050): an IMAGE file (PNG/JPEG) is inserted in place; a DOCUMENT file
 *  (.hwp/.hwpx) is forwarded to the host as an OPEN; anything else is refused honestly. Matched on the
 *  MIME type first (a Finder drag carries it) then the extension (a bare filename). */
const isImageFile = (f: File): boolean => /^image\/(png|jpe?g)$/i.test(f.type) || /\.(png|jpe?g)$/i.test(f.name);
const isDocFile = (f: File): boolean => /\.(hwpx?|HWPX?)$/i.test(f.name);

/** Map a page-local click (client-px converted to page-px in HwpPageView) to the core's DOM-free pointer
 *  input. The client point rides along ONLY for the zoom-independent drag threshold (§함정). */
const toPointerInput = (c: PageClick): PointerInput => ({ page: c.page, x: c.x, y: c.y, mod: c.meta, client: c.client });

/** Deep-equal two descending CellPaths (issue 064 Tier-2) — used to decide "the double-clicked cell is
 *  already the drilled/selected one → open its editor" precisely across nesting levels. */
function samePath(a: CellAddr[], b: CellAddr[]): boolean {
  return a.length === b.length && a.every((s, i) => s.block === b[i].block && s.row === b[i].row && s.col === b[i].col);
}

// ── MULTI-PAGE marquee (issue: cross-page drag select) ──────────────────────────────────────────────
/** How close (client px) to the canvas's top/bottom edge the cursor must be during a marquee drag to
 *  trigger edge auto-scroll, and how many px per rAF tick to scroll. */
const AUTOSCROLL_EDGE = 48;
const AUTOSCROLL_SPEED = 16;

/** Compute the per-page sub-rects of a marquee that may span multiple pages. Intersects the client-space
 *  drag rectangle (press point → current point) with EACH page sheet's on-screen box, then maps each
 *  intersection into that page's OWN own-render PAGE px via `screenToPage`. Every page the rect touches
 *  yields one slice (clamped to the page). The client-rect math lives HERE (the React layer) so the
 *  editor-core SelectionModel stays DOM-free (SDK-LAYERS §함정). A rendered page maps against its <svg>
 *  (exact viewBox); a virtualized placeholder (no <svg>) falls back to the first rendered page's viewBox
 *  (pages in one section share a size), so a marquee that reaches off-screen pages still selects them. */
function computeMarqueeSlices(canvas: HTMLElement, start: { x: number; y: number }, cur: { x: number; y: number }): { page: number; box: PageBox }[] {
  const x0 = Math.min(start.x, cur.x);
  const y0 = Math.min(start.y, cur.y);
  const x1 = Math.max(start.x, cur.x);
  const y1 = Math.max(start.y, cur.y);
  const sheets = Array.from(canvas.querySelectorAll<HTMLElement>(".hw-sheet[data-page]"));
  let fallbackVb: { width: number; height: number } | null = null;
  for (const s of sheets) {
    const svg = s.querySelector("svg") as SVGSVGElement | null;
    if (svg) {
      fallbackVb = readViewBox(svg);
      break;
    }
  }
  const slices: { page: number; box: PageBox }[] = [];
  for (const sheet of sheets) {
    const attr = sheet.getAttribute("data-page");
    if (attr == null) continue;
    const svg = sheet.querySelector("svg") as SVGSVGElement | null;
    const el: Element = svg ?? sheet;
    const rect = el.getBoundingClientRect();
    const vb = svg ? readViewBox(svg) : fallbackVb;
    if (!vb || vb.width === 0 || vb.height === 0 || rect.width === 0 || rect.height === 0) continue;
    // Intersect the client drag rect with this page's on-screen box (this is what clamps the slice to the page).
    const ix0 = Math.max(x0, rect.left);
    const iy0 = Math.max(y0, rect.top);
    const ix1 = Math.min(x1, rect.right);
    const iy1 = Math.min(y1, rect.bottom);
    if (ix1 <= ix0 || iy1 <= iy0) continue; // no overlap with this page
    const p0 = screenToPage(ix0, iy0, rect, vb);
    const p1 = screenToPage(ix1, iy1, rect, vb);
    if (!p0 || !p1) continue;
    slices.push({ page: Number(attr), box: { x: Math.min(p0.x, p1.x), y: Math.min(p0.y, p1.y), w: Math.abs(p1.x - p0.x), h: Math.abs(p1.y - p0.y) } });
  }
  return slices;
}

/** issue 055 사후 — COUNTED refreshToken shield. An action that causes its OWN re-flow (셀음영 적용,
 *  Tab 커밋-이동, 이미지 이동/크기 커밋) arms the shield (+1) so the refreshToken effect skips exactly
 *  that one close/clear; the effect CONSUMES counts here. Counted (not boolean) because two applies can
 *  be in flight at once (worker latency) — a boolean is consumed by the first re-flow and the second one
 *  then closes the editor (미커밋 텍스트 소실). `reflows` is the effect's TOKEN DELTA, not 1: React can
 *  coalesce two bumps into a single effect run (worker replies land close together), and consuming one
 *  count per RUN would leak the other. Returns how many re-flows remain UNSHIELDED (>0 ⇒ really close). */
export function consumeShield(shield: { current: number }, reflows: number): number {
  const used = Math.min(Math.max(0, shield.current), Math.max(0, reflows));
  shield.current -= used;
  return reflows - used;
}

/** issue 055 사후 — disarm one shield count after a FAILED apply (its re-flow will never come; leaving
 *  the count armed would swallow the NEXT legitimate close, e.g. the trap-recovery refresh). */
export function disarmShield(shield: { current: number }): void {
  shield.current = Math.max(0, shield.current - 1);
}

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
  // Opt-in "레이아웃 정리" (layout normalization): recovers a lossy hwp→hwpx conversion's inflated
  // line-spacing (Hancom "save as .hwpx" collapses body paragraphs onto the 160% default). Default OFF =
  // faithful render. `normalizeSupported` gates the toggle's visibility to backends that expose it.
  const [normalizeOn, setNormalizeOn] = useState(false);
  const [normalizeBusy, setNormalizeBusy] = useState(false);
  const normalizeSupported = typeof (adapter as { setNormalize?: unknown }).setNormalize === "function";
  // Last pointer-up (time + client px) for the double-click detector. We can't use the DOM `dblclick`
  // event: HwpPageView `setPointerCapture`s on pointerdown, which redirects the pointerup so the browser
  // never synthesizes click/dblclick. So we detect "two quick ups at ~the same spot" ourselves.
  const lastUpRef = useRef<{ t: number; x: number; y: number } | null>(null);
  // Issue 027 editing chrome (opt-in): the resolved single-selection edit target, the ruler geometry,
  // and the open text popover. All null/off when `enableEditing` is not set.
  const editingOn = !!props.enableEditing;
  const [editTarget, setEditTarget] = useState<EditTarget | null>(null);
  const [pageGeom0, setPageGeom0] = useState<PageGeom | null>(null);
  // ── issue 049: image move/resize overlay (own-render only) ──────────────────────────────────────────
  // The selected image = its page + own-render px box + `(section, block)` anchor (from `imageAt`). The
  // 8-handle ImageOverlay draws over it; a drag lives in the OVERLAY's local state (workspace render 0),
  // and a commit re-places it via `imageBbox` (적용-확인). `imageCommittingRef` is a COUNTED shield
  // (issue 055 사후, consumeShield): each resize/move commit arms +1 and the refreshToken clear effect
  // consumes its own re-flow, so overlapping commits (worker latency) never clobber the re-place — the
  // old setTimeout(0) release raced the effect under worker macrotask timing (shadingRef와 같은 결함).
  const [imageSel, setImageSel] = useState<{ page: number; box: ImageBox } | null>(null);
  const imageSelRef = useRef<{ page: number; box: ImageBox } | null>(null);
  imageSelRef.current = imageSel;
  const imageCommittingRef = useRef(0);
  // ── issue 06x: INLINE per-element edit + apply/revert ────────────────────────────────────────────────
  // The OPEN inline-edit panel's target (a SNAPSHOT — see `InlineTarget`), or null when closed. Its own
  // apply arms `inlineEditShieldRef` (+1) so the resulting re-flow does NOT trip the external-edit guard
  // below (which closes+keeps on any OTHER edit) — the same counted-shield discipline as the editor-close
  // / image-clear effects. A click-away closes it via `onPointerDown` (a sheet press = an external gesture).
  const [inlineEdit, setInlineEdit] = useState<InlineTarget | null>(null);
  const inlineEditRef = useRef<InlineTarget | null>(null);
  inlineEditRef.current = inlineEdit;
  const inlineEditShieldRef = useRef(0);
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
    { page: number; box: Box; section: number; block: number; kind: string; rows?: [number, number]; cols?: [number, number]; text: string; runs: RunSpec[]; fontSizePt?: number; path?: CellAddr[] } | null
  >(null);
  // Issue 048: the PERSISTENT top format ribbon's reflected state (굵게 여부 등 토글). Two drivers: when NOT
  // editing it mirrors the marked cell/range first-run format (editTarget.cur*); while EDITING a
  // `selectionchange` listener reads the caret's live computed style (readCaretStyle) so the toggles track
  // the cursor. `editorScaleRef` holds the OPEN editor's page scale (client px / own-render px) so the
  // ribbon's applyLiveStyle uses the SAME size↔px conversion as the InPlaceCellEditor's own ⌘-formatting.
  const [ribbonFmt, setRibbonFmt] = useState<RibbonFmt>({ bold: false, italic: false, underline: false, strike: false, sizePt: RIBBON_DEFAULT_PT, color: null });
  const editorScaleRef = useRef(1);
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
  // issue 039/055: the right-click → menu-resolution sequence guard (declared here so the dismiss paths
  // below can bump it). THE LATEST right-click owns the menu; EVERY dismiss path (Escape, a new pointer
  // gesture, menu close) bumps it too (issue 055 사후 #10), so a LATE resolution from an abandoned
  // right-click — the worker can make the hit queries slow — can never raise a menu the user moved past.
  const ctxMenuSeqRef = useRef(0);

  // ── Issue 050: 이미지 삽입 (드롭 존 + 업로드 버튼) ────────────────────────────────────────────────────
  // The hidden file input the 툴바 "이미지" button clicks (upload lane), and whether a file drag is
  // hovering the page area (drives the drop affordance). Both only matter under `enableEditing`+`canEdit`.
  const imageInputRef = useRef<HTMLInputElement>(null);
  const [dragActive, setDragActive] = useState(false);

  // ── Issue 047: 열 너비 mm 다이얼로그 + 편집 중 셀음영 ────────────────────────────────────────────────────
  // The OPEN 열 너비 dialog (a small popover; only its anchor is state — its current mm / column span are
  // derived LIVE from `editTarget`, so after an apply the re-resolved boundaries update the readout = 적용-
  // 확인). Opened from the cell context menu ("열 너비…"). Cleared when the selection/target goes away.
  const [colWidthDialog, setColWidthDialog] = useState<{ x: number; y: number } | null>(null);
  // A COUNTED shield (issue 055 사후, consumeShield): +1 per in-flight 편집 중 셀음영 apply, so the
  // refreshToken close effect does NOT close the in-place editor when the shade op re-flows — the shade
  // lands on the committed cell background while the uncommitted text stays in the editor (op-bus
  // SetTableCell rebuilds only the cell's paragraphs, never `shade_color`, so a later text commit
  // preserves the shade). Counted, not boolean: 연속 스와치 2회(둘 다 인플라이트)의 두 번째 re-flow가
  // 에디터를 닫아 미커밋 텍스트를 잃던 결함의 수정. 경합 금지.
  const shadingRef = useRef(0);

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

  // issue 06x: the CURRENT single inline-edit target (drives the "✨ 여기서 편집" affordance + the snapshot
  // captured when it opens). An image selection (own `imageSel` state — mutually exclusive with a block
  // selection) takes priority; else a LONE block selection (cell/paragraph/table). null = 0 or 2+ targets,
  // so the affordance is shown ONLY for exactly one element (per the issue). An image's structural anchor
  // is a `paragraph` anchor at its `(section, block)` (mirroring `deriveSel`'s image→paragraph mapping) so
  // `onAiRequest` can target it like any other block.
  const inlineTarget = useMemo<InlineTarget | null>(() => {
    if (imageSel) {
      const b = imageSel.box;
      const label = `이미지 (p.${imageSel.page + 1})`;
      return {
        page: imageSel.page,
        box: { x: b.x, y: b.y, w: b.w, h: b.h },
        kind: "image",
        anchor: { kind: "paragraph", section: b.section, block: b.block, label, page: imageSel.page },
        label,
      };
    }
    if (selection.length === 1) {
      const s = selection[0];
      return { page: s.mark.page, box: s.mark.box, kind: s.mark.kind, anchor: s.anchor, label: s.anchor.label };
    }
    return null;
  }, [imageSel, selection]);

  // Live mirrors so the (once-attached) cell-nav keydown listener reads the CURRENT selection/editor
  // without re-subscribing on every change (issue 036 — coexists with the 035 window keydown). `tabMoving`
  // suppresses the refreshToken editor-close while a Tab commit-move re-enters the next cell.
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const editorRef = useRef(editor);
  editorRef.current = editor;
  // COUNTED shield (issue 055 사후, consumeShield): armed +1 for a Tab commit's OWN re-flow only (a bare
  // Tab has no re-flow — arming would leak a count); the refreshToken close effect consumes it, replacing
  // the old setTimeout(0) release that raced the effect under worker macrotask timing.
  const tabMovingRef = useRef(0);
  // Live boolean mirror for the hover suppression gate (issue 038) — true while the in-place editor is open.
  const editorOpenRef = useRef(false);
  editorOpenRef.current = editor != null;
  // issue 053: live mirror of the cell caret (render-0 — the caret state NEVER enters workspace state;
  // CaretLayer draws it by ref). Read by the typing keydown below + the 036 cell-nav yield guard, and
  // by the click handler to know a caret is live without re-rendering anything.
  const caretActiveRef = useRef(false);
  useEffect(() => core.cellCaret.onChange((s) => (caretActiveRef.current = s != null)), [core]);
  // issue 059: the shared IME-composition signal — the caret-tracking hidden textarea (ImeCompositionLayer)
  // drives it, the CaretLayer reads it to hide its bar while composing, and the Escape handler reads it to
  // yield Escape to the IME (cancel) instead of clearing the caret. One stable instance for the session.
  const compositionRef = useRef<CompositionStore | null>(null);
  if (compositionRef.current == null) compositionRef.current = new CompositionStore();
  const compositionStore = compositionRef.current;
  // Down-point of the current pointer gesture (client px) — a caret is placed only on a PLAIN CLICK
  // (movement under the drag threshold), never at the end of a marquee/drag.
  const caretDownRef = useRef<{ x: number; y: number } | null>(null);
  // MULTI-PAGE marquee drag bookkeeping (issue: cross-page drag select). `dragStartClientRef` = the press
  // client point (the anchor of the drag rectangle); `lastMarqueeClientRef` = the latest cursor client
  // point (so the edge auto-scroll loop can re-slice at a fixed cursor while the pages scroll under it);
  // `autoScrollRafRef` = the active rAF id (null when not auto-scrolling).
  const dragStartClientRef = useRef<{ x: number; y: number } | null>(null);
  const lastMarqueeClientRef = useRef<{ x: number; y: number } | null>(null);
  const autoScrollRafRef = useRef<number | null>(null);

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

  // A poisoned engine instance — a wasm TRAP, or the engine WORKER dying (issue 055) — is recovered by
  // the adapter (respawn + reopen). Surface a toast + force a page re-fetch (the recovered doc lost the
  // last edit). Returns whether it handled a poison signal. issue 055 사후 #1: match the machine `code`
  // FIRST (`wasm_trap` | `worker_dead` — the worker-death errors say "engine worker died: …", which the
  // old message match missed, leaving the recovery toast/refresh dead); the message match is only a
  // fallback for stringified/legacy errors that lost their code.
  const onTrap = useCallback(
    (e: unknown, msg: string): boolean => {
      const code = (e as { code?: string } | null | undefined)?.code;
      const poisoned = code ? code === "wasm_trap" || code === "worker_dead" : /wasm_trap|engine worker died/i.test(String(e));
      if (poisoned) {
        toast(msg);
        bumpRefresh();
        return true;
      }
      return false;
    },
    [toast, bumpRefresh],
  );

  // issue 059: commit a completed IME composition as ONE SetTableCellRuns undo unit (the SAME lane as typed
  // text) with the workspace's trap/toast recovery — so the ImeCompositionLayer stays free of engine-error
  // policy (it just forwards compositionend.data).
  const commitComposition = useCallback(
    (text: string) => {
      void core.cellCaret.insertText(text).catch((err) => {
        if (!onTrap(err, "엔진 트랩 — 문서를 복구했습니다")) toast(`입력 실패: ${err}`);
      });
    },
    [core, onTrap, toast],
  );

  // Esc anywhere clears the whole selection + any in-progress marquee (issue 021) + an image selection
  // (049) + the cell caret (053). issue 055 사후 #10: it ALSO abandons any in-flight right-click menu
  // resolution — with a busy worker the hit queries can outlive the user's attention, and the late
  // resolution must not raise a menu after this dismiss. (An OPEN menu consumes Esc itself — capture +
  // stopPropagation in ContextMenu — so this listener only sees Esc while no menu is up.)
  // issue 059: while an IME composition is live, Escape belongs to the IME (cancel → compositionend with
  // empty data → no-op) — do NOT clear the caret/selection out from under it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (compositionStore.get() != null) return; // composing → yield Escape to the IME cancel
        ctxMenuSeqRef.current++;
        core.selection.clear();
        core.cellCaret.clear();
        setImageSel((s) => (s ? null : s));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [core, compositionStore]);

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
        core.cellCaret.clear(); // 053: a caret never survives a document swap
        // Sync the "레이아웃 정리" toggle with the engine's open-time decision: on a DEGRADED hwp→hwpx
        // conversion the engine auto-enables normalization (the upload shows the original .hwp look);
        // a genuine document opens faithful (off).
        const norm = (await adapter.normalizeActive?.()) ?? false;
        if (cancelled) return;
        setNormalizeOn(norm);
        toast(
          norm
            ? `열림: ${props.document!.name ?? "문서"} · ${r.pages}쪽 · 변환 열화 감지 → 레이아웃 자동 정리(원본 근사)`
            : `열림: ${props.document!.name ?? "문서"} · ${r.pages}쪽`,
        );
      } catch (e) {
        if (!cancelled) toast(`열기 실패: ${e}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [core, adapter, props.document, toast]);

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

  // Issue 058: the served URL of the OFL SERIF substitute (Nanum Myeongjo) from the catalog — drives the
  // screen serif `@font-face` (below) so 명조 runs render serif. `undefined` when the catalog omits it →
  // no serif binding (the SVG falls back to NanumGothic — a safe no-op).
  const serifUrl = useMemo(() => {
    const e = props.fontCatalog?.find((c) => c.family === SERIF_SUBSTITUTE);
    return e ? catalogUrl(e, props.fontUrlBase) : undefined;
  }, [props.fontCatalog, props.fontUrlBase]);
  // Serif BOLD variant (한양신명조 등 헤더가 serif+bold) → weight-700 serif @font-face.
  const serifBoldUrl = useMemo(() => {
    const e = props.fontCatalog?.find((c) => c.family === SERIF_SUBSTITUTE);
    return e?.boldFile ? catalogUrl({ ...e, file: e.boldFile }, props.fontUrlBase) : undefined;
  }, [props.fontCatalog, props.fontUrlBase]);

  // The served URL of the SELECTED font's BOLD variant (if the catalog entry declares `boldFile`) →
  // binds a weight-700 @font-face so bold headers render TRUE bold (issue: CJK synthetic bold is too weak).
  const boldUrl = useMemo(() => {
    const e = props.fontCatalog?.find((c) => c.family === selectedFont?.family);
    return e?.boldFile ? catalogUrl({ ...e, file: e.boldFile }, props.fontUrlBase) : undefined;
  }, [props.fontCatalog, props.fontUrlBase, selectedFont]);

  // Issue 058 (opt-in): register the serif substitute into the ENGINE too, so the EXPORTED PDF embeds it
  // for 명조 runs (the own-render already tags them; `emit_pdf_with_fonts` picks the serif-named face).
  // Registered as an ADDITIONAL family (the gothic body stays first → still backs the layout metrics), and
  // does NOT become `selectedFont` (no "apply to everything" collapse). Once per document; best-effort.
  const serifRegisteredFor = useRef<Uint8Array | null>(null);
  useEffect(() => {
    if (!props.injectSerifSubstitute || !meta || !props.document || !serifUrl) return;
    if (serifRegisteredFor.current === props.document.bytes) return;
    serifRegisteredFor.current = props.document.bytes;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(serifUrl);
        if (!res.ok || cancelled) return;
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (cancelled) return;
        await core.session.registerFont(SERIF_SUBSTITUTE, bytes);
      } catch {
        /* serif substitute is best-effort — 명조 falls back to the gothic body in the PDF (pre-058). */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.injectSerifSubstitute, meta, props.document, serifUrl, core]);

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
          setEditTarget({ ...base, tableBox: tableBox as TableBox | null, boundaries, rowBoundaries, curBold: !!style.bold, curItalic: !!style.italic, curSizePt: style.size_pt ?? RIBBON_DEFAULT_PT, curColor: style.color ?? null });
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
  // itself — its commit arms `tabMoving` (+1) so the close skips that one re-flow.
  // EXCEPTION (issue 047): a 편집 중 셀음영 apply re-flows too, but the shade does NOT touch the cell's text
  // or geometry — so keep the editor open (with its uncommitted text) for each armed `shading` count.
  // The shields are CONSUMED here (issue 055 — a timer-based release raced this effect once the engine
  // moved to a worker), COUNTED and by TOKEN DELTA (issue 055 사후 #4/#9): overlapping applies arm one
  // count each, and React may coalesce their bumps into a single run — consuming per re-flow (delta), not
  // per run, is what keeps a nested apply from closing the editor or leaking a stale count.
  const editorCloseSeenRef = useRef(0);
  useEffect(() => {
    let unshielded = refreshToken - editorCloseSeenRef.current;
    editorCloseSeenRef.current = refreshToken;
    unshielded = consumeShield(tabMovingRef, unshielded);
    unshielded = consumeShield(shadingRef, unshielded);
    if (unshielded <= 0) return; // every re-flow in this batch was one of OUR OWN shielded ones
    setEditor(null);
  }, [refreshToken]);

  // issue 049: an edit re-flow (AI apply / manual commit) may move an image, so a stale imageSel box would
  // float over the wrong spot — clear it. EXCEPTION: OUR OWN resize/move commit re-flows too, but it
  // re-places the overlay from the fresh `imageBbox` afterwards — each commit arms `imageCommitting` (+1)
  // and this effect consumes it (same counted/delta shield discipline as the editor-close effect above).
  const imageClearSeenRef = useRef(0);
  useEffect(() => {
    let unshielded = refreshToken - imageClearSeenRef.current;
    imageClearSeenRef.current = refreshToken;
    unshielded = consumeShield(imageCommittingRef, unshielded);
    if (unshielded <= 0) return;
    setImageSel((s) => (s ? null : s));
  }, [refreshToken]);

  // issue 06x — the INLINE-EDIT panel's revert GUARD: any EXTERNAL edit that re-flows the document while
  // the panel is open (another apply, a chat edit, an in-place text commit, a font swap, a trap recovery)
  // closes the panel KEEPING the applied change — never auto-reverting, and never leaving a 되돌리기 button
  // that would pop the WRONG batch (the one just applied is only the undo-stack top RIGHT AFTER our apply).
  // OUR OWN apply/revert arms `inlineEditShieldRef` (+1) so its re-flow is skipped here (same counted/delta
  // shield discipline as the editor-close / image-clear effects). A pure click-away (no re-flow) is handled
  // separately in `onPointerDown`.
  const inlineEditSeenRef = useRef(0);
  useEffect(() => {
    let unshielded = refreshToken - inlineEditSeenRef.current;
    inlineEditSeenRef.current = refreshToken;
    unshielded = consumeShield(inlineEditShieldRef, unshielded);
    if (unshielded <= 0) return; // the re-flow was our OWN apply/revert — keep the panel open
    setInlineEdit((ie) => (ie ? null : ie)); // external edit → close (keep)
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

  // ── Issue 050: 이미지 삽입 (드롭 존 + 업로드) — the SDK insert lane both shells share ──────────────────
  // Read an image File → its base64 payload (no `data:` prefix) + NATURAL pixel dims (for aspect sizing).
  // The engine validates the actual magic bytes, so this only needs the bytes + intrinsic size (022 폰트
  // 픽커의 파일 읽기와 동형; DOM-y so it lives in the React binding, not the core).
  const readImageFile = useCallback(
    (file: File) =>
      new Promise<{ dataB64: string; w: number; h: number }>((resolve, reject) => {
        const r = new FileReader();
        r.onerror = () => reject(new Error("파일 읽기 실패"));
        r.onload = () => {
          const dataUrl = String(r.result ?? "");
          const dataB64 = dataUrl.split(",")[1] ?? ""; // strip the "data:...;base64," prefix
          const img = new Image();
          img.onload = () => resolve({ dataB64, w: img.naturalWidth, h: img.naturalHeight });
          img.onerror = () => resolve({ dataB64, w: 0, h: 0 }); // couldn't read intrinsic size → 4:3 fallback
          img.src = dataUrl;
        };
        r.readAsDataURL(file);
      }),
    [],
  );

  // Insert an image File at a target block: AFTER `block`, or the section END when `block` is null. ONE
  // undo unit via `core.edit.insertImage` (→ InsertImage Intent → InsertImageAt op). The engine validates
  // the PNG/JPEG magic bytes + size cap, so a non-image / oversized drop REJECTS with an honest toast
  // (거짓 성공 없음). The natural-px → HWPUNIT sizing is `units.ts::imageInsertSize` (§4.5 single point).
  const insertImageFile = useCallback(
    async (file: File, section: number, block: number | null) => {
      if (!canEdit) {
        toast("이미지를 넣으려면 먼저 문서를 여세요");
        return;
      }
      try {
        const { dataB64, w, h } = await readImageFile(file);
        if (!dataB64) {
          toast("이미지를 읽지 못했습니다");
          return;
        }
        await core.edit.insertImage(dataB64, section, block, imageInsertSize(w, h));
        toast("이미지를 삽입했습니다");
      } catch (e) {
        if (!onTrap(e, "엔진 트랩 — 문서를 복구했습니다")) toast(`이미지 삽입 실패: ${e}`);
      }
    },
    [canEdit, core, toast, onTrap, readImageFile],
  );

  // Upload lane: the 툴바 "이미지" button → file picker → insert at the CURRENT selection (after the marked
  // block), else the doc END (block=null). Mirrors the desktop chat-attach anchor rule (현재 선택/문서 끝).
  const onUploadImage = useCallback(
    async (file: File) => {
      const first = selectionRef.current[0]?.anchor;
      await insertImageFile(file, first?.section ?? 0, first ? first.block : null);
    },
    [insertImageFile],
  );

  // Drop lane: map the drop point → the block under it (same page-coords → hitTest path as a click), so
  // the image anchors AFTER the pointed block; a miss (empty page area) → section END (block=null), exactly
  // like the desktop OS-drop. Read-only geometry — no selection change.
  const resolveDropTarget = useCallback(
    async (clientX: number, clientY: number): Promise<{ section: number; block: number | null }> => {
      const host = (document.elementFromPoint(clientX, clientY) as Element | null)?.closest?.(".hw-sheet") as HTMLElement | null;
      const svg = host?.querySelector("svg") as SVGSVGElement | null;
      if (host && svg && host.dataset.page != null) {
        const page = Number(host.dataset.page);
        const pt = screenToPage(clientX, clientY, svg.getBoundingClientRect(), readViewBox(svg));
        if (pt && Number.isFinite(page)) {
          try {
            const hit = await adapter.hitTest(page, pt.x, pt.y);
            if (hit) return { section: hit.section, block: hit.block };
          } catch {
            /* hit-test miss / trap → fall through to the section-end append */
          }
        }
      }
      return { section: 0, block: null };
    },
    [adapter],
  );

  // A file drag entered the page area → allow the drop + show the affordance. Preventing the default here
  // is what stops the browser from NAVIGATING to the dropped file (§함정: 웹 드롭이 파일 열기로 새지 않게).
  const onCanvasDragOver = useCallback((e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer?.types ?? []).includes("Files")) return; // internal drag → native behavior
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    setDragActive((cur) => cur || true);
  }, []);

  const onCanvasDragLeave = useCallback((e: React.DragEvent) => {
    // Ignore leaves into a CHILD of the canvas (dragover keeps firing); only clear when the pointer truly left.
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setDragActive(false);
  }, []);

  // The drop branch RULE (issue 050 §함정): IMAGE(png/jpg) → 삽입 · 문서(.hwp/.hwpx) → 열기(호스트로 전달) ·
  // 그 외 → 정직한 거부. A non-file drag (types has no "Files") is left to the browser (early return).
  const onCanvasDrop = useCallback(
    async (e: React.DragEvent) => {
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length === 0) return; // not a file drop → let the browser handle it (no navigation risk)
      e.preventDefault();
      setDragActive(false);
      const file = files[0];
      if (isImageFile(file)) {
        const { section, block } = await resolveDropTarget(e.clientX, e.clientY);
        await insertImageFile(file, section, block);
        if (files.length > 1) toast(`이미지 삽입됨 (나머지 ${files.length - 1}개는 건너뜀)`);
        return;
      }
      if (isDocFile(file)) {
        // A document = OPEN, which the HOST owns (props.document). Forward the bytes, or guide the user.
        if (props.onOpenFile) {
          const bytes = new Uint8Array(await file.arrayBuffer());
          await props.onOpenFile(bytes, file.name);
        } else {
          toast("문서 열기는 상단의 파일 열기를 사용하세요");
        }
        return;
      }
      toast("이미지(PNG·JPEG) 또는 .hwp/.hwpx 파일만 놓을 수 있습니다");
    },
    [insertImageFile, resolveDropTarget, props.onOpenFile, toast],
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

  // ── Issue 047: 열 너비 mm 다이얼로그 — precise mm + 균등 분배 (both reuse `onColCommit`'s apply-verify) ──
  // The dialog's live readouts, derived from `editTarget` (re-resolved on refreshToken → 적용-확인): the
  // target column index (the anchored cell's column), its measured mm width, and the 균등 분배 scope. A
  // single-column selection equalizes the WHOLE table (전 열 등폭 — 목표 2); a multi-column range equalizes
  // just that span (desktop 시맨틱). `null` when the target isn't a table with resolvable boundaries.
  const colWidthTarget = useMemo(() => {
    const b = editTarget?.boundaries;
    if (!b || b.length < 2) return null;
    const cols = b.length - 1;
    const c0 = editTarget?.cols?.[0] ?? 0;
    const c1 = editTarget?.cols?.[1] ?? c0;
    const col = Math.min(Math.max(0, c0), cols - 1);
    // Equalize the SELECTED span when it covers >1 column; otherwise the whole table (전 열).
    const [e0, e1] = c1 > c0 ? [c0, c1] : [0, cols - 1];
    return { boundaries: b, cols, col, e0, e1, currentMm: columnWidthMm(b, col), equalizeCount: e1 - e0 + 1 };
  }, [editTarget]);

  // Apply a precise mm width to the target column (mm→px via units.ts `setColumnWidthMm`, then the SAME
  // `onColCommit` apply-verify: re-query + confirm the boundary MOVED, honest failure toast otherwise). The
  // dialog stays open so its readout re-measures the real applied width (적용-확인 / 왕복 오차 반영).
  const onApplyColMm = useCallback(
    (mm: number) => {
      if (!colWidthTarget) return;
      void onColCommit(setColumnWidthMm(colWidthTarget.boundaries, colWidthTarget.col, mm));
    },
    [colWidthTarget, onColCommit],
  );

  // 균등 분배: equalize the target span to one width (units.ts `equalizeColumns`), committed through the SAME
  // apply-verify path. R13-4 lesson: the selection is by column INDEX (not px), so it stays valid after the
  // repaint; the geometry (boundaries) re-resolves via refreshToken, so the dialog readout refreshes too.
  const onEqualizeCols = useCallback(() => {
    if (!colWidthTarget) return;
    void onColCommit(equalizeColumns(colWidthTarget.boundaries, colWidthTarget.e0, colWidthTarget.e1));
  }, [colWidthTarget, onColCommit]);

  // ── Issue 047: 편집 중 셀음영 — set the CURRENTLY-edited cell's background WITHOUT leaving edit mode ──────
  // Applies a 1-cell `SetCellRangeShade` on the editor's cell (desktop R7-Part1 parity). `shading` shields
  // the refreshToken editor-close so the in-place editor stays open with its uncommitted text; the shade op
  // rebuilds nothing in the cell's paragraphs (op-bus SetTableCell leaves `shade_color`), so a later text
  // commit preserves the shade. The palette buttons `preventDefault` their mousedown so this never fires
  // via a blur→commit race (커밋/에디터 상태와 경합 금지).
  const shadeEditorCell = useCallback(
    async (hex: string | null) => {
      const ed = editorRef.current;
      if (!ed || ed.kind !== "cell") return;
      const r = ed.rows?.[0] ?? 0;
      const c = ed.cols?.[0] ?? 0;
      shadingRef.current++; // counted (issue 055 사후 #4): overlapping swatch applies arm one count each
      try {
        await core.edit.shadeCellRange(ed.section, ed.block, { r0: r, c0: c, r1: r, c1: c }, hex);
        toast(hex ? "배경색 적용" : "배경 지움");
        // Success: the shade's own re-flow CONSUMES one shield count inside the refreshToken close effect
        // (issue 055 — a setTimeout(0) release raced that effect under worker-mode RPC timing).
      } catch (e) {
        // Failure/trap: no shade re-flow will consume this count — disarm NOW so it can't swallow the
        // NEXT close (e.g. the trap-recovery refresh must still close the editor over stale geometry).
        disarmShield(shadingRef);
        if (!onTrap(e, "엔진 트랩 — 문서를 복구했습니다")) toast(`배경색 변경 실패: ${e}`);
      }
    },
    [core, toast, onTrap],
  );

  // Close the 열 너비 dialog if its target evaporates (selection cleared / became a non-table), so a stale
  // popover never lingers over the wrong thing. (An apply keeps it open — colWidthTarget re-resolves.)
  useEffect(() => {
    if (colWidthDialog && !colWidthTarget) setColWidthDialog(null);
  }, [colWidthDialog, colWidthTarget]);

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
          // issue 064 Tier-2: a NESTED cell is now EDITABLE. Resolve its descending CellPath (the engine's
          // `cell.path`, or the length-1 flat quad on an older backend) and prefill the LEAF cell's runs
          // through the path-aware read — no more "중첩표는 편집할 수 없습니다" toast.
          const path: CellAddr[] = cell.path && cell.path.length > 0 ? cell.path : [{ block: cell.block, row: cell.row, col: cell.col }];
          const runs = await core.session.runsAtPath(cell.section, path);
          setEditor({ page: c.page, box: { x: cell.x, y: cell.y, w: cell.w, h: cell.h }, section: cell.section, block: cell.block, kind: "cell", rows: [cell.row, cell.row], cols: [cell.col, cell.col], text: cell.text, runs, fontSizePt: firstRunStyle(runs).size_pt, path });
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
    [adapter, core, onTrap, toast],
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
        // issue 064 Tier-2: prefill via the anchor's descending CellPath so a NESTED selected cell edits
        // its LEAF (a length-1 path falls back to the flat read).
        const path: CellAddr[] = anchor.path && anchor.path.length > 0 ? anchor.path : [{ block: anchor.block, row, col }];
        const runs = await core.session.runsAtPath(anchor.section, path);
        setEditor({ page: mark.page, box: mark.box, section: anchor.section, block: anchor.block, kind: "cell", rows: [row, row], cols: [col, col], text: anchor.text ?? "", runs, fontSizePt: firstRunStyle(runs).size_pt, path });
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

  // ── issue 049: image move/resize commits (own-render only) ──────────────────────────────────────────
  // Locate the image's placed box across pages — a resize/move may REFLOW it onto a different page, so we
  // scan (cheap: only on a commit) and return the found page + box so the overlay re-places correctly.
  const findImageBbox = useCallback(
    async (section: number, block: number): Promise<{ page: number; box: ImageBox } | null> => {
      const n = core.session.pages;
      for (let p = 0; p < n; p++) {
        try {
          const b = await core.session.imageBbox(p, section, block);
          if (b) return { page: p, box: b };
        } catch {
          /* keep scanning — a transient page error shouldn't abort the locate */
        }
      }
      return null;
    },
    [core],
  );

  // Resolve the document block under a DROP point (own-engine hit-test), restricted to `section` (an image
  // move stays within its section). Skips the image overlay (which sits on top) so the page UNDER the
  // pointer is used. Returns the target block index, or null on a miss / cross-section drop.
  const resolveDropBlock = useCallback(
    async (clientX: number, clientY: number, section: number): Promise<number | null> => {
      let sheet: HTMLElement | null = null;
      for (const el of window.document.elementsFromPoint(clientX, clientY)) {
        if ((el as Element).closest("[data-image-overlay]")) continue;
        const s = (el as Element).closest(".hw-sheet") as HTMLElement | null;
        if (s && s.dataset.page != null) {
          sheet = s;
          break;
        }
      }
      const svg = sheet?.querySelector("svg") as SVGSVGElement | null;
      if (!sheet || !svg || sheet.dataset.page == null) return null;
      const page = Number(sheet.dataset.page);
      const pt = screenToPage(clientX, clientY, svg.getBoundingClientRect(), readViewBox(svg));
      if (!pt) return null;
      try {
        const hit = await adapter.hitTest(page, pt.x, pt.y);
        if (hit && hit.section === section) return hit.block;
      } catch {
        /* miss → no target */
      }
      return null;
    },
    [adapter],
  );

  // 이미지 크기 (issue 049): commit the overlay's NEW box (PAGE px) as `SetImageSize` (HWPUNIT via units.ts),
  // then RE-QUERY the image box and confirm the size actually changed (appliedReflectsResize — 적용-확인 /
  // false-success 차단). A no-op apply → honest failure toast, never a silent success. The px→HWPUNIT
  // conversion is the SINGLE `imageSizeToHwpunit` point. `imageCommitting` shields the refreshToken clear so
  // the re-place below survives the resize re-flow.
  const commitImageResize = useCallback(
    (pageBox: XYWH) => {
      const sel = imageSelRef.current;
      if (!sel || !canEdit) return;
      const before = { w: sel.box.w, h: sel.box.h };
      const intended = { w: pageBox.w, h: pageBox.h };
      const { width, height } = imageSizeToHwpunit(pageBox.w, pageBox.h);
      // Counted shield, effect-consumed (issue 055 사후 #9): +1 for THIS commit's own re-flow; the
      // refreshToken clear effect consumes it — the old setTimeout(0) release raced that effect under
      // worker macrotask timing (the same defect class shadingRef had) and dropped the handles.
      imageCommittingRef.current++;
      void (async () => {
        try {
          await core.edit.resizeImage(sel.box.section, sel.box.block, width, height);
          const found = await findImageBbox(sel.box.section, sel.box.block);
          if (!found) {
            setImageSel(null);
            toast("이미지 크기 변경이 반영되지 않았습니다 — 다시 시도하세요");
            return;
          }
          setImageSel(found); // re-place the handles on the (possibly reflowed) image
          if (!appliedReflectsResize(before, intended, { w: found.box.w, h: found.box.h })) {
            toast("이미지 크기 변경이 반영되지 않았습니다 — 다시 시도하세요");
            return;
          }
          toast("이미지 크기를 변경했습니다");
        } catch (e) {
          // Failure/trap: disarm so the recovery refresh still clears the (now stale) overlay.
          disarmShield(imageCommittingRef);
          if (!onTrap(e, "엔진 트랩 — 문서를 복구했습니다")) toast(`크기 변경 실패: ${e}`);
        }
      })();
    },
    [core, canEdit, findImageBbox, toast, onTrap],
  );

  // 이미지 이동 (issue 049): the engine move is an ANCHOR REORDER (실측) — resolve the DROP point to a block
  // index (`resolveDropBlock` → hitTest) and relocate the image THERE via `MoveImage`, NOT a free offset. A
  // drop onto the same block / a miss / a cross-section drop is a no-op (just re-place the handles). After a
  // real move, re-query the LANDED anchor and re-place; a not-found = honest failure toast (적용-확인).
  const commitImageMove = useCallback(
    (dropClientX: number, dropClientY: number) => {
      const sel = imageSelRef.current;
      if (!sel || !canEdit) return;
      void (async () => {
        let armed = false;
        try {
          const from = sel.box.block;
          const to = await resolveDropBlock(dropClientX, dropClientY, sel.box.section);
          if (to === null || to === from) {
            const found = await findImageBbox(sel.box.section, from);
            if (found) setImageSel(found);
            return; // no-op relocation (dropped on itself / off-page / cross-section) — no re-flow, no shield
          }
          const { width, height } = imageSizeToHwpunit(sel.box.w, sel.box.h); // preserve size across the move
          // Counted shield, effect-consumed (issue 055 사후 #9): armed only for a REAL move's re-flow (the
          // no-op path above never bumps, so arming there would leak a count) — replaces the setTimeout(0)
          // release that raced the refreshToken clear effect under worker macrotask timing.
          armed = true;
          imageCommittingRef.current++;
          await core.edit.moveImage(sel.box.section, from, to, width, height);
          // MoveImage removes at `from` then reinserts at the rebased `to`: the landed index is `to-1` when
          // moving down (the delete shifted it), else `to`.
          const landed = to > from ? to - 1 : to;
          const found = await findImageBbox(sel.box.section, landed);
          if (!found) {
            setImageSel(null);
            toast("이미지 이동이 반영되지 않았습니다 — 다시 시도하세요");
            return;
          }
          setImageSel(found);
          toast("이미지를 이동했습니다");
        } catch (e) {
          // Failure/trap: disarm so the recovery refresh still clears the (now stale) overlay.
          if (armed) disarmShield(imageCommittingRef);
          if (!onTrap(e, "엔진 트랩 — 문서를 복구했습니다")) toast(`이동 실패: ${e}`);
        }
      })();
    },
    [core, canEdit, resolveDropBlock, findImageBbox, toast, onTrap],
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
    (ed: { kind: string; section: number; block: number; rows?: [number, number]; cols?: [number, number]; path?: CellAddr[] }, runs: RunSpec[]) => {
      const intent: Intent =
        ed.kind === "paragraph"
          ? { intent: "SetParagraphRuns", section: ed.section, block: ed.block, runs }
          // issue 064 Tier-2: carry the descending CellPath so a NESTED cell commit walks to the LEAF.
          // A length-1 (or absent) path leaves the plain (index,row,col) route unchanged (back-compat).
          : { intent: "SetTableCellRuns", section: ed.section, index: ed.block, row: ed.rows?.[0] ?? 0, col: ed.cols?.[0] ?? 0, runs, ...(ed.path && ed.path.length > 1 ? { path: ed.path } : {}) };
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
  // un-latches and stays open with the move CANCELLED (031 apply-verify spirit). `tabMoving` is a COUNTED
  // shield (issue 055 사후 #9): armed +1 for the COMMIT's own re-flow only — a bare Tab (no edit) never
  // re-flows, so arming it would leak a count — and CONSUMED by the refreshToken close effect, which
  // replaces the old setTimeout(0) release that raced that effect under worker macrotask timing (the same
  // defect class shadingRef had: RPC replies land in plain macrotasks).
  const onEditorCommitMove = useCallback(
    async (dir: "left" | "right", runs: RunSpec[]) => {
      const ed = editorRef.current;
      if (!ed) return;
      try {
        // Commit run-preserving ONLY when the runs actually changed (a bare Tab through cells is a no-op —
        // no write, no undo unit); the move happens either way (issue 040 no-op guard + 036 Tab nav).
        if (!runsUnchanged(runs, ed.runs)) {
          tabMovingRef.current++;
          try {
            await applyEditorRuns(ed, runs);
          } catch (e) {
            disarmShield(tabMovingRef); // failed commit: no re-flow to shield; editor stays open on rethrow
            throw e;
          }
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
      } catch (e) {
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
      if (caretActiveRef.current) return; // 053: a LIVE cell caret owns 방향키/Enter (typing listener below)
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

  // ── issue 053: cell caret TYPING — a separate window keydown that acts only while a caret is live
  // (the 036 cell-nav listener yields via caretActiveRef, so 방향키/Enter never double-handle). Each
  // printable key / Backspace / Enter is ONE SetTableCellRuns undo unit through the controller's
  // ordered chain. IME: composition GUARD only (FG-13 inline 조합은 후속) — a composing keydown
  // (`isComposing` / keyCode 229) is ignored, so a half-composed 한글 음절이 자모로 커밋되지 않는다.
  useEffect(() => {
    if (!editingOn || !canEdit) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (!caretActiveRef.current) return;
      if (e.isComposing || e.keyCode === 229) return; // IME composition guard (053 scope)
      if (isEditableTarget(e.target as Element | null) || isEditableTarget(document.activeElement)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return; // ⌘Z/⌘F/zoom/… keep their owners
      const run = (p: Promise<unknown>) =>
        void p.catch((err) => {
          if (!onTrap(err, "엔진 트랩 — 문서를 복구했습니다")) toast(`입력 실패: ${err}`);
        });
      // 한글식 boundary fall-through: an arrow INSIDE the text moves the caret; an arrow that would
      // leave the text (offset 0 going left / paraLen going right, or any vertical arrow) CLEARS the
      // caret and hands the SAME press to the 036 cell-nav (셀 선택 이동) — 방향키 UX가 글자 단위에서
      // 셀 단위로 우아하게 강등되고, 036의 기존 방향키 회귀도 그대로 그린으로 남는다.
      const fallThroughTo = (dir: CellDir) => {
        core.cellCaret.clear();
        void moveCellAndScroll(dir);
      };
      const anchor = core.cellCaret.get()?.anchor ?? null;
      switch (e.key) {
        case "ArrowLeft":
          e.preventDefault();
          if (anchor && anchor.offset <= 0) fallThroughTo("left");
          else run(core.cellCaret.move(-1));
          return;
        case "ArrowRight":
          e.preventDefault();
          if (anchor && anchor.offset >= anchor.paraLen) fallThroughTo("right");
          else run(core.cellCaret.move(1));
          return;
        case "ArrowUp":
          e.preventDefault();
          fallThroughTo("up"); // 줄 단위 캐럿 이동은 v1 스코프 밖 — 셀 이동으로 강등
          return;
        case "ArrowDown":
          e.preventDefault();
          fallThroughTo("down");
          return;
        case "Backspace":
          e.preventDefault();
          run(core.cellCaret.deleteBack());
          return;
        case "Enter":
          e.preventDefault();
          run(core.cellCaret.insertText("\n"));
          return;
        default:
          if (e.key.length === 1) {
            e.preventDefault();
            run(core.cellCaret.insertText(e.key));
          }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [editingOn, canEdit, core, onTrap, toast, moveCellAndScroll]);

  // 053: the in-place editor and the caret are two text chromes — only one may be live. Opening the
  // editor (double-click / Enter-on-selection) drops the caret; closing it does NOT restore one.
  useEffect(() => {
    if (editor) core.cellCaret.clear();
  }, [editor, core]);

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

  // ── issue 048: persistent format ribbon — DUAL routing + reflected state ──────────────────────────────
  // The ribbon's `onPatch` is routed HERE (the desktop `FormatControls` onPatch semantic): while the
  // in-place editor is OPEN the delta styles the LIVE contentEditable selection via richedit.applyLiveStyle
  // (commit path / latch UNTOUCHED — no SetCellRange* op, no refreshToken, the editor keeps focus); with NO
  // editor open it drives the SAME shared `useSelectionActions` the 028 FloatingToolbar uses (공용 유틸 하나
  // — identical SetCellRangeFmt/SetCellRangeShade op + toast). 밑줄/취소선 are live-run only and 배경/정렬 are
  // cell ops, so the ribbon disables the non-applicable set per mode (below) — they never reach the wrong arm.
  const applyRibbon = useCallback(
    (p: FormatRibbonPatch) => {
      if (editorRef.current) {
        applyLiveStyle(
          { bold: p.bold, italic: p.italic, underline: p.underline, strike: p.strike, sizePt: p.sizePt, font: p.font, color: p.color },
          editorScaleRef.current,
        );
        // Reflect immediately in the ribbon toggles (the live path never re-reads the cell format).
        setRibbonFmt((prev) => ({
          bold: p.bold ?? prev.bold,
          italic: p.italic ?? prev.italic,
          underline: p.underline ?? prev.underline,
          strike: p.strike ?? prev.strike,
          sizePt: p.sizePt ?? prev.sizePt,
          color: p.color ?? prev.color,
        }));
        return;
      }
      // NOT editing → the shared selection-format actions (039), applied to the marked cell/range.
      if (p.bold !== undefined) fmtActions.bold();
      if (p.italic !== undefined) fmtActions.italic();
      if (p.sizePt !== undefined) fmtActions.setSize(p.sizePt);
      if (p.font !== undefined) fmtActions.setFont(p.font);
      if (p.color !== undefined) fmtActions.setColor(p.color);
      if (p.shade !== undefined) fmtActions.setShade(p.shade);
      if (p.align !== undefined) fmtActions.setAlign(p.align);
    },
    [fmtActions],
  );

  // Reflect the MARKED cell/range's first-run format in the ribbon when NOT editing (028 curBold 재사용 +
  // size/color). While editing, the caret listener below owns `ribbonFmt`, so this defers to it.
  useEffect(() => {
    if (editor) return;
    if (!editTarget) return;
    setRibbonFmt({
      bold: editTarget.curBold,
      italic: editTarget.curItalic,
      underline: false,
      strike: false,
      sizePt: editTarget.curSizePt ?? RIBBON_DEFAULT_PT,
      color: editTarget.curColor ?? null,
    });
  }, [editor, editTarget]);

  // Live-sync the ribbon to the caret while EDITING (desktop R11 selectionchange 패턴): read the effective
  // computed style at the selection anchor inside the in-place editor so 굵게/기울임/밑줄/취소선/크기/색이
  // 커서 위치를 실시간 반영. Torn down when the editor closes (the non-editing sync above resumes).
  useEffect(() => {
    if (!editor) return;
    const onSel = () => {
      const el = document.querySelector("[data-inline-edit]") as HTMLElement | null;
      if (!el) return;
      const s = readCaretStyle(el, editorScaleRef.current);
      if (!s) return;
      setRibbonFmt({ bold: s.bold, italic: s.italic, underline: s.underline, strike: s.strike, sizePt: s.size_pt, color: s.color });
    };
    document.addEventListener("selectionchange", onSel);
    onSel(); // seed from the mount select-all
    return () => document.removeEventListener("selectionchange", onSel);
  }, [editor]);

  // "AI에게 전달" (issue 028): the marked selection is ALREADY the anchor chip (anchors = selection); this
  // only bumps the token that focuses the chat composer. No new prompt logic, and the selection is NOT
  // cleared so the chips ride along with the next message (the existing captureAnchor flow).
  const onSendToAi = useCallback(() => setAiFocusToken((t) => t + 1), []);

  // 빈 줄 추가/삭제 (사용자 요청): a top-level PARAGRAPH selection can gain a blank spacer line BELOW it
  // (밀어내기 — nudge the following table/heading onto the next page) or, when itself blank, be removed.
  // Both go through editor-core (InsertParagraphAt with no runs / DeleteBlock) as ONE undo unit; the op-bus
  // throws on a bad target so a mistarget toasts rather than silently no-ops.
  const onInsertBlankLine = useCallback(
    async (section: number, block: number) => {
      try {
        await core.edit.insertBlankParagraph(section, block + 1); // BELOW the anchored paragraph
        toast("빈 줄을 추가했습니다");
      } catch (e) {
        if (!onTrap(e, "엔진 트랩 — 문서를 복구했습니다")) toast(`빈 줄 추가 실패: ${e}`);
      }
    },
    [core, toast, onTrap],
  );
  const onDeleteBlankLine = useCallback(
    async (section: number, block: number) => {
      try {
        await core.edit.deleteBlock(section, block);
        core.selection.clear(); // the deleted block's mark is gone; drop the stale selection
        toast("빈 줄을 삭제했습니다");
      } catch (e) {
        if (!onTrap(e, "엔진 트랩 — 문서를 복구했습니다")) toast(`빈 줄 삭제 실패: ${e}`);
      }
    },
    [core, toast, onTrap],
  );

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
  //
  // issue 055 (async 위생): the hit queries are ASYNC — with the worker backend their latency is real,
  // so rapid right-clicks can otherwise interleave (a LATE resolution replacing the menu the user —
  // or an e2e scan — is about to click detaches its buttons mid-click, and the replacement's items at
  // the same coordinates can swallow the click as a DIFFERENT action). Rule: THE LATEST right-click
  // OWNS THE MENU — a new right-click closes any open menu synchronously and stale resolutions are
  // dropped by sequence, never applied. (identical net behavior on the sync backend, where each
  // resolution lands before the next click can happen.) The sequence ref (`ctxMenuSeqRef`) is declared
  // with the menu state above; every DISMISS path bumps it too (issue 055 사후 #10).
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
      const seq = ++ctxMenuSeqRef.current;
      setContextMenu(null); // 이 우클릭이 메뉴의 주인 — 이전 메뉴는 즉시(동기) 닫는다
      const stale = () => ctxMenuSeqRef.current !== seq;
      const page = Number(sheet.dataset.page);
      const rect = svg.getBoundingClientRect();
      const pt = screenToPage(e.clientX, e.clientY, rect, readViewBox(svg));
      if (!pt) return;
      const clientX = e.clientX;
      const clientY = e.clientY;
      const click: PageClick = { page, x: pt.x, y: pt.y, meta: false, client: { x: clientX, y: clientY } };
      // 1) Update the selection so the marks show + the cell actions (굵게/음영/행 삽입) target this spot.
      //    06x drill: over a table cell we DRILL straight to the cell (a plain click would mark the whole
      //    table, leaving the cell format actions disabled); off a table we resolve like a normal click.
      try {
        const drilled = await core.selection.drillInto(page, pt.x, pt.y);
        if (!drilled) {
          await core.selection.pointerDown(toPointerInput(click));
          await core.selection.pointerUp(toPointerInput(click));
        }
      } catch (err) {
        onTrap(err, "엔진을 복구했습니다 — 다시 시도하세요");
      }
      // 2) Resolve what's under the point to branch the menu (cell > table/paragraph > 바탕).
      try {
        const cell = adapter.tableCellAt ? await adapter.tableCellAt(page, pt.x, pt.y) : null;
        if (stale()) return; // a newer right-click owns the menu — drop this resolution
        if (cell) {
          setContextMenu({ x: clientX, y: clientY, kind: "cell", click, cell: { section: cell.section, block: cell.block, row: cell.row, cols: cell.cols } });
          return;
        }
        const table = await adapter.tableAt(page, pt.x, pt.y);
        const hit = table ? null : await adapter.hitTest(page, pt.x, pt.y);
        if (stale()) return;
        const strictInside = !!hit && pt.x >= hit.x && pt.x <= hit.x + hit.w && pt.y >= hit.y && pt.y <= hit.y + hit.h;
        if (hit && hit.kind === "paragraph" && hit.editable && strictInside) {
          setContextMenu({ x: clientX, y: clientY, kind: "paragraph", click });
          return;
        }
        // A whole-table border / image / empty page area → 바탕(비개체) menu (표 추가).
        setContextMenu({ x: clientX, y: clientY, kind: "background", click });
      } catch (err) {
        if (!onTrap(err, "엔진을 복구했습니다 — 다시 시도하세요") && !stale()) setContextMenu({ x: clientX, y: clientY, kind: "background", click });
      }
    },
    [editingOn, adapter, core, onTrap],
  );

  // The 서체 catalog family names for the ribbon's 글꼴 dropdown (reuses the existing fontCatalog prop);
  // falls back to just the currently-applied face when no catalog is supplied.
  const fontFamilies = useMemo<readonly string[] | undefined>(() => {
    if (props.fontCatalog && props.fontCatalog.length > 0) return props.fontCatalog.map((f) => f.family);
    return selectedFont ? [selectedFont.family] : undefined;
  }, [props.fontCatalog, selectedFont]);

  // The page the compact "AI에게 전달" pill anchors to = the FIRST mark's page (multi-page selection → the
  // first mark's page). The pill hugs the selection UNION bbox on that page (reused from `unionPageBox`), so
  // it works for multi-select too (format now lives entirely in the persistent ribbon; the format controls'
  // enablement is derived below and drives the ribbon, not a floating bar).
  const toolbarPage = marks.length ? marks[0].page : null;
  const formatDisabledReason: string | undefined = !editTarget
    ? "여러 곳을 함께 선택하면 서식은 한 번에 적용할 수 없습니다 — 표의 한 셀/범위를 선택하세요"
    : editTarget.kind === "cell" || editTarget.kind === "range"
      ? fmtRange
        ? undefined
        : "이 셀에는 서식을 적용할 수 없습니다"
      : "표 셀/범위를 선택하면 서식을 적용할 수 있습니다";

  // ── issue 048: per-mode disabled reasons for the persistent ribbon ───────────────────────────────────
  // 편집 중이면 라이브 선택에 항상 적용 가능(inline·live 활성), 배경/정렬은 셀 op라 비활성(사유). 비편집이면
  // 셀/범위가 선택돼야 inline·cell op가 활성, 밑줄/취소선은 편집 상태에서만(사유). 조용한 무시 금지 (027 규칙).
  const ribbonEditing = editingOn && editor != null;
  const inlineDisabledReason = ribbonEditing ? undefined : formatDisabledReason;
  const liveOnlyDisabledReason = ribbonEditing ? undefined : "밑줄·취소선은 칸을 더블클릭해 편집할 때 적용할 수 있습니다";
  const cellOnlyDisabledReason = ribbonEditing ? "배경색·정렬은 편집을 마친 뒤 칸을 선택한 상태에서 적용됩니다" : formatDisabledReason;

  // pointer lifecycle → the core selection model (issues 021/023). React fires them fire-and-forget; the
  // core emits selection/marquee changes that useHwpEditor mirrors back into state.
  const onPointerDown = useCallback(
    (c: PageClick) => {
      ctxMenuSeqRef.current++; // 055 사후 #10: a new (left-click) gesture abandons an in-flight menu resolution
      // issue 06x: a press on the page SHEET is an EXTERNAL gesture (select elsewhere / deselect / drill) →
      // close the inline-edit panel KEEPING its change. Panel/affordance clicks stopPropagation (they never
      // reach this handler — the overlay is a sibling of the sheet), so this only fires on a real doc click.
      if (inlineEditRef.current) setInlineEdit(null);
      setPointerActive(true); // a gesture began → hide the floating toolbar until it settles (028)
      caretDownRef.current = { x: c.client.x, y: c.client.y }; // 053: measure click-vs-drag on release
      dragStartClientRef.current = { x: c.client.x, y: c.client.y }; // marquee: the drag-rect anchor
      lastMarqueeClientRef.current = { x: c.client.x, y: c.client.y };
      void core.selection.pointerDown(toPointerInput(c));
    },
    [core],
  );
  // Recompute + publish the marquee slices for a cursor client point (shared by pointermove + the edge
  // auto-scroll tick). Reads each page's client rect (DOM math) and hands per-page own-render PAGE-px
  // sub-rects to the DOM-free core. Below the drag threshold → empty slices (the core waits to start).
  const updateMarquee = useCallback(
    (clientX: number, clientY: number) => {
      const canvas = canvasRef.current;
      const start = dragStartClientRef.current;
      if (!canvas || !start) return;
      const moved = Math.hypot(clientX - start.x, clientY - start.y) > DRAG_THRESHOLD_PX;
      const slices = moved ? computeMarqueeSlices(canvas, start, { x: clientX, y: clientY }) : [];
      core.selection.pointerMoveMultipage({ x: clientX, y: clientY }, slices);
    },
    [core],
  );
  // Edge AUTO-SCROLL: while a marquee is live and the cursor sits near the canvas's top/bottom edge, scroll
  // the canvas so pages beyond the fold become reachable, then RE-SLICE at the (unchanged) cursor point over
  // the newly-scrolled pages. Self-perpetuating via rAF; stops when the cursor leaves the edge zone, the
  // scroll clamps, or the drag ends. Reads nothing that re-renders the workspace/sheets (issue 030 intact).
  const autoScrollStep = useCallback(() => {
    autoScrollRafRef.current = null;
    const canvas = canvasRef.current;
    const last = lastMarqueeClientRef.current;
    const start = dragStartClientRef.current;
    if (!canvas || !last || !start) return; // drag ended
    const rect = canvas.getBoundingClientRect();
    if (rect.height <= 0) return; // jsdom / not laid out → never auto-scroll
    let dy = 0;
    if (last.y < rect.top + AUTOSCROLL_EDGE) dy = -AUTOSCROLL_SPEED;
    else if (last.y > rect.bottom - AUTOSCROLL_EDGE) dy = AUTOSCROLL_SPEED;
    if (dy === 0) return; // cursor left the edge zone → stop the loop
    const before = canvas.scrollTop;
    canvas.scrollTop = before + dy;
    if (canvas.scrollTop !== before) updateMarquee(last.x, last.y); // pages moved → re-slice at the same point
    autoScrollRafRef.current = requestAnimationFrame(autoScrollStep);
  }, [updateMarquee]);
  // Kick off the auto-scroll loop iff the cursor is in an edge zone AND a marquee is actually live (never
  // during a plain click / block drag / image-handle drag). Idempotent — a running loop is left alone.
  const maybeAutoScroll = useCallback(
    (clientY: number) => {
      if (autoScrollRafRef.current != null) return; // already looping
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      if (rect.height <= 0) return;
      const inEdge = clientY < rect.top + AUTOSCROLL_EDGE || clientY > rect.bottom - AUTOSCROLL_EDGE;
      if (inEdge && core.selection.getMarquee() != null) autoScrollRafRef.current = requestAnimationFrame(autoScrollStep);
    },
    [autoScrollStep, core],
  );
  // Stop the auto-scroll loop + drop the drag-rect anchor (called on pointerup / gesture end).
  const stopMarqueeDrag = useCallback(() => {
    if (autoScrollRafRef.current != null) {
      cancelAnimationFrame(autoScrollRafRef.current);
      autoScrollRafRef.current = null;
    }
    dragStartClientRef.current = null;
    lastMarqueeClientRef.current = null;
  }, []);
  const onPointerMove = useCallback(
    (c: PageClick) => {
      lastMarqueeClientRef.current = { x: c.client.x, y: c.client.y };
      updateMarquee(c.client.x, c.client.y);
      maybeAutoScroll(c.client.y);
    },
    [updateMarquee, maybeAutoScroll],
  );
  // Figma progressive table selection (issue 06x): what a DOUBLE-CLICK does depends on where + what is
  // already selected. Over a paragraph (no table) → open its in-place editor directly (unchanged). Over a
  // table cell → DRILL: the first double-click selects the cell (no editor); a second double-click on the
  // SAME already-drilled cell opens the editor. Enter over a drilled cell also opens it (036 keydown).
  const handleDoubleClick = useCallback(
    async (c: PageClick) => {
      try {
        const table = await adapter.tableAt(c.page, c.x, c.y);
        if (!table) {
          void openEditorAt(c); // paragraph double-click → open the editor directly (unchanged)
          return;
        }
        const cell = adapter.tableCellAt ? await adapter.tableCellAt(c.page, c.x, c.y) : null;
        // issue 064 Tier-2: a NESTED cell drills + edits like any cell (no more refusal toast). The
        // "already-drilled cell → open editor" test compares the DESCENDING CellPath so a nested leaf is
        // matched precisely (its flat (block,row,col) alone can collide across nesting levels).
        const cur = core.selection.currentCell();
        const cellPath = cell ? (cell.path && cell.path.length > 0 ? cell.path : [{ block: cell.block, row: cell.row, col: cell.col }]) : null;
        const curPath = cur ? (cur.path && cur.path.length > 0 ? cur.path : [{ block: cur.block, row: cur.row, col: cur.col }]) : null;
        const onDrilledCell =
          !!cell && !!cur && !!cellPath && !!curPath && cur.section === cell.section && samePath(cellPath, curPath);
        if (onDrilledCell) {
          void openEditorAt(c); // the cell is already drilled/selected → this double-click opens the editor
        } else {
          await core.selection.drillInto(c.page, c.x, c.y); // drill into the cell (select it, no editor yet)
        }
      } catch (e) {
        onTrap(e, "엔진을 복구했습니다 — 다시 시도하세요");
      }
    },
    [adapter, core, openEditorAt, onTrap, toast],
  );
  // Detect a double-click (two ups within 400ms, ~same client point) → the Figma drill/edit handler.
  const detectDoubleClick = useCallback(
    (c: PageClick) => {
      const now = Date.now();
      const prev = lastUpRef.current;
      if (prev && now - prev.t < 400 && Math.hypot(c.client.x - prev.x, c.client.y - prev.y) < 6) {
        lastUpRef.current = null;
        void handleDoubleClick(c);
      } else {
        lastUpRef.current = { t: now, x: c.client.x, y: c.client.y };
      }
    },
    [handleDoubleClick],
  );
  // issue 053: place the CELL TEXT CARET on a plain click (movement under the drag threshold). Runs
  // AFTER the selection resolve so the caret and the cell mark coexist (클릭 = 셀 마크 + 글리프 캐럿).
  // A miss (off any cell text) CLEARS the caret inside the controller (018 null policy) — clicking a
  // body paragraph or empty space never leaves a stale caret behind. Fire-and-forget; a trap recovers.
  const placeCaretAt = useCallback(
    (c: PageClick) => {
      if (!editingOn || !canEdit || editorRef.current || !core.cellCaret.supported) return;
      const down = caretDownRef.current;
      if (down && Math.hypot(c.client.x - down.x, c.client.y - down.y) >= 4) return; // a drag, not a click
      // 06x drill model: a single WHOLE-TABLE click must not leave a stray text caret (the cell isn't
      // drilled yet). When the click resolved to a lone table anchor, clear any prior caret and bail; a
      // DRILLED cell (cell anchor) or a bare cell-text click (no table geometry) still places its caret.
      const sels = core.selection.getSelection();
      if (sels.length === 1 && sels[0].anchor.kind === "table") {
        core.cellCaret.clear();
        return;
      }
      void core.cellCaret.clickAt(c.page, c.x, c.y).catch((e) => onTrap(e, "엔진을 복구했습니다 — 다시 시도하세요"));
    },
    [editingOn, canEdit, core, onTrap],
  );

  const onPointerUp = useCallback(
    (c: PageClick) => {
      setPointerActive(false); // gesture ended → the toolbar re-appears once the new selection resolves
      stopMarqueeDrag(); // multi-page marquee: end any edge auto-scroll + drop the drag-rect anchor
      // issue 049: an image click SELECTS the image (its own 8-handle overlay), NOT a block. Probe `imageAt`
      // FIRST (the image sits on top of its paragraph band); on a hit take over the selection + skip the
      // block-select/double-click. A miss falls through to the normal selection resolve. The overlay owns its
      // OWN drag (stopPropagation), so a pointerup reaching here is always a fresh click, never a handle drag.
      if (editingOn && adapter.imageAt) {
        void (async () => {
          let img: ImageBox | null = null;
          try {
            img = (await adapter.imageAt!(c.page, c.x, c.y)) ?? null;
          } catch (e) {
            onTrap(e, "엔진을 복구했습니다 — 다시 시도하세요");
          }
          if (img) {
            core.selection.clear(); // block selection cleared + drag reset — the image overlay takes over
            core.cellCaret.clear(); // 053: an image selection and a text caret never coexist
            setEditor(null);
            setImageSel({ page: c.page, box: img });
            lastUpRef.current = null; // never let an image click count toward a double-click
            return;
          }
          setImageSel((s) => (s ? null : s)); // clicked off any image → drop the image selection
          void core.selection.pointerUp(toPointerInput(c));
          placeCaretAt(c); // 053: plain click → cell text caret (a miss clears it)
          detectDoubleClick(c);
        })();
        return;
      }
      void core.selection.pointerUp(toPointerInput(c));
      if (!editingOn) return;
      placeCaretAt(c); // 053
      detectDoubleClick(c);
    },
    [core, editingOn, adapter, onTrap, detectDoubleClick, placeCaretAt, stopMarqueeDrag],
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

  // ── issue 06x: INLINE per-element edit — apply/revert wiring ─────────────────────────────────────────
  // Open the inline panel over the CURRENT single target (block selection or image). Snapshot so the panel
  // stays put across the apply's re-flow. Guarded to a single target + an editable doc (mirrors the
  // affordance render gate) so a stale gesture can't open it over nothing.
  const openInlineEdit = useCallback(() => {
    if (!editingOn || !canEdit) return;
    const t = inlineTarget;
    if (t) setInlineEdit(t);
  }, [editingOn, canEdit, inlineTarget]);

  const closeInlineEdit = useCallback(() => setInlineEdit(null), []);

  // APPLY the inline proposal as ONE undo batch — the SAME commit the chat uses, minus the selection-clear
  // (`session.applyBatch`, not `edit.apply`) so the selection/snapshot survive and the panel can show its
  // applied summary + offer 되돌리기. Arms `inlineEditShieldRef` so this re-flow doesn't trip the guard that
  // closes on EXTERNAL edits; an IMAGE target also arms `imageCommitting` so the image-clear effect keeps
  // `imageSel` (the snapshot the affordance/overlay derive from) instead of dropping it on our own re-flow.
  // Returns the applied cards (via the SAME `describeIntent` renderer the chat cards use) for the summary.
  const onInlineApply = useCallback(
    async (intents: Intent[]): Promise<IntentCard[]> => {
      const isImage = inlineEditRef.current?.kind === "image";
      inlineEditShieldRef.current++;
      if (isImage) imageCommittingRef.current++;
      try {
        await core.session.applyBatch(intents);
        toast(`적용됨: ${intents.length}개 편집`);
        return core.edit.preview(intents);
      } catch (e) {
        disarmShield(inlineEditShieldRef);
        if (isImage) disarmShield(imageCommittingRef);
        if (!onTrap(e, "엔진 트랩 — 문서를 복구했습니다. 마지막 편집은 취소되었습니다")) {
          /* non-trap error: surfaced by the inline panel's own catch → error state */
        }
        throw e;
      }
    },
    [core, toast, onTrap],
  );

  // REVERT the applied batch — it is the undo-stack top immediately after our apply, so ONE `session.undo()`
  // pops exactly it. Arm the shield so the undo's re-flow doesn't re-trip the (already-closing) panel guard.
  const onInlineRevert = useCallback(async () => {
    inlineEditShieldRef.current++;
    try {
      if (await core.session.undo()) toast("되돌렸습니다");
    } catch (e) {
      disarmShield(inlineEditShieldRef);
      onTrap(e, "엔진 트랩 — 문서를 복구했습니다");
    }
  }, [core, toast, onTrap]);

  const undo = useCallback(async () => {
    if (await core.session.undo()) toast("실행취소");
  }, [core, toast]);

  const redo = useCallback(async () => {
    if (await core.session.redo()) toast("다시 실행");
  }, [core, toast]);

  // ── Feature C: persistent per-card 되돌리기 on applied chat turns ─────────────────────────────────────
  // The chat records each applied turn's undo-stack depth (via `undoDepth`) and offers 되돌리기 only while
  // that batch is still the TOP of the stack; `revertChatEdit` then pops exactly it (`session.undo` reverts
  // the whole batch as one unit, same lane as the global ⌘Z). Stable getter so the chat can read the LIVE
  // depth after an apply and re-derive top-of-stack across global undo/redo. Trap-safe like `onApply`.
  const undoDepth = useCallback(() => core.session.undoDepth(), [core]);
  const revertChatEdit = useCallback(async (): Promise<boolean> => {
    try {
      const ok = await core.session.undo();
      if (ok) toast("되돌렸습니다");
      return ok;
    } catch (e) {
      onTrap(e, "엔진 트랩 — 문서를 복구했습니다. 마지막 편집은 취소되었습니다");
      return false;
    }
  }, [core, toast, onTrap]);

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

  // Toggle "레이아웃 정리" (layout normalization). The core re-paginates + re-renders (the refreshToken
  // effect re-fetches page SVGs). The engine report tells us whether THIS document actually looked
  // degraded, so we can distinguish "정리됨" from "이미 정상 (변화 없음)".
  const toggleNormalize = useCallback(async () => {
    if (normalizeBusy) return;
    const next = !normalizeOn;
    setNormalizeBusy(true);
    try {
      const report = await core.session.setNormalize(next);
      setNormalizeOn(next);
      if (!next) toast("원본 그대로 렌더합니다.");
      else if (report?.applied)
        toast(`레이아웃 정리: 줄간격 ${report.loosePct}%→${report.targetPct}% (${report.paragraphsTouched}개 문단)`);
      else toast("이미 원본이 정상이라 바뀐 것이 없습니다.");
    } catch (e) {
      toast(`레이아웃 정리 실패: ${e}`);
    } finally {
      setNormalizeBusy(false);
    }
  }, [core, normalizeOn, normalizeBusy, toast]);

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
          the SVG on screen matches the exported PDF. Injected only when a font is selected. Issue 058:
          also bind the OFL serif substitute (`serifUrl`) so 명조 runs render serif — the attribute-scoped
          serif rule out-specifies the blanket collapse, preserving the doc's 명조↔고딕 distinction. */}
      {selectedFont && <style data-testid="hw-fontface">{buildFontFaceCss(selectedFont.family, selectedFont.url, { serifUrl, boldUrl, serifBoldUrl })}</style>}
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
        {/* issue 050: 이미지 업로드 — the toolbar twin of the drop zone (파일 픽커 → 현재 선택/문서 끝).
            The hidden input carries `accept` so the OS picker pre-filters to PNG/JPEG; the ENGINE still
            re-validates the magic bytes (a spoofed extension is refused). Shown with the editing chrome. */}
        {editingOn && (
          <>
            <button className="hw-tool" onClick={() => imageInputRef.current?.click()} disabled={!canEdit} title="이미지 삽입">
              이미지
            </button>
            <input
              ref={imageInputRef}
              type="file"
              accept="image/png,image/jpeg"
              data-testid="hw-image-input"
              style={{ display: "none" }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = ""; // allow re-selecting the same file
                if (f) void onUploadImage(f);
              }}
            />
          </>
        )}
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
        {normalizeSupported && (
          <button
            className={`hw-tool${normalizeOn ? " hw-tool-active" : ""}`}
            onClick={() => void toggleNormalize()}
            disabled={!meta || normalizeBusy}
            aria-pressed={normalizeOn}
            title={
              normalizeOn
                ? "레이아웃 정리 켜짐 — 눌러서 원본 그대로 보기 (hwpx 변환으로 벌어진 줄간격을 조여 원본에 가깝게)"
                : "레이아웃 정리 — hwp→hwpx 변환으로 벌어진 줄간격을 원본에 가깝게 조입니다"
            }
          >
            {normalizeBusy ? "정리 중…" : "레이아웃 정리"}
          </button>
        )}
        <button className="hw-tool" onClick={exportHtml} disabled={!meta} title="HTML 다운로드">
          HTML
        </button>
        <button className="hw-tool hw-tool-accent" onClick={exportPdf} disabled={!meta} title="PDF 다운로드">
          PDF
        </button>
      </div>

      {/* issue 048 → 06x: the PERSISTENT format ribbon is now the SOLE format surface (the 028 per-selection
          floating toolbar was removed — 피그마식 상시 리본). Shown whenever the editing chrome is on and a
          document is open (like a normal editor's ribbon; it never floats over the content). DUAL-MODE via
          `applyRibbon`: 편집 중이면 라이브 선택 스타일(applyLiveStyle), 아니면 선택 셀/범위의 서식
          op(useSelectionActions). 서체 catalog is passed through so 글꼴 lives here too (the only control the
          old floating bar had that the ribbon lacked). */}
      {editingOn && meta && (
        <FormatRibbon
          fmt={ribbonFmt}
          editing={ribbonEditing}
          onPatch={applyRibbon}
          fonts={fontFamilies}
          inlineDisabledReason={inlineDisabledReason}
          liveOnlyDisabledReason={liveOnlyDisabledReason}
          cellOnlyDisabledReason={cellOnlyDisabledReason}
        />
      )}

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
            // The thumbnail rail (heading-less fallback) pulls each page's own-render SVG through the SAME
            // adapter the page view uses; refreshToken re-rasters after an edit. SVG → sanitizeSvg → <img> (R7).
            adapter={adapter}
            refreshToken={refreshToken}
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
            // A press on the gray canvas background (outside every page sheet) clears the selection. A press
            // ON the image overlay is that overlay's own gesture (it stops propagation) — this only fires for
            // a true background click, which also drops the image selection (issue 049).
            if (!(e.target as HTMLElement).closest(".hw-sheet")) {
              clearSelection();
              setImageSel((s) => (s ? null : s));
            }
          }}
          // issue 039: right-click → context menu (only on a page sheet; §함정 시트 위에서만 기본 메뉴 차단).
          onContextMenu={(e) => void onSheetContextMenu(e)}
          // issue 050: the image DROP ZONE. onDragOver.preventDefault stops the browser from navigating to
          // a dropped file; onDrop branches 이미지=삽입 / 문서=열기 / 그 외=거부 (see onCanvasDrop).
          onDragOver={onCanvasDragOver}
          onDragLeave={onCanvasDragLeave}
          onDrop={(e) => void onCanvasDrop(e)}
        >
          {/* issue 050: the drop affordance — a non-interactive hint shown while a file drag hovers an
              editable doc. pointer-events:none so it never eats the drop (§함정), like the selection overlay. */}
          {dragActive && canEdit && (
            <div className="hw-drop-overlay" data-testid="hw-drop-overlay">
              <div className="hw-drop-hint">여기에 이미지를 놓아 삽입 (PNG·JPEG)</div>
            </div>
          )}
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
                    {/* issue 053: the blinking cell text caret — an ISOLATED layer on the marquee pattern
                        (presence = rare setState; every move = a ref DOM write, 0 workspace renders).
                        issue 059: it takes the composition store so its bar HIDES while an IME composition is
                        live (the ImeCompositionLayer draws the composition caret — no double bar). */}
                    {editingOn && canEdit && <CaretLayer core={core} page={page} scale={scale} composition={compositionStore} />}
                    {/* issue 059: IME inline composition — the caret-tracking hidden textarea (input capture)
                        + the compositionView overlay. Same isolation as CaretLayer: a composition never
                        re-renders the workspace/sheets (position + composing text are ref writes). */}
                    {editingOn && canEdit && (
                      <ImeCompositionLayer core={core} page={page} scale={scale} store={compositionStore} commit={commitComposition} />
                    )}
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
                    {/* issue 049: the image move/resize 8-handle overlay. A drag lives in the OVERLAY's local
                        state (workspace render 0 — 030); a commit re-places it from `imageBbox` (적용-확인).
                        Move is an anchor reorder (resolveDropBlock → MoveImage), resize is SetImageSize with
                        corner aspect-lock. Only shown when a document is editable (canEdit) so the handles
                        never promise an edit the backend will refuse. */}
                    {/* issue 06x: hide the 8-handle overlay while the inline-edit panel is open (one image
                        surface at a time — the panel owns the interaction, the stale handles would confuse). */}
                    {editingOn && canEdit && imageSel && imageSel.page === page && !inlineEdit && (
                      <ImageOverlay
                        box={imageSel.box}
                        scale={scale}
                        onCommitResize={commitImageResize}
                        onCommitMove={commitImageMove}
                        onDismiss={() => setImageSel(null)}
                      />
                    )}
                    {/* issue 06x': ONE Cursor-style compact ACTION BAR for the selection (the 028 floating
                        format toolbar is gone — formatting lives in the persistent ribbon). A single horizontal
                        row anchored at the selection UNION bbox's bottom-right, holding "여기서 편집" (inline edit,
                        only for a LONE editable target) + "AI에게 전달" (chat, any selection) SIDE BY SIDE — never
                        two stacked rows. Gate = marks.length > 0; hidden mid-gesture / while the in-place editor,
                        context menu, or inline panel is up. `stopPropagation` on pointerDown so a click on the bar
                        isn't read as an empty-space DESELECT. The buttons only bump `aiFocusToken` / open the
                        inline panel — no selection churn (028 render-isolation). */}
                    {editingOn && canEdit && toolbarPage === page && marks.length > 0 && !pointerActive && !editor && !contextMenu && !inlineEdit && (() => {
                      const u = unionPageBox(marks.filter((m) => m.page === page).map((m) => m.box));
                      if (!u) return null;
                      const showEdit = !!inlineTarget && inlineTarget.page === page; // lone editable target → offer inline edit
                      // 빈 줄 추가/삭제 (사용자 요청): a LONE top-level paragraph selection can gain a blank
                      // spacer below it, or — when itself blank — be deleted. Tables/cells/ranges/images
                      // don't get these (blank-line spacing is a body-paragraph affordance).
                      const paraSel =
                        selection.length === 1 && selection[0].anchor.kind === "paragraph" ? selection[0].anchor : null;
                      const paraIsBlank = !!paraSel && !(paraSel.text ?? "").trim();
                      return (
                        <div
                          className="hw-sel-actions"
                          style={{ left: (u.x + u.w) * scale, top: (u.y + u.h) * scale }}
                          onPointerDown={(e) => e.stopPropagation()}
                        >
                          {paraSel && (
                            <>
                              <button
                                type="button"
                                className="hw-sel-action"
                                data-testid="hw-blankline-add"
                                title="이 줄 아래에 빈 줄 추가 (다음 내용을 아래로 밀기)"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void onInsertBlankLine(paraSel.section, paraSel.block);
                                }}
                              >
                                ＋ 빈 줄
                              </button>
                              <button
                                type="button"
                                className="hw-sel-action"
                                data-testid="hw-blankline-del"
                                disabled={!paraIsBlank}
                                title={paraIsBlank ? "이 빈 줄 삭제" : "빈 줄만 삭제할 수 있어요 (내용이 있는 줄은 AI/편집으로)"}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (paraIsBlank) void onDeleteBlankLine(paraSel.section, paraSel.block);
                                }}
                              >
                                － 빈 줄
                              </button>
                            </>
                          )}
                          {showEdit && (
                            <button
                              type="button"
                              className="hw-sel-action"
                              data-testid="hw-inline-open"
                              title="이 요소를 여기서 바로 AI로 편집"
                              onClick={(e) => {
                                e.stopPropagation();
                                openInlineEdit();
                              }}
                            >
                              ✨ 여기서 편집
                            </button>
                          )}
                          <button
                            type="button"
                            className="hw-sel-action"
                            data-testid="hw-ai-send"
                            title="선택을 AI에게 전달 (채팅으로 편집)"
                            onClick={(e) => {
                              e.stopPropagation();
                              onSendToAi();
                            }}
                          >
                            ✨ AI에게 전달
                          </button>
                        </div>
                      );
                    })()}
                    {/* issue 032/040: the Figma-style IN-PLACE rich editor sits over the cell rect at the
                        cell's own font size (no popover card). It renders the cell's styled RUNS so partial
                        formatting shows + round-trips; onCommit returns the serialized runs as a Promise so
                        the editor un-latches + stays open on failure; onCancel (Esc) just closes it. */}
                    {editingOn && editor && editor.page === page && (() => {
                      // issue 048: capture the OPEN editor's page scale so the ribbon's applyLiveStyle uses the
                      // SAME size↔px conversion as the editor's own ⌘-formatting (client px / own-render px).
                      editorScaleRef.current = scale;
                      return (
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
                      );
                    })()}
                    {/* issue 047 목표 3: 편집 중 셀음영 — while a CELL is being edited in place, a swatch bar
                        lets the user set that cell's background without leaving edit mode (desktop R7-Part1).
                        Its buttons preventDefault mousedown so they never blur→commit the editor; the apply is
                        shielded so the editor stays open with its uncommitted text (커밋/에디터 경합 금지). */}
                    {editingOn && editor && editor.kind === "cell" && editor.page === page && (
                      <CellShadePalette box={editor.box} scale={scale} onPick={(hex) => void shadeEditorCell(hex)} />
                    )}
                    {/* (issue 06x': the "✨ 여기서 편집" affordance now lives INSIDE the unified .hw-sel-actions
                        bar above, side-by-side with "AI에게 전달" — Cursor-style single row, no stacked pills.) */}
                    {/* issue 06x: the OPEN inline-edit panel, anchored BELOW the target. Reuses the chat's
                        onAiRequest (anchors=[target]) + applies as one batch; apply-then-revert lives inside. */}
                    {editingOn && inlineEdit && inlineEdit.page === page && (
                      <InlineEditPanel
                        box={inlineEdit.box}
                        scale={scale}
                        targetLabel={inlineEdit.label}
                        anchor={inlineEdit.anchor}
                        onAiRequest={props.onAiRequest}
                        docContext={core.session.docContext([inlineEdit.anchor])}
                        onApply={onInlineApply}
                        onRevert={onInlineRevert}
                        onClose={closeInlineEdit}
                        modLabel={mod}
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
          // issue 051: async card enrichment — a DeleteBlock proposal shows the target block's 원문
          // (EditController.previewCards reads it via session.runsAt) before the explicit 적용 approval.
          previewCards={(intents) => core.edit.previewCards(intents)}
          // Feature C: persistent per-card 되돌리기 (top-of-stack v1) — reverts the applied batch as one unit.
          onRevert={revertChatEdit}
          undoDepth={undoDepth}
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
        const close = () => {
          ctxMenuSeqRef.current++; // 055 사후 #10: a dismiss (Esc/외부클릭/스크롤/액션) invalidates in-flight resolutions too
          setContextMenu(null);
        };
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
          // issue 047: 열 너비… → the precise mm + 균등 분배 dialog (opened at the menu anchor). Needs a
          // table with ≥2 resolvable column boundaries; disabled with a reason otherwise (미지원은 조용한
          // 무시 금지). Delegates to the SAME `onColCommit` apply-verify the drag handles use.
          const colOk = !!colWidthTarget && colWidthTarget.cols >= 2;
          items.push({
            type: "action",
            key: "colwidth",
            label: "열 너비…",
            icon: "↔",
            disabled: !colOk,
            title: colOk ? undefined : "열이 2개 이상인 표에서 열 너비를 조정할 수 있습니다",
            onSelect: () => setColWidthDialog({ x: cm.x, y: cm.y }),
          });
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
      {/* issue 047: the 열 너비 mm + 균등 분배 dialog. Its readouts (currentMm / column span) come LIVE from
          `colWidthTarget` (= editTarget, re-resolved on refreshToken) so an apply's re-measured width shows
          immediately (적용-확인). Both actions commit through the SAME `onColCommit` apply-verify. */}
      {colWidthDialog && colWidthTarget && (
        <ColumnWidthDialog
          x={colWidthDialog.x}
          y={colWidthDialog.y}
          currentMm={colWidthTarget.currentMm}
          columnLabel={`${colWidthTarget.col + 1}열`}
          equalizeCount={colWidthTarget.equalizeCount}
          onApplyMm={onApplyColMm}
          onEqualize={() => {
            onEqualizeCols();
            setColWidthDialog(null);
          }}
          onClose={() => setColWidthDialog(null)}
        />
      )}
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
