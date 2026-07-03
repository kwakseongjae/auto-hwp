import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EngineAdapter, Intent, DocContext, PointerInput, PageGeom, Box, Selection } from "@tf-hwp/editor-core";
import { boundariesToRatios, firstRunStyle } from "@tf-hwp/editor-core";
import { modLabel } from "../platform";
import { useHwpEditor } from "../useHwpEditor";
import { ChatPanel } from "./ChatPanel";
import { HwpPageView, type PageClick } from "./HwpPageView";
import { SelectionOverlay, type Marquee, type Mark } from "./SelectionOverlay";
import { FontPicker } from "./FontPicker";
import { ColumnResizeOverlay } from "./ColumnResizeOverlay";
import { TableInsertButton } from "./TableInsertButton";
import { Ruler } from "./Ruler";
import { CellTextPopover } from "./CellTextPopover";
import { FloatingToolbar, type ToolbarAlign } from "./FloatingToolbar";
import { buildFontFaceCss, type FontCatalogEntry } from "../fonts";

const A4_W = 794; // CSS px for 210mm @ 96dpi (mirrors HwpPageView) — the 100% page width.

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
  tableBox?: Box | null;
  boundaries?: number[] | null;
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
  const { adapter } = props;
  const { core, meta, selection, marquee, refreshToken, bumpRefresh } = useHwpEditor(adapter);
  const [zoom, setZoom] = useState(0.9);
  const [status, setStatus] = useState<string>("");
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
  const [popover, setPopover] = useState<
    { page: number; box: Box; section: number; block: number; kind: string; rows?: [number, number]; cols?: [number, number]; text: string } | null
  >(null);

  // The live selection is the single source of truth (in the core); the chat anchors + page marks are
  // views of it, mapped here for the components.
  const anchors = useMemo(() => selection.map((s) => s.anchor), [selection]);
  const marks = useMemo<Mark[]>(() => selection.map((s) => s.mark), [selection]);
  const mod = useMemo(() => modLabel(), []);

  const toast = useCallback((s: string) => {
    setStatus(s);
    window.setTimeout(() => setStatus((cur) => (cur === s ? "" : cur)), 4000);
  }, []);

  const clearSelection = useCallback(() => core.selection.clear(), [core]);

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
          const [tableBox, boundaries, runs] = await Promise.all([
            adapter.tableAt(mark.page, cx, cy),
            core.session.colBoundaries(mark.page, anchor.section, anchor.block),
            core.session.runsAt(anchor.section, anchor.block, anchor.rows?.[0], anchor.cols?.[0]),
          ]);
          if (cancelled) return;
          const style = firstRunStyle(runs);
          setEditTarget({ ...base, tableBox: tableBox as Box | null, boundaries, curBold: !!style.bold, curItalic: !!style.italic });
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
  }, [editingOn, selection, adapter, core]);

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

  // Close the popover when the layout re-flows (an applied edit) so it never floats over stale geometry.
  useEffect(() => {
    setPopover(null);
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

  const onColCommit = useCallback(
    async (newBoundaries: number[]) => {
      if (!editTarget) return;
      try {
        await core.edit.setColumnWidths(editTarget.section, editTarget.block, boundariesToRatios(newBoundaries));
        toast("열 너비를 변경했습니다");
      } catch (e) {
        if (!onTrap(e, "엔진 트랩 — 문서를 복구했습니다")) toast(`열 너비 변경 실패: ${e}`);
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

  // Open the inline text popover for the point `c` by resolving the hit DIRECTLY (cell → paragraph). Used
  // by the double-click detector below. Race-free: it re-hit-tests the (x,y) rather than reading the
  // async selection.
  const openPopoverAt = useCallback(
    async (c: PageClick) => {
      try {
        const cell = adapter.tableCellAt ? await adapter.tableCellAt(c.page, c.x, c.y) : null;
        if (cell) {
          setPopover({ page: c.page, box: { x: cell.x, y: cell.y, w: cell.w, h: cell.h }, section: cell.section, block: cell.block, kind: "cell", rows: [cell.row, cell.row], cols: [cell.col, cell.col], text: cell.text });
          return;
        }
        if (await adapter.tableAt(c.page, c.x, c.y)) return; // on a table border but not a cell → no popover
        const hit = await adapter.hitTest(c.page, c.x, c.y);
        if (hit && hit.kind === "paragraph" && hit.editable) {
          setPopover({ page: c.page, box: { x: hit.x, y: hit.y, w: hit.w, h: hit.h }, section: hit.section, block: hit.block, kind: "paragraph", text: hit.text });
        }
      } catch (e) {
        onTrap(e, "엔진을 복구했습니다 — 다시 시도하세요");
      }
    },
    [adapter, onTrap],
  );

  const onPopoverCommit = useCallback(
    async (text: string) => {
      if (!popover) return;
      try {
        if (popover.kind === "paragraph") {
          await core.edit.editParagraphText(popover.section, popover.block, text);
        } else {
          await core.edit.editCellText(popover.section, popover.block, popover.rows?.[0] ?? 0, popover.cols?.[0] ?? 0, text);
        }
        toast("텍스트를 수정했습니다");
      } catch (e) {
        if (!onTrap(e, "엔진 트랩 — 문서를 복구했습니다")) toast(`텍스트 수정 실패: ${e}`);
      } finally {
        setPopover(null);
      }
    },
    [core, popover, toast, onTrap],
  );

  // Format toolbar → SetCellRangeFmt / SetCellRangeShade over the selected cell/range.
  const fmtRange = editTarget?.rows && editTarget?.cols ? { r0: editTarget.rows[0], c0: editTarget.cols[0], r1: editTarget.rows[1], c1: editTarget.cols[1] } : null;
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

  // "AI에게 전달" (issue 028): the marked selection is ALREADY the anchor chip (anchors = selection); this
  // only bumps the token that focuses the chat composer. No new prompt logic, and the selection is NOT
  // cleared so the chips ride along with the next message (the existing captureAnchor flow).
  const onSendToAi = useCallback(() => setAiFocusToken((t) => t + 1), []);

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
      // Detect a double-click (two ups within 400ms, ~same client point) → open the text popover.
      const now = Date.now();
      const prev = lastUpRef.current;
      if (prev && now - prev.t < 400 && Math.hypot(c.client.x - prev.x, c.client.y - prev.y) < 6) {
        lastUpRef.current = null;
        void openPopoverAt(c);
      } else {
        lastUpRef.current = { t: now, x: c.client.x, y: c.client.y };
      }
    },
    [core, editingOn, openPopoverAt],
  );

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

      <div className="hw-body">
        <div
          className="hw-canvas"
          onPointerDown={(e) => {
            // A press on the gray canvas background (outside every page sheet) clears the selection.
            if (!(e.target as HTMLElement).closest(".hw-sheet")) clearSelection();
          }}
        >
          {meta ? (
            <>
              {/* 상단 룰러 (issue 027 step 3): 페이지 폭·좌우 여백 표시 + (편집 모드) 여백 드래그. */}
              {editingOn && pageGeom0 && (
                <div className="hw-ruler-wrap" style={{ width: A4_W * zoom }}>
                  <Ruler geom={pageGeom0} scale={(A4_W * zoom) / pageGeom0.w} onCommitMargins={canEdit ? onMarginsCommit : undefined} />
                </div>
              )}
              <HwpPageView
                adapter={adapter}
                pageCount={meta.pages}
                zoom={zoom}
                refreshToken={refreshToken}
                onPagePointerDown={(c) => onPointerDown(c)}
                onPagePointerMove={(c) => onPointerMove(c)}
                onPagePointerUp={(c) => onPointerUp(c)}
                renderOverlay={(page, scale) => (
                  <>
                    <SelectionOverlay marks={marks} marquee={marquee as Marquee | null} page={page} scale={scale} />
                    {editingOn && editTarget && editTarget.page === page && editTarget.boundaries && editTarget.tableBox && (
                      <ColumnResizeOverlay
                        boundaries={editTarget.boundaries}
                        top={editTarget.tableBox.y}
                        height={editTarget.tableBox.h}
                        scale={scale}
                        onCommit={(b) => void onColCommit(b)}
                      />
                    )}
                    {editingOn && toolbarPage === page && marks.length > 0 && !(pointerActive || marquee) && (
                      <FloatingToolbar
                        marks={marks.filter((m) => m.page === page).map((m) => m.box)}
                        scale={scale}
                        viewportWidth={A4_W * zoom}
                        kind={editTarget?.kind ?? "multi"}
                        formatDisabledReason={formatDisabledReason}
                        fonts={fontFamilies}
                        aiEnabled={canEdit}
                        onBold={() => editTarget && fmtRange && void runFmt(() => core.edit.formatCellRange(editTarget.section, editTarget.block, fmtRange, { bold: !editTarget.curBold }), editTarget.curBold ? "굵게 해제" : "굵게 적용")}
                        onItalic={() => editTarget && fmtRange && void runFmt(() => core.edit.formatCellRange(editTarget.section, editTarget.block, fmtRange, { italic: !editTarget.curItalic }), "기울임 적용")}
                        onSize={(pt) => editTarget && fmtRange && void runFmt(() => core.edit.formatCellRange(editTarget.section, editTarget.block, fmtRange, { size_pt: pt }), `글자 크기 ${pt}pt`)}
                        onFont={(f) => editTarget && fmtRange && void runFmt(() => core.edit.formatCellRange(editTarget.section, editTarget.block, fmtRange, { font: f }), `서체 ${f}`)}
                        onColor={(hex) => editTarget && fmtRange && void runFmt(() => core.edit.formatCellRange(editTarget.section, editTarget.block, fmtRange, { color: hex }), "글자색 적용")}
                        onShade={(hex) => editTarget && fmtRange && void runFmt(() => core.edit.shadeCellRange(editTarget.section, editTarget.block, fmtRange, hex), hex ? "배경색 적용" : "배경 지움")}
                        onAlign={(a: ToolbarAlign) => editTarget && fmtRange && void runFmt(() => core.edit.formatCellRange(editTarget.section, editTarget.block, fmtRange, { align: a }), "정렬 적용")}
                        onSendToAi={onSendToAi}
                      />
                    )}
                    {editingOn && popover && popover.page === page && (
                      <CellTextPopover box={popover.box} scale={scale} initialText={popover.text} onCommit={(t) => void onPopoverCommit(t)} onCancel={() => setPopover(null)} />
                    )}
                  </>
                )}
              />
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

      {status && <div className="hw-status">{status}</div>}
    </div>
  );
}
