import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EngineAdapter, Intent, DocContext, PointerInput } from "@tf-hwp/editor-core";
import { modLabel } from "../platform";
import { useHwpEditor } from "../useHwpEditor";
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

  // pointer lifecycle → the core selection model (issues 021/023). React fires them fire-and-forget; the
  // core emits selection/marquee changes that useHwpEditor mirrors back into state.
  const onPointerDown = useCallback((c: PageClick) => void core.selection.pointerDown(toPointerInput(c)), [core]);
  const onPointerMove = useCallback((c: PageClick) => core.selection.pointerMove(toPointerInput(c)), [core]);
  const onPointerUp = useCallback((c: PageClick) => void core.selection.pointerUp(toPointerInput(c)), [core]);

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
              renderOverlay={(page, scale) => <SelectionOverlay marks={marks} marquee={marquee as Marquee | null} page={page} scale={scale} />}
            />
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
        />
      </div>

      {status && <div className="hw-status">{status}</div>}
    </div>
  );
}
