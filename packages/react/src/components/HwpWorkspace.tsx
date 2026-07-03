import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EngineAdapter } from "../EngineAdapter";
import { modLabel } from "../platform";
import type { Anchor, BlockHit, CellHit, DocContext, Intent, OnAiRequest, OpenResult, TableBox } from "../types";
import { ChatPanel } from "./ChatPanel";
import { HwpPageView, type PageClick } from "./HwpPageView";
import { SelectionOverlay, type Marquee, type Mark } from "./SelectionOverlay";
import { FontPicker } from "./FontPicker";
import { buildFontFaceCss, type FontCatalogEntry } from "../fonts";

export interface HwpWorkspaceProps {
  /** The backend seam (WasmAdapter for the web, or a host adapter). */
  adapter: EngineAdapter;
  /** The document to open (bytes + optional name). Re-opens when the `bytes` reference changes. When
   *  omitted, the workspace shows an empty state (the host drives opening). */
  document?: { bytes: Uint8Array; name?: string } | null;
  /** The host AI bridge (R6): instruction + anchors + doc context → Intents. Never an LLM in-package. */
  onAiRequest: OnAiRequest;
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
  className?: string;
}

/** One selected block = its structural Anchor (rides to the chat) + its visual Mark (drawn on the page).
 *  The selection array is the SINGLE source of truth (issue 021); `anchors`/`marks` are views of it. */
type Sel = { anchor: Anchor; mark: Mark };

/** Selection identity for replace/toggle/union dedup. A whole-block selection (paragraph/table from
 *  click or marquee) is identified by `(section, block)`; a CELL anchor (issue 023) additionally by its
 *  `rows`/`cols` so distinct cells of the SAME table are distinct selections (⌘-click toggles the exact
 *  clicked cell). Blocks carry no rows/cols → an empty `::` suffix, so their identity is unchanged. */
const selKey = (a: Anchor): string => {
  const r = a.rows ? `${a.rows[0]}-${a.rows[1]}` : "";
  const c = a.cols ? `${a.cols[0]}-${a.cols[1]}` : "";
  return `${a.section}:${a.block}:${r}:${c}`;
};

/** Movement (in CLIENT px) past which a press becomes a drag (marquee) rather than a click. */
const DRAG_THRESHOLD_PX = 4;

/** Cell chip label = a short text snippet + a 1-based "N행 M열" (issue 023). Empty cell → "표 N행 M열".
 *  The snippet is trimmed/whitespace-collapsed and elided to ~12 chars. */
function cellLabel(cell: CellHit): string {
  const snip = cell.text.trim().replace(/\s+/g, " ").slice(0, 12);
  const where = `${cell.row + 1}행 ${cell.col + 1}열`;
  return snip ? `“${snip}” (${where})` : `표 ${where}`;
}

/** Derive a Sel from a resolved click hit. Priority: CELL > table > block band (issue 023 — a click
 *  inside a table anchors the exact cell; a cell miss on a border/merged boundary falls back to the
 *  whole-table anchor, never an error). Coordinates are STRUCTURE indices, never px — a cell anchor's
 *  `rows`/`cols` are the MODEL-GLOBAL cell address `[r,r]`/`[c,c]` (PlacedCell.row is already global on a
 *  split fragment; NEVER re-add first_row). Returns null when the point resolved to nothing. */
function deriveSel(page: number, table: TableBox | null, cell: CellHit | null, hit: BlockHit | null): Sel | null {
  if (cell) {
    const label = cellLabel(cell);
    return {
      mark: { page, box: { x: cell.x, y: cell.y, w: cell.w, h: cell.h }, label, kind: "cell" },
      anchor: {
        kind: "cell",
        section: cell.section,
        block: cell.block,
        rows: [cell.row, cell.row],
        cols: [cell.col, cell.col],
        label,
        page,
        text: cell.text,
      },
    };
  }
  if (table) {
    const label = `표 (p.${page + 1})`;
    return {
      mark: { page, box: { x: table.x, y: table.y, w: table.w, h: table.h }, label, kind: "table" },
      anchor: { kind: "table", section: table.section, block: table.block, label, page },
    };
  }
  if (hit) {
    const snip = hit.text.trim().replace(/\s+/g, " ").slice(0, 14);
    const kind = hit.kind === "table" ? "table" : hit.kind === "image" ? "image" : "paragraph";
    const label = kind === "paragraph" ? (snip ? `“${snip}”` : `문단 (p.${page + 1})`) : `${kind} (p.${page + 1})`;
    return {
      mark: { page, box: { x: hit.x, y: hit.y, w: hit.w, h: hit.h }, label, kind },
      anchor: { kind: kind === "image" ? "paragraph" : (kind as Anchor["kind"]), section: hit.section, block: hit.block, label, page, text: hit.text },
    };
  }
  return null;
}

/** Convert a marquee BlockHit to a Sel, EXCLUDING unsupported kinds (images can't be anchored — issue
 *  §함정). Returns null for an excluded hit so the caller can count what was dropped. */
function blockHitToSel(hit: BlockHit, page: number): Sel | null {
  if (hit.kind === "image") return null; // not an editable anchor target
  const snip = hit.text.trim().replace(/\s+/g, " ").slice(0, 14);
  const kind = hit.kind === "table" ? "table" : "paragraph";
  const label = kind === "paragraph" ? (snip ? `“${snip}”` : `문단 (p.${page + 1})`) : `표 (p.${page + 1})`;
  return {
    mark: { page, box: { x: hit.x, y: hit.y, w: hit.w, h: hit.h }, label, kind },
    anchor: { kind, section: hit.section, block: hit.block, label, page, text: hit.text },
  };
}

/** Fold `incoming` into the current selection: `replace` (dedup incoming, drop the rest), `toggle` (a
 *  single ⌘/Ctrl-click: add if absent, remove if present), `union` (a ⌘/Ctrl-marquee: add all absent). */
function mergeSelection(prev: Sel[], incoming: Sel[], mode: "replace" | "toggle" | "union"): Sel[] {
  if (mode === "replace") {
    const seen = new Set<string>();
    const out: Sel[] = [];
    for (const s of incoming) {
      const k = selKey(s.anchor);
      if (!seen.has(k)) {
        seen.add(k);
        out.push(s);
      }
    }
    return out;
  }
  if (mode === "toggle") {
    const s = incoming[0];
    if (!s) return prev;
    const k = selKey(s.anchor);
    return prev.some((p) => selKey(p.anchor) === k) ? prev.filter((p) => selKey(p.anchor) !== k) : [...prev, s];
  }
  // union
  const keys = new Set(prev.map((p) => selKey(p.anchor)));
  const add: Sel[] = [];
  for (const s of incoming) {
    const k = selKey(s.anchor);
    if (!keys.has(k)) {
      keys.add(k);
      add.push(s);
    }
  }
  return [...prev, ...add];
}

/// HwpWorkspace — the one-line assembly (issue 016 step 2): page view + selection overlay + chat panel.
/// Open a document, SELECT blocks (OS-style: click = replace, ⌘/Ctrl-click = toggle, drag over empty
/// space = marquee/rubber-band select — issue 021), say what to change, review the previewed Intents,
/// apply, and download HTML/PDF. The AI is delegated to `onAiRequest` (R6); SVG is sanitized in
/// HwpPageView (R7); fonts are injected via `requestFont` (R8).
export function HwpWorkspace(props: HwpWorkspaceProps) {
  const { adapter } = props;
  const [meta, setMeta] = useState<OpenResult | null>(null);
  const [zoom, setZoom] = useState(0.9);
  const [refreshToken, setRefreshToken] = useState(0);
  const [selection, setSelection] = useState<Sel[]>([]);
  const [marquee, setMarquee] = useState<Marquee | null>(null);
  const [status, setStatus] = useState<string>("");
  const undoStack = useRef<number[]>([]); // batch sizes (ops per applied proposal)
  const redoStack = useRef<number[]>([]);
  // Selected font for the SCREEN (issue 022): family + a blob URL of the SAME bytes registered for
  // metrics + PDF, so the @font-face'd SVG matches the exported PDF exactly.
  const [selectedFont, setSelectedFont] = useState<{ family: string; url: string } | null>(null);
  const defaultFontAppliedFor = useRef<Uint8Array | null>(null);

  // The live selection is the single source of truth; the chat anchors + page marks are views of it.
  const anchors = useMemo(() => selection.map((s) => s.anchor), [selection]);
  const marks = useMemo(() => selection.map((s) => s.mark), [selection]);
  const mod = useMemo(() => modLabel(), []);

  // Active pointer-drag bookkeeping (ref: mutated every move without re-rendering; only the marquee box
  // is state). `empty` resolves async (was the press on empty space?); `resolved` caches the click hit.
  const dragRef = useRef<
    | {
        page: number;
        startX: number;
        startY: number;
        curX: number;
        curY: number;
        clientX: number;
        clientY: number;
        meta: boolean;
        empty: boolean | null;
        marqueeing: boolean;
        resolved?: { table: TableBox | null; cell: CellHit | null; hit: BlockHit | null };
      }
    | null
  >(null);

  // Resolve a page-local click to (table, cell, block-band). Priority for anchoring is cell > table >
  // block (issue 023); we query the cell only when a table was hit AND the backend supports the optional
  // `tableCellAt` (the reference TauriAdapter omits it → whole-table marking, 021 parity).
  const resolveHit = useCallback(
    async (page: number, x: number, y: number): Promise<{ table: TableBox | null; cell: CellHit | null; hit: BlockHit | null }> => {
      const table = await adapter.tableAt(page, x, y);
      const cell = table && adapter.tableCellAt ? await adapter.tableCellAt(page, x, y) : null;
      const hit = table ? null : await adapter.hitTest(page, x, y);
      return { table, cell, hit };
    },
    [adapter],
  );

  const toast = useCallback((s: string) => {
    setStatus(s);
    window.setTimeout(() => setStatus((cur) => (cur === s ? "" : cur)), 4000);
  }, []);

  const clearSelection = useCallback(() => {
    setSelection([]);
    setMarquee(null);
    dragRef.current = null;
  }, []);

  // Esc anywhere clears the whole selection + any in-progress marquee (issue 021).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") clearSelection();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [clearSelection]);

  // Open the document whenever the bytes reference changes.
  useEffect(() => {
    let cancelled = false;
    if (!props.document) {
      setMeta(null);
      return;
    }
    (async () => {
      try {
        const r = await adapter.open(props.document!.bytes, props.document!.name);
        if (cancelled) return;
        setMeta(r);
        clearSelection();
        undoStack.current = [];
        redoStack.current = [];
        setRefreshToken((t) => t + 1);
        toast(`열림: ${props.document!.name ?? "문서"} · ${r.pages}쪽`);
      } catch (e) {
        if (!cancelled) toast(`열기 실패: ${e}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [adapter, props.document, toast, clearSelection]);

  // Apply a font to EVERYTHING (issue 022): register it into the engine (metrics + PDF), rebuild the
  // screen @font-face (blob URL of the SAME bytes → screen == PDF), and re-render + re-query the page
  // count (real metrics re-paginate). Shared by the auto-registered defaultFont and the FontPicker.
  const applyFont = useCallback(
    async (family: string, bytes: Uint8Array) => {
      try {
        await adapter.registerFont(family, bytes);
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
      // Registering a font re-layouts (issue 022 contract): re-query the page count + re-render all pages.
      try {
        const pages = await adapter.pageCount();
        setMeta((m) => (m ? { ...m, pages } : m));
      } catch {
        /* keep the previous count on a transient error */
      }
      setRefreshToken((t) => t + 1);
      toast(`글꼴 적용: ${family}`);
    },
    [adapter, toast],
  );

  // Auto-register the default font once per opened document (issue 022 §5): the PDF button is usable
  // immediately and the screen matches. Guarded by a ref keyed on the document bytes so it runs once
  // per open (a re-render that only bumps the page count won't re-apply).
  useEffect(() => {
    if (!meta || !props.defaultFont || !props.document) return;
    if (defaultFontAppliedFor.current === props.document.bytes) return;
    defaultFontAppliedFor.current = props.document.bytes;
    void applyFont(props.defaultFont.family, props.defaultFont.bytes);
  }, [meta, props.defaultFont, props.document, applyFont]);

  // Revoke the blob URL when the component unmounts (avoid leaking the object URL).
  useEffect(() => () => {
    setSelectedFont((prev) => {
      if (prev) URL.revokeObjectURL(prev.url);
      return null;
    });
  }, []);

  const canEdit = !!meta?.editable;

  const docContext: DocContext = {
    format: meta?.format ?? "",
    editable: meta?.editable ?? false,
    sections: meta?.sections ?? 0,
    pages: meta?.pages ?? 0,
    anchors,
  };

  const onTrap = useCallback(
    (e: unknown, msg: string) => {
      if (String(e).includes("wasm_trap")) {
        toast(msg);
        setRefreshToken((t) => t + 1);
        return true;
      }
      return false;
    },
    [toast],
  );

  // pointerdown: record the drag origin + resolve (async) whether it landed on EMPTY space so a drag from
  // empty starts a marquee while a drag from a block does not (issue §함정).
  const onPointerDown = useCallback(
    (click: PageClick) => {
      dragRef.current = {
        page: click.page,
        startX: click.x,
        startY: click.y,
        curX: click.x,
        curY: click.y,
        clientX: click.client.x,
        clientY: click.client.y,
        meta: click.meta,
        empty: null,
        marqueeing: false,
      };
      setMarquee(null);
      (async () => {
        try {
          const { table, cell, hit } = await resolveHit(click.page, click.x, click.y);
          // "empty" = not over a table AND not STRICTLY inside a block band (hitTest returns the nearest
          // band even in a gap, so we re-check strict containment here rather than trust a non-null hit).
          const strictInside = !!hit && click.x >= hit.x && click.x <= hit.x + hit.w && click.y >= hit.y && click.y <= hit.y + hit.h;
          const d = dragRef.current;
          if (d && d.page === click.page && d.startX === click.x && d.startY === click.y) {
            d.empty = !table && !strictInside;
            d.resolved = { table, cell, hit };
          }
        } catch (e) {
          onTrap(e, "엔진을 복구했습니다 — 다시 시도하세요");
        }
      })();
    },
    [resolveHit, onTrap],
  );

  // pointermove: past the 4px threshold, an EMPTY-origin drag becomes a marquee (dashed rect), clipped to
  // the START page (v1: single-page marquee).
  const onPointerMove = useCallback(
    (click: PageClick) => {
      const d = dragRef.current;
      if (!d || click.page !== d.page) return; // ignore moves that stray onto another page (clip to start)
      d.curX = click.x;
      d.curY = click.y;
      if (!d.marqueeing) {
        const moved = Math.hypot(click.client.x - d.clientX, click.client.y - d.clientY) > DRAG_THRESHOLD_PX;
        if (!moved) return;
        if (d.empty !== true) return; // only empty-space drags marquee (null = still resolving → wait)
        if (!adapter.blocksInRect) return; // backend can't answer a rect query → no marquee
        d.marqueeing = true;
      }
      const x = Math.min(d.startX, d.curX);
      const y = Math.min(d.startY, d.curY);
      setMarquee({ page: d.page, box: { x, y, w: Math.abs(d.curX - d.startX), h: Math.abs(d.curY - d.startY) } });
    },
    [adapter],
  );

  // Finish a marquee: query blocksInRect on the start page, convert to Sels (excluding images), then
  // replace or (with ⌘/Ctrl) union into the selection.
  const finishMarquee = useCallback(
    async (d: NonNullable<typeof dragRef.current>) => {
      if (!adapter.blocksInRect) return;
      const x0 = Math.min(d.startX, d.curX);
      const y0 = Math.min(d.startY, d.curY);
      const x1 = Math.max(d.startX, d.curX);
      const y1 = Math.max(d.startY, d.curY);
      try {
        const hits = await adapter.blocksInRect(d.page, x0, y0, x1, y1);
        const sels: Sel[] = [];
        let excluded = 0;
        for (const h of hits) {
          const s = blockHitToSel(h, d.page);
          if (s) sels.push(s);
          else excluded++;
        }
        if (sels.length === 0 && !d.meta) setSelection([]);
        else setSelection((prev) => mergeSelection(prev, sels, d.meta ? "union" : "replace"));
        if (excluded > 0) toast(`${sels.length}개 선택 · 그림 등 ${excluded}개 제외`);
        else if (sels.length > 0) toast(`${sels.length}개 블록 선택`);
      } catch (e) {
        onTrap(e, "엔진 트랩 — 문서를 복구했습니다");
      }
    },
    [adapter, toast, onTrap],
  );

  // Finish a click (no drag): select the resolved block — replace, or ⌘/Ctrl toggle.
  const finishClick = useCallback(
    async (d: NonNullable<typeof dragRef.current>) => {
      try {
        // The async resolve didn't land before pointerup (a very fast click) → resolve now.
        const r = d.resolved ?? (await resolveHit(d.page, d.startX, d.startY));
        const sel = deriveSel(d.page, r.table, r.cell, r.hit);
        if (!sel) {
          if (!d.meta) setSelection([]); // a plain click on nothing clears
          return;
        }
        setSelection((prev) => mergeSelection(prev, [sel], d.meta ? "toggle" : "replace"));
      } catch (e) {
        onTrap(e, "엔진을 복구했습니다 — 다시 시도하세요");
      }
    },
    [resolveHit, onTrap],
  );

  const onPointerUp = useCallback(
    (_click: PageClick) => {
      const d = dragRef.current;
      dragRef.current = null;
      setMarquee(null);
      if (!d) return;
      if (d.marqueeing) void finishMarquee(d);
      else void finishClick(d);
    },
    [finishMarquee, finishClick],
  );

  const onApply = useCallback(
    async (intents: Intent[]): Promise<number> => {
      let applied = 0;
      try {
        for (const intent of intents) {
          await adapter.applyIntent(intent);
          applied++;
        }
        undoStack.current.push(applied);
        redoStack.current = [];
        const pages = await adapter.pageCount();
        setMeta((m) => (m ? { ...m, pages } : m));
        clearSelection();
        setRefreshToken((t) => t + 1);
        toast(`적용됨: ${applied}개 편집`);
      } catch (e) {
        if (String(e).includes("wasm_trap")) {
          toast("엔진 트랩 — 문서를 복구했습니다. 마지막 편집은 취소되었습니다");
          setRefreshToken((t) => t + 1);
        }
        throw e;
      }
      return applied;
    },
    [adapter, toast, clearSelection],
  );

  const undo = useCallback(async () => {
    const n = undoStack.current.pop();
    if (!n) return;
    for (let i = 0; i < n; i++) await adapter.undo().catch(() => false);
    redoStack.current.push(n);
    const pages = await adapter.pageCount();
    setMeta((m) => (m ? { ...m, pages } : m));
    setRefreshToken((t) => t + 1);
    toast("실행취소");
  }, [adapter, toast]);

  const redo = useCallback(async () => {
    const n = redoStack.current.pop();
    if (!n) return;
    for (let i = 0; i < n; i++) await adapter.redo().catch(() => false);
    undoStack.current.push(n);
    const pages = await adapter.pageCount();
    setMeta((m) => (m ? { ...m, pages } : m));
    setRefreshToken((t) => t + 1);
    toast("다시 실행");
  }, [adapter, toast]);

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
      download(await adapter.exportHtml(), `${props.document?.name ?? "document"}.html`, "text/html");
    } catch (e) {
      toast(`HTML 내보내기 실패: ${e}`);
    }
  }, [adapter, props.document, toast]);

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
      download(await adapter.exportPdf(), `${props.document?.name ?? "document"}.pdf`, "application/pdf");
    } catch (e) {
      const code = (e as { code?: string })?.code;
      if (code === "font_missing") toast("폰트가 주입되지 않았습니다 — .ttf/.otf 파일을 선택하세요");
      else toast(`PDF 내보내기 실패: ${e}`);
    }
  }, [adapter, props.requestFont, props.document, toast]);

  const jumpToPage = useCallback((page: number) => {
    const el = window.document.querySelector(`.hw-sheet[data-page="${page}"]`);
    el?.scrollIntoView?.({ behavior: "smooth", block: "start" });
  }, []);

  return (
    <div className={`hw-workspace ${props.className ?? ""}`}>
      {/* Screen font-face + alias (issue 022 §3): map every document font name to the selected face so
          the SVG on screen matches the exported PDF. Injected only when a font is selected. */}
      {selectedFont && <style data-testid="hw-fontface">{buildFontFaceCss(selectedFont.family, selectedFont.url)}</style>}
      <div className="hw-toolbar">
        <span className="hw-brand">tf-hwp</span>
        <span className="hw-doc-meta">{meta ? `${meta.format.toUpperCase()} · ${meta.pages}쪽` : "문서 없음"}</span>
        <span className="hw-spacer" />
        <button className="hw-tool" onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.1).toFixed(2)))} title="축소" disabled={!meta}>
          －
        </button>
        <span className="hw-zoom">{Math.round(zoom * 100)}%</span>
        <button className="hw-tool" onClick={() => setZoom((z) => Math.min(1.5, +(z + 0.1).toFixed(2)))} title="확대" disabled={!meta}>
          ＋
        </button>
        <button className="hw-tool" onClick={undo} disabled={!meta} title="실행취소">
          ↶
        </button>
        <button className="hw-tool" onClick={redo} disabled={!meta} title="다시 실행">
          ↷
        </button>
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

      <div className="hw-body">
        <div
          className="hw-canvas"
          onPointerDown={(e) => {
            // A press on the gray canvas background (outside every page sheet) clears the selection.
            if (!(e.target as HTMLElement).closest(".hw-sheet")) clearSelection();
          }}
        >
          {meta ? (
            <HwpPageView
              adapter={adapter}
              pageCount={meta.pages}
              zoom={zoom}
              refreshToken={refreshToken}
              onPagePointerDown={(c) => onPointerDown(c)}
              onPagePointerMove={(c) => onPointerMove(c)}
              onPagePointerUp={(c) => onPointerUp(c)}
              renderOverlay={(page, scale) => <SelectionOverlay marks={marks} marquee={marquee} page={page} scale={scale} />}
            />
          ) : (
            <div className="hw-empty-canvas">문서를 열면 여기에 페이지가 표시됩니다.</div>
          )}
        </div>
        <ChatPanel
          canEdit={canEdit}
          anchors={anchors}
          modLabel={mod}
          onRemoveAnchor={(i) => setSelection((s) => s.filter((_, k) => k !== i))}
          onClearAnchors={clearSelection}
          onConsumeAnchors={clearSelection}
          onAiRequest={props.onAiRequest}
          docContext={docContext}
          onApply={onApply}
          onJumpToPage={jumpToPage}
          isMock={props.isMock}
        />
      </div>

      {status && <div className="hw-status">{status}</div>}
    </div>
  );
}
