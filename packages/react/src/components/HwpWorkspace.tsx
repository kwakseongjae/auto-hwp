import { useCallback, useEffect, useRef, useState } from "react";
import type { EngineAdapter } from "../EngineAdapter";
import type { Anchor, DocContext, Intent, OnAiRequest, OpenResult } from "../types";
import { ChatPanel } from "./ChatPanel";
import { HwpPageView, type PageClick } from "./HwpPageView";
import { SelectionOverlay, type Mark } from "./SelectionOverlay";

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
  className?: string;
}

/** Derive a structural Anchor from a page click's hit. Coordinates are STRUCTURE indices, never px. */
function deriveMarkAndAnchor(
  click: PageClick,
  table: { section: number; block: number; x: number; y: number; w: number; h: number; rows: number; cols: number } | null,
  hit: { section: number; block: number; kind: string; x: number; y: number; w: number; h: number; text: string } | null,
): { mark: Mark; anchor: Anchor } | null {
  if (table) {
    return {
      mark: { page: click.page, box: { x: table.x, y: table.y, w: table.w, h: table.h }, label: `표 (p.${click.page + 1})`, kind: "table" },
      anchor: { kind: "table", section: table.section, block: table.block, label: `표 (p.${click.page + 1})`, page: click.page },
    };
  }
  if (hit) {
    const snip = hit.text.trim().replace(/\s+/g, " ").slice(0, 14);
    const kind = hit.kind === "table" ? "table" : hit.kind === "image" ? "image" : "paragraph";
    const label = kind === "paragraph" ? (snip ? `“${snip}”` : `문단 (p.${click.page + 1})`) : `${kind} (p.${click.page + 1})`;
    return {
      mark: { page: click.page, box: { x: hit.x, y: hit.y, w: hit.w, h: hit.h }, label, kind },
      anchor: { kind: kind === "image" ? "paragraph" : (kind as Anchor["kind"]), section: hit.section, block: hit.block, label, page: click.page, text: hit.text },
    };
  }
  return null;
}

const sameAnchor = (a: Anchor, b: Anchor) => a.kind === b.kind && a.section === b.section && a.block === b.block;

/// HwpWorkspace — the one-line assembly (issue 016 step 2): page view + selection overlay + chat panel.
/// Open a document, mark a cell/table (click), say what to change, review the previewed Intents, apply,
/// and download HTML/PDF. The AI is delegated to `onAiRequest` (R6); SVG is sanitized in HwpPageView
/// (R7); fonts are injected via `requestFont` (R8). Tauri-only concerns (native file drop, window
/// management) are deliberately OUT — the host drives `document`.
export function HwpWorkspace(props: HwpWorkspaceProps) {
  const { adapter } = props;
  const [meta, setMeta] = useState<OpenResult | null>(null);
  const [zoom, setZoom] = useState(0.9);
  const [refreshToken, setRefreshToken] = useState(0);
  const [anchors, setAnchors] = useState<Anchor[]>([]);
  const [marks, setMarks] = useState<Mark[]>([]);
  const [status, setStatus] = useState<string>("");
  const undoStack = useRef<number[]>([]); // batch sizes (ops per applied proposal)
  const redoStack = useRef<number[]>([]);

  const toast = useCallback((s: string) => {
    setStatus(s);
    window.setTimeout(() => setStatus((cur) => (cur === s ? "" : cur)), 4000);
  }, []);

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
        setAnchors([]);
        setMarks([]);
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
  }, [adapter, props.document, toast]);

  const canEdit = !!meta?.editable;

  const docContext: DocContext = {
    format: meta?.format ?? "",
    editable: meta?.editable ?? false,
    sections: meta?.sections ?? 0,
    pages: meta?.pages ?? 0,
    anchors,
  };

  // A page click → hit-test (table preferred) → set the mark + add an anchor chip.
  const onPageClick = useCallback(
    async (click: PageClick) => {
      try {
        const table = await adapter.tableAt(click.page, click.x, click.y);
        const hit = table ? null : await adapter.hitTest(click.page, click.x, click.y);
        const derived = deriveMarkAndAnchor(click, table, hit);
        if (!derived) {
          setMarks([]);
          return;
        }
        setMarks([derived.mark]);
        setAnchors((prev) => (prev.some((p) => sameAnchor(p, derived.anchor)) ? prev : [...prev, derived.anchor]));
      } catch (e) {
        if (String(e).includes("wasm_trap")) {
          toast("엔진을 복구했습니다 — 다시 시도하세요");
          setRefreshToken((t) => t + 1);
        }
      }
    },
    [adapter, toast],
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
        setMarks([]);
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
    [adapter, toast],
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
        <button className="hw-tool" onClick={exportHtml} disabled={!meta} title="HTML 다운로드">
          HTML
        </button>
        <button className="hw-tool hw-tool-accent" onClick={exportPdf} disabled={!meta} title="PDF 다운로드">
          PDF
        </button>
      </div>

      <div className="hw-body">
        <div className="hw-canvas">
          {meta ? (
            <HwpPageView
              adapter={adapter}
              pageCount={meta.pages}
              zoom={zoom}
              refreshToken={refreshToken}
              onPageClick={(c) => void onPageClick(c)}
              renderOverlay={(page, scale) => <SelectionOverlay marks={marks} page={page} scale={scale} />}
            />
          ) : (
            <div className="hw-empty-canvas">문서를 열면 여기에 페이지가 표시됩니다.</div>
          )}
        </div>
        <ChatPanel
          canEdit={canEdit}
          anchors={anchors}
          onRemoveAnchor={(i) => setAnchors((a) => a.filter((_, k) => k !== i))}
          onConsumeAnchors={() => setAnchors([])}
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
