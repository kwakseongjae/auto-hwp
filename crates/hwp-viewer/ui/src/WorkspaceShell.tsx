import { StrictMode, useCallback, useEffect, useRef, useState } from "react";
import type { Root } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { HwpWorkspace, TauriAdapter, type DesktopSessionStatus, type OnAiRequest } from "@auto-hwp/react";
import "@auto-hwp/react/styles.css";

/// WorkspaceShell — the issue-044 desktop shell. Behind the build-time flag `VITE_SHELL=workspace`, the
/// Tauri app mounts THIS (the shared `@auto-hwp/react` `HwpWorkspace` over a `TauriAdapter`) instead of the
/// legacy `App.tsx`. The legacy path is byte-for-byte unchanged when the flag is off (see `main.tsx`).
///
/// The workspace's engine surface (open / render / hit-test / edit / export bytes) is 100% satisfied by
/// `TauriAdapter` (issue 043 — 22/22). This file is pure host chrome: the OS-facing seams that a shared,
/// browser-first component cannot own. Per docs/TAURI-CONVERGENCE.md §4 the 4 in-scope seams are:
///   1. 타이틀바   — the h-9 (36px) CSS titlebar + `data-tauri-drag-region`, the SAME discipline the legacy
///                  app uses so the macOS traffic lights stay centered (ccb9d5a; NEVER re-pin the lights).
///   2. 파일 열기  — a native file dialog → path, bridged into `adapter.open(bytes)` through an opaque
///                  host payload (recovery uses a separate opaque identifier; neither path is exported).
///   3. 저장/내보내기 — native save dialogs + ATOMIC writes (P0-1), reusing the existing path-based export
///                  commands; the web `<a download>` convention is intercepted via the opt-in `onExport`.
///   4. 드래그드롭 열기 — Tauri `onDragDropEvent` → open a dropped .hwp/.hwpx (same UX as the legacy app).
/// registerFont is a documented no-op on desktop (native font stack), so NO `fontCatalog` is injected.

// One adapter for the shell's lifetime (it holds the Tauri `invoke` seam; the open document lives in the
// Rust session). The shell bridges the web `open(bytes)` seam to the desktop's path-based `open_doc` by
// encoding the picked native path into the host-only payload. Recovery uses an opaque document id and
// generation instead — no temp file and no source path is persisted in recovery metadata.
const PATH_CODEC = { encode: (p: string) => new TextEncoder().encode(p), decode: (b: Uint8Array) => new TextDecoder().decode(b) };
const RECOVERY_PREFIX = "auto-hwp-recovery:";
type RecoverySummary = { documentId: string; generation: number; revision: number; savedAtMs: number; byteLen: number };
type RecoveryListing = { records: RecoverySummary[]; warnings: string[] };
type RecentDocument = { path: string; lastOpenedMs: number };
type RecentDocumentListing = { entries: RecentDocument[]; warnings: string[] };
type NativePrintResult = {
  status: "printed" | "cancelledOrFailed";
  preflight: {
    pages: number;
    textOps: number;
    tableGeometryOps: number;
    imageOps: number;
    equationOps: number;
    chartOps: number;
  };
};
type SaveContinuation = "none" | "replace" | "close";
const recoveryPayload = (record: RecoverySummary) =>
  new TextEncoder().encode(`${RECOVERY_PREFIX}${record.documentId}:${record.generation}`);
const adapter = new TauriAdapter({
  invoke,
  openDocument: async (bytes) => {
    const request = PATH_CODEC.decode(bytes);
    if (request.startsWith(RECOVERY_PREFIX)) {
      const [documentId, rawGeneration] = request.slice(RECOVERY_PREFIX.length).split(":");
      if (!/^[0-9a-f]{32}$/.test(documentId) || !/^\d+$/.test(rawGeneration)) {
        throw new Error("잘못된 복구 요청입니다");
      }
      const result = await invoke<{ pages: number; editable: boolean; format: string }>("open_recovery", {
        documentId,
        generation: Number(rawGeneration),
      });
      return { ...result, sections: 1 };
    }
    const result = await invoke<{ pages: number; editable: boolean; format: string }>("open_doc", { path: request });
    return { ...result, sections: 1 };
  },
});

const IS_DOC = /\.(hwp|hwpx)$/i;
const MAX_PENDING_OPEN_REQUESTS = 8;
const basename = (p: string) => p.split(/[\\/]/).pop() ?? p;

/// Chat / vibe-edit — DISABLED in the v1 desktop shell (documented in docs/TAURI-CONVERGENCE.md §4). The
/// workspace's `onAiRequest` contract is `(instruction, anchors, ctx) => Intent[]` that it PREVIEWS and
/// applies through `adapter.applyIntent`. The desktop AI path is a stateful dry-run/commit gate
/// (`ai_edit_propose` stages a summarized proposal on the session; `commit_proposal` applies it) — it
/// never surfaces schema-v0 `Intent[]`, and its commit is NOT `applyIntent`. Bridging would need a new,
/// engine-adjacent Rust command (out of 044 scope — 억지 개조 금지), so v1 rejects with an honest reason
/// instead of faking a proposal. Manual editing (enableEditing) is fully wired and unaffected.
const disabledAi: OnAiRequest = async () => {
  throw new Error(
    "데스크톱 신 셸 v1: 채팅(바이브) 편집은 아직 연결되지 않았습니다. " +
      "기존 앱의 ai_edit_propose/commit_proposal 게이트와 HwpWorkspace의 Intent[] 계약이 구조적으로 달라 v1에서 비활성입니다. " +
      "표/셀을 직접 더블클릭해 편집하거나, 채팅 편집은 기존 셸을 사용하세요.",
  );
};

function WorkspaceShell() {
  const [doc, setDoc] = useState<{ bytes: Uint8Array; name?: string } | null>(null);
  const [docName, setDocName] = useState<string | null>(null);
  const [note, setNote] = useState<string>("");
  const [pendingOpenPaths, setPendingOpenPaths] = useState<string[]>([]);
  const [sessionStatus, setSessionStatus] = useState<DesktopSessionStatus | null>(null);
  const [recoveries, setRecoveries] = useState<RecoverySummary[]>([]);
  const [recoveryScanComplete, setRecoveryScanComplete] = useState(false);
  const [recentDocuments, setRecentDocuments] = useState<RecentDocument[]>([]);
  const [recentScanComplete, setRecentScanComplete] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [restoredFromId, setRestoredFromId] = useState<string | null>(null);
  const [closeRequested, setCloseRequested] = useState(false);
  const [pendingOverwrite, setPendingOverwrite] = useState<{ path: string; after: SaveContinuation } | null>(null);
  const snapshotTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recoveryDisabled = useRef(false);
  const hasDoc = doc != null;

  const flash = useCallback((s: string) => {
    setNote(s);
    window.setTimeout(() => setNote((cur) => (cur === s ? "" : cur)), 4000);
  }, []);

  // The adapter compares the authoritative Rust revision after every accepted Intent. Read-only
  // queries do not trigger this observer. A completed edit schedules one path-free HWPX snapshot
  // after two idle seconds; persistence failure is visible and disables retries for this process.
  useEffect(() => {
    adapter.onSessionStatus = setSessionStatus;
    adapter.onMutation = () => {
      if (snapshotTimer.current) window.clearTimeout(snapshotTimer.current);
      if (recoveryDisabled.current) return;
      snapshotTimer.current = window.setTimeout(() => {
        snapshotTimer.current = null;
        void invoke<RecoverySummary | null>("write_recovery_snapshot")
          .then((record) => {
            if (record) flash(`복구 저장됨 · 편집 ${record.revision}회`);
          })
          .catch((error) => {
            recoveryDisabled.current = true;
            flash(`복구 저장을 중단했습니다: ${error}`);
          });
      }, 2000);
    };
    return () => {
      adapter.onMutation = null;
      adapter.onSessionStatus = null;
      if (snapshotTimer.current) window.clearTimeout(snapshotTimer.current);
    };
  }, [flash]);

  const refreshRecentDocuments = useCallback(async () => {
    const listing = await invoke<RecentDocumentListing>("list_recent_documents");
    setRecentDocuments(listing.entries.slice(0, 9));
    setRecentScanComplete(true);
    if (listing.warnings[0]) flash(listing.warnings[0]);
  }, [flash]);

  useEffect(() => {
    let cancelled = false;
    let unlistenWarning: undefined | (() => void);
    void refreshRecentDocuments().catch((error) => {
      if (!cancelled) {
        setRecentScanComplete(true);
        flash(`최근 문서 목록을 확인하지 못했습니다: ${error}`);
      }
    });
    void listen<string>("desktop-warning", (event) => flash(event.payload)).then((un) => {
      if (cancelled) un();
      else unlistenWarning = un;
    });
    return () => {
      cancelled = true;
      unlistenWarning?.();
    };
  }, [flash, refreshRecentDocuments]);

  useEffect(() => {
    let cancelled = false;
    let unlistenClose: undefined | (() => void);
    let unlistenChanged: undefined | (() => void);
    void invoke<RecoveryListing>("list_recovery_snapshots")
      .then((listing) => {
        if (!cancelled) {
          setRecoveries(listing.records);
          setRecoveryScanComplete(true);
          if (listing.warnings[0]) flash(listing.warnings[0]);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setRecoveryScanComplete(true);
          flash(`복구 목록을 확인하지 못했습니다: ${error}`);
        }
      });
    void listen("desktop-close-request", () => setCloseRequested(true)).then((un) => {
      if (cancelled) un();
      else unlistenClose = un;
    });
    void listen("doc-changed", () => void adapter.refreshSessionStatus()).then((un) => {
      if (cancelled) un();
      else unlistenChanged = un;
    });
    return () => {
      cancelled = true;
      unlistenClose?.();
      unlistenChanged?.();
    };
  }, [flash]);

  // Open a native path by handing the workspace a fresh `document` whose host-only bytes carry the path
  // (a new object each call → the workspace re-opens even when the same file is re-picked). The adapter
  // decodes it and Rust `open_doc` reads the real file in place.
  const openPath = useCallback((path: string) => {
    const name = basename(path);
    setDoc({ bytes: PATH_CODEC.encode(path), name });
    setDocName(name);
  }, []);

  // All desktop entry points converge here: native dialog, drag/drop, cold launch, and warm
  // file-association events. Keep a bounded, de-duplicated queue so a platform batch cannot race
  // React state or silently replace multiple documents.
  const requestOpen = useCallback((paths: string[]) => {
    const valid = paths.filter((path) => IS_DOC.test(path));
    if (valid.length === 0) return;
    setPendingOpenPaths((current) =>
      [...new Set([...current, ...valid])].slice(0, MAX_PENDING_OPEN_REQUESTS),
    );
  }, []);

  // Register before the first drain. Rust owns the durable in-memory queue, so an OS event that
  // arrives before this listener is ready is picked up by `take_open_requests` without exposing its
  // path in the event payload.
  useEffect(() => {
    let cancelled = false;
    let unlisten: undefined | (() => void);
    const drain = async () => {
      try {
        const paths = await invoke<string[]>("take_open_requests");
        if (!cancelled) requestOpen(paths);
      } catch (e) {
        if (!cancelled) flash(`연결된 파일 열기 실패: ${e}`);
      }
    };
    void (async () => {
      unlisten = await listen("desktop-open-request", () => void drain());
      if (!cancelled) await drain();
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [flash, requestOpen]);

  // Clean replacement is immediate. Dirty replacement waits for the explicit save/discard/cancel
  // surface below. Do not use window.confirm at this data-loss boundary.
  useEffect(() => {
    const path = pendingOpenPaths[0];
    if (
      !path ||
      !recoveryScanComplete ||
      (!hasDoc && recoveries.length > 0) ||
      (hasDoc && (sessionStatus == null || sessionStatus.dirty))
    ) return;
    openPath(path);
    setPendingOpenPaths((current) => current.slice(1));
  }, [hasDoc, openPath, pendingOpenPaths, recoveries.length, recoveryScanComplete, sessionStatus]);

  const doOpen = useCallback(async () => {
    try {
      const path = await openDialog({ filters: [{ name: "HWP/HWPX", extensions: ["hwpx", "hwp"] }] });
      if (typeof path !== "string") return;
      requestOpen([path]);
    } catch (e) {
      flash(`열기 실패: ${e}`);
    }
  }, [requestOpen, flash]);

  const reopenRecentDocument = useCallback(async (index: number) => {
    try {
      await invoke("reopen_recent_document", { index });
    } catch (error) {
      flash(String(error));
      await refreshRecentDocuments().catch(() => undefined);
    }
  }, [flash, refreshRecentDocuments]);

  const removeRecentDocument = useCallback(async (index: number) => {
    try {
      const listing = await invoke<RecentDocumentListing>("remove_recent_document", { index });
      setRecentDocuments(listing.entries.slice(0, 9));
    } catch (error) {
      flash(`최근 문서를 목록에서 지우지 못했습니다: ${error}`);
    }
  }, [flash]);

  const clearRecentDocuments = useCallback(async () => {
    try {
      await invoke("clear_recent_documents");
      setRecentDocuments([]);
    } catch (error) {
      flash(`최근 문서 목록을 비우지 못했습니다: ${error}`);
    }
  }, [flash]);

  // 저장 (HWPX) — the atomic P0-1 path (`hwp_core::atomic_write`: temp + fsync + rename) via the existing
  // path-based `export_hwpx` command. The byte twin (`toHwpx()`) exists on the adapter but the host chrome
  // reuses the tested atomic writer, so no bare-bytes write command is introduced (엔진 무접촉).
  const discardRecoveryIds = useCallback(async () => {
    if (snapshotTimer.current) {
      window.clearTimeout(snapshotTimer.current);
      snapshotTimer.current = null;
    }
    const ids = new Set([sessionStatus?.documentId, restoredFromId].filter((id): id is string => !!id));
    for (const documentId of ids) await invoke("discard_recovery_snapshots", { documentId });
    setRestoredFromId(null);
  }, [restoredFromId, sessionStatus?.documentId]);

  const finishContinuation = useCallback(
    async (after: SaveContinuation) => {
      if (after === "replace") {
        const path = pendingOpenPaths[0];
        if (path) openPath(path);
        setPendingOpenPaths((current) => current.slice(1));
      } else if (after === "close") {
        await invoke("allow_desktop_close");
        await getCurrentWebviewWindow().close();
      }
      setCloseRequested(false);
    },
    [openPath, pendingOpenPaths],
  );

  const saveToPath = useCallback(
    async (path: string, overwriteConfirmed: boolean, after: SaveContinuation): Promise<boolean> => {
      try {
        if (snapshotTimer.current) {
          window.clearTimeout(snapshotTimer.current);
          snapshotTimer.current = null;
        }
        const message = await invoke<string>("export_hwpx", { path, overwriteConfirmed });
        if (restoredFromId) await invoke("discard_recovery_snapshots", { documentId: restoredFromId });
        setRestoredFromId(null);
        setSessionStatus(await adapter.sessionStatus());
        flash(message);
        await finishContinuation(after);
        return true;
      } catch (error) {
        if (!overwriteConfirmed && String(error).includes("EXTERNAL_SOURCE_CHANGED")) {
          setPendingOverwrite({ path, after });
          return false;
        }
        flash(`저장 실패: ${error}`);
        return false;
      }
    },
    [finishContinuation, flash, restoredFromId],
  );

  const doSaveHwpx = useCallback(async (after: SaveContinuation = "none") => {
    if (!hasDoc) return false;
    try {
      const path = await saveDialog({ defaultPath: docName?.replace(/\.hwp$/i, ".hwpx") ?? "export.hwpx", filters: [{ name: "HWPX", extensions: ["hwpx"] }] });
      if (typeof path !== "string") return false;
      return await saveToPath(path, false, after);
    } catch (e) {
      flash(`저장 실패: ${e}`);
      return false;
    }
  }, [docName, hasDoc, flash, saveToPath]);

  const discardAndContinue = useCallback(
    async (after: Exclude<SaveContinuation, "none">) => {
      try {
        await discardRecoveryIds();
        await finishContinuation(after);
      } catch (error) {
        flash(`복구본 삭제 실패: ${error}`);
      }
    },
    [discardRecoveryIds, finishContinuation, flash],
  );

  const restoreRecovery = useCallback((record: RecoverySummary) => {
    setRestoredFromId(record.documentId);
    setDoc({ bytes: recoveryPayload(record), name: "복구본.hwpx" });
    setDocName("복구본.hwpx");
    setRecoveries([]);
  }, []);

  const discardRecovery = useCallback(async (record: RecoverySummary) => {
    try {
      await invoke("discard_recovery_snapshots", { documentId: record.documentId });
      setRecoveries((current) => current.filter((item) => item.documentId !== record.documentId));
    } catch (error) {
      flash(`복구본 삭제 실패: ${error}`);
    }
  }, [flash]);

  // 내보내기 (HTML/PDF) — the workspace's export buttons route HERE (opt-in `onExport`) instead of a
  // browser download. Native save dialog + the existing path-based atomic export commands, which
  // re-serialize the SAME live Rust session ⇒ byte-identical to the workspace's own `adapter.export*`.
  const onExport = useCallback(
    async (data: Uint8Array | string, filename: string, mime: string) => {
      void data; // reusing the atomic path commands (P0-1), not writing the passed bytes — same session.
      try {
        if (/hwpx|zip/i.test(mime)) {
          await doSaveHwpx();
        } else if (mime === "application/pdf") {
          const path = await saveDialog({ defaultPath: filename, filters: [{ name: "PDF", extensions: ["pdf"] }] });
          if (typeof path !== "string") return;
          flash(`PDF 내보냄 · ${await invoke<string>("export_doc_pdf", { path })}`);
        } else {
          const path = await saveDialog({ defaultPath: filename, filters: [{ name: "HTML", extensions: ["html", "htm"] }] });
          if (typeof path !== "string") return;
          flash(`HTML 내보냄 · ${await invoke<string>("export_doc_html", { path })}`);
        }
      } catch (e) {
        flash(`내보내기 실패: ${e}`);
      }
    },
    [doSaveHwpx, flash],
  );

  const doPrint = useCallback(async () => {
    if (!hasDoc || printing) return;
    setPrinting(true);
    try {
      const result = await invoke<NativePrintResult>("print_doc_pdf");
      if (result.status === "printed") {
        flash(`인쇄 작업 전달 · ${result.preflight.pages}쪽`);
      } else {
        flash("인쇄를 취소했거나 프린터가 작업을 완료하지 못했습니다");
      }
    } catch (error) {
      const code = String(error);
      if (code.includes("PRINT_CAPABILITY_DIAGNOSTIC") || code.includes("PRINT_REPLAY_DEGRADED")) {
        flash("PDF 기능 진단이 남아 있어 인쇄를 중단했습니다");
      } else if (code.includes("PRINT_NATIVE_UNAVAILABLE_ON_PLATFORM")) {
        flash("이 운영체제의 네이티브 인쇄 경로는 아직 준비되지 않았습니다");
      } else {
        flash(`인쇄 실패: ${error}`);
      }
    } finally {
      setPrinting(false);
    }
  }, [flash, hasDoc, printing]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "p") return;
      event.preventDefault();
      void doPrint();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [doPrint]);

  // 드래그드롭 열기 — the WebView never fires a browser `drop`, so subscribe to Tauri's native
  // `onDragDropEvent` (it carries OS file PATHS). A dropped .hwp/.hwpx opens; anything else is ignored.
  const requestOpenRef = useRef(requestOpen);
  requestOpenRef.current = requestOpen;
  useEffect(() => {
    let un: undefined | (() => void);
    (async () => {
      un = await getCurrentWebviewWindow().onDragDropEvent((event) => {
        const p = event.payload;
        if (p.type !== "drop") return;
        const hit = p.paths.find((f) => IS_DOC.test(f));
        if (hit) requestOpenRef.current([hit]);
        else if (p.paths.length > 0) flash(".hwp / .hwpx 파일만 열 수 있습니다");
      });
    })();
    return () => un?.();
  }, [flash]);

  return (
    <div className="flex h-full flex-col bg-white text-neutral-900 dark:bg-neutral-900 dark:text-neutral-100">
      {/* 타이틀바 — h-9 (36px) + data-tauri-drag-region: the ccb9d5a traffic-light discipline (pl-24 keeps
          the drag bar clear of the fixed macOS lights; height stays h-9 so the lights read centered). */}
      <header
        data-tauri-drag-region
        className="flex h-9 shrink-0 items-center gap-2 border-b border-black/10 bg-neutral-50/70 pl-24 pr-3 backdrop-blur-xl dark:border-white/10 dark:bg-neutral-800/60"
      >
        <button
          onClick={() => void doOpen()}
          className="rounded-md px-2 py-0.5 text-xs font-medium text-neutral-700 hover:bg-black/5 dark:text-neutral-200 dark:hover:bg-white/10"
        >
          열기
        </button>
        <button
          onClick={() => void doSaveHwpx()}
          disabled={!hasDoc}
          className="rounded-md px-2 py-0.5 text-xs font-medium text-neutral-700 hover:bg-black/5 disabled:opacity-40 dark:text-neutral-200 dark:hover:bg-white/10"
        >
          저장
        </button>
        <button
          onClick={() => void doPrint()}
          disabled={!hasDoc || printing}
          title="자체 PDF로 인쇄 (⌘P)"
          className="rounded-md px-2 py-0.5 text-xs font-medium text-neutral-700 hover:bg-black/5 disabled:opacity-40 dark:text-neutral-200 dark:hover:bg-white/10"
        >
          {printing ? "인쇄 준비…" : "인쇄"}
        </button>
        <span data-tauri-drag-region className="ml-1 text-sm font-medium">
          {docName ?? "한칸"}{sessionStatus?.dirty ? " •" : ""}
        </span>
        <span
          data-shell-mode="workspace"
          title="공유 HwpWorkspace 데스크톱 셀"
          className="rounded bg-violet-600 px-1.5 py-0.5 text-[10px] font-bold tracking-widest text-white"
        >
          WORKSPACE
        </span>
        {note && <span className="text-xs text-neutral-400">· {note}</span>}
        <div data-tauri-drag-region className="h-6 flex-1" />
      </header>

      {/* The shared workspace fills the rest. enableEditing turns on the manual editing chrome (더블클릭
          제자리 편집 · 서식 툴바 · 열/행 크기 조절 · 우클릭 메뉴). No fontCatalog: desktop renders with its
          native font stack (registerFont is a documented no-op). onExport intercepts HTML/PDF export. */}
      <div className="min-h-0 flex-1">
        {hasDoc ? (
          <HwpWorkspace adapter={adapter} document={doc} onAiRequest={disabledAi} enableEditing onExport={onExport} />
        ) : (
          <main className="mx-auto flex h-full w-full max-w-3xl flex-col px-8 py-12" aria-labelledby="desktop-home-title">
            <div className="flex items-end justify-between gap-6 border-b border-black/10 pb-6 dark:border-white/10">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-violet-600">auto-hwp desktop</p>
                <h1 id="desktop-home-title" className="mt-2 text-3xl font-semibold tracking-tight">문서를 안전하게 여세요</h1>
                <p className="mt-2 text-sm text-neutral-500 dark:text-neutral-400">
                  HWP는 원본을 보존해 열고, 편집본은 HWPX로 저장합니다.
                </p>
              </div>
              <button
                onClick={() => void doOpen()}
                className="shrink-0 rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-500"
              >파일 열기</button>
            </div>

            <section className="min-h-0 flex-1 pt-7" aria-labelledby="recent-documents-title">
              <div className="flex items-center justify-between">
                <h2 id="recent-documents-title" className="text-sm font-semibold">최근 문서</h2>
                {recentDocuments.length > 0 && (
                  <button onClick={() => void clearRecentDocuments()} className="text-xs text-neutral-500 hover:text-neutral-900 dark:hover:text-white">
                    모두 지우기
                  </button>
                )}
              </div>
              {!recentScanComplete ? (
                <p className="mt-5 text-sm text-neutral-500">최근 문서를 확인하고 있습니다…</p>
              ) : recentDocuments.length === 0 ? (
                <div className="mt-5 rounded-xl border border-dashed border-black/15 px-5 py-10 text-center dark:border-white/15">
                  <p className="text-sm font-medium">아직 최근 문서가 없습니다</p>
                  <p className="mt-1 text-xs text-neutral-500">성공적으로 연 문서만 이 기기에 최대 9개 기록됩니다.</p>
                </div>
              ) : (
                <ul className="mt-3 divide-y divide-black/10 overflow-hidden rounded-xl border border-black/10 dark:divide-white/10 dark:border-white/10">
                  {recentDocuments.map((entry, index) => (
                    <li key={`${entry.path}:${entry.lastOpenedMs}`} className="flex items-center gap-3 px-4 py-3">
                      <button onClick={() => void reopenRecentDocument(index)} className="min-w-0 flex-1 text-left">
                        <span className="block truncate text-sm font-medium">{basename(entry.path)}</span>
                        <span className="mt-0.5 block text-xs text-neutral-500">{new Date(entry.lastOpenedMs).toLocaleString()}</span>
                      </button>
                      <button
                        onClick={() => void removeRecentDocument(index)}
                        aria-label={`${basename(entry.path)} 최근 목록에서 지우기`}
                        className="rounded-md px-2 py-1 text-xs text-neutral-500 hover:bg-black/5 hover:text-neutral-900 dark:hover:bg-white/10 dark:hover:text-white"
                      >지우기</button>
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-4 text-xs leading-5 text-neutral-400">
                최근 목록에는 로컬 경로와 마지막으로 연 시간만 저장됩니다. 문서 내용·텍스트·해시·미리보기·AI 컨텍스트는 저장하지 않습니다.
              </p>
            </section>
          </main>
        )}
      </div>

      {!hasDoc && recoveries[0] && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-6"
          role="dialog"
          aria-modal="true"
          aria-labelledby="recovery-title"
        >
          <div className="w-full max-w-sm rounded-xl bg-white p-5 shadow-2xl dark:bg-neutral-800">
            <h2 id="recovery-title" className="text-base font-semibold">
              복구 가능한 편집본이 있습니다
            </h2>
            <p className="mt-2 text-sm leading-6 text-neutral-600 dark:text-neutral-300">
              {new Date(recoveries[0].savedAtMs).toLocaleString()} · 편집 {recoveries[0].revision}회 · {Math.ceil(recoveries[0].byteLen / 1024)}KB
              <br />복구하면 원본을 덮어쓰지 않는 새 미저장 문서로 열립니다.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => void discardRecovery(recoveries[0])}
                className="rounded-md border border-black/15 px-3 py-1.5 text-sm dark:border-white/20"
              >
                삭제
              </button>
              <button
                autoFocus
                onClick={() => restoreRecovery(recoveries[0])}
                className="rounded-md bg-violet-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-violet-500"
              >
                복구하기
              </button>
            </div>
          </div>
        </div>
      )}

      {(closeRequested || (hasDoc && !!pendingOpenPaths[0] && !!sessionStatus?.dirty)) && !pendingOverwrite && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-6" role="dialog" aria-modal="true" aria-labelledby="dirty-document-title">
          <div className="w-full max-w-sm rounded-xl bg-white p-5 shadow-2xl dark:bg-neutral-800">
            <h2 id="dirty-document-title" className="text-base font-semibold">변경 내용을 저장할까요?</h2>
            <p className="mt-2 text-sm leading-6 text-neutral-600 dark:text-neutral-300">
              {closeRequested ? "앱을 닫기 전에" : `${basename(pendingOpenPaths[0])} 파일을 열기 전에`} 저장, 버리기, 취소 중 하나를 선택하세요.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                autoFocus
                onClick={() => closeRequested ? setCloseRequested(false) : setPendingOpenPaths((current) => current.slice(1))}
                className="rounded-md border border-black/15 px-3 py-1.5 text-sm dark:border-white/20"
              >취소</button>
              <button
                onClick={() => void discardAndContinue(closeRequested ? "close" : "replace")}
                className="rounded-md border border-red-300 px-3 py-1.5 text-sm text-red-700 dark:border-red-800 dark:text-red-300"
              >버리기</button>
              <button
                onClick={() => void doSaveHwpx(closeRequested ? "close" : "replace")}
                className="rounded-md bg-violet-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-violet-500"
              >저장</button>
            </div>
          </div>
        </div>
      )}

      {pendingOverwrite && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-6" role="dialog" aria-modal="true" aria-labelledby="external-change-title">
          <div className="w-full max-w-sm rounded-xl bg-white p-5 shadow-2xl dark:bg-neutral-800">
            <h2 id="external-change-title" className="text-base font-semibold">파일이 외부에서 변경되었습니다</h2>
            <p className="mt-2 text-sm leading-6 text-neutral-600 dark:text-neutral-300">열어 둔 뒤 다른 앱이 파일을 변경했습니다. 검토 없이 덮어쓰지 않습니다.</p>
            <div className="mt-5 flex justify-end gap-2">
              <button autoFocus onClick={() => setPendingOverwrite(null)} className="rounded-md border border-black/15 px-3 py-1.5 text-sm dark:border-white/20">취소</button>
              <button
                onClick={() => {
                  const pending = pendingOverwrite;
                  setPendingOverwrite(null);
                  void saveToPath(pending.path, true, pending.after);
                }}
                className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-500"
              >변경 확인 후 덮어쓰기</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Mount the desktop workspace shell into an existing React root (called from `main.tsx` behind the flag). */
export function mountWorkspaceShell(root: Root): void {
  root.render(
    <StrictMode>
      <WorkspaceShell />
    </StrictMode>,
  );
}
