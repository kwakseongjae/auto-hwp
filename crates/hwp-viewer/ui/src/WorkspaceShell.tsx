import { StrictMode, useCallback, useEffect, useRef, useState } from "react";
import type { Root } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { HwpWorkspace, TauriAdapter, type OnAiRequest } from "@auto-hwp/react";
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
///   2. 파일 열기  — a native file dialog → path, bridged into `adapter.open(bytes)` via `resolveOpenPath`.
///   3. 저장/내보내기 — native save dialogs + ATOMIC writes (P0-1), reusing the existing path-based export
///                  commands; the web `<a download>` convention is intercepted via the opt-in `onExport`.
///   4. 드래그드롭 열기 — Tauri `onDragDropEvent` → open a dropped .hwp/.hwpx (same UX as the legacy app).
/// registerFont is a documented no-op on desktop (native font stack), so NO `fontCatalog` is injected.

// One adapter for the shell's lifetime (it holds the Tauri `invoke` seam; the open document lives in the
// Rust session). `resolveOpenPath` bridges the web `open(bytes)` seam to the desktop's path-based
// `open_doc`: the shell encodes the picked native PATH into the `document.bytes` it hands the workspace,
// and this decodes it straight back — no temp file, no extra command (the file is opened in place).
const PATH_CODEC = { encode: (p: string) => new TextEncoder().encode(p), decode: (b: Uint8Array) => new TextDecoder().decode(b) };
const adapter = new TauriAdapter({ invoke, resolveOpenPath: async (bytes) => PATH_CODEC.decode(bytes) });

const IS_DOC = /\.(hwp|hwpx)$/i;
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
  const hasDoc = doc != null;

  const flash = useCallback((s: string) => {
    setNote(s);
    window.setTimeout(() => setNote((cur) => (cur === s ? "" : cur)), 4000);
  }, []);

  // Open a native path by handing the workspace a fresh `document` whose bytes carry the path (a new
  // object each call → the workspace re-opens even when the same file is re-picked). resolveOpenPath
  // decodes the path back and the Rust `open_doc` reads the real file in place.
  const openPath = useCallback((path: string) => {
    const name = basename(path);
    setDoc({ bytes: PATH_CODEC.encode(path), name });
    setDocName(name);
  }, []);

  const doOpen = useCallback(async () => {
    try {
      const path = await openDialog({ filters: [{ name: "HWP/HWPX", extensions: ["hwpx", "hwp"] }] });
      if (typeof path !== "string") return;
      openPath(path);
    } catch (e) {
      flash(`열기 실패: ${e}`);
    }
  }, [openPath, flash]);

  // 저장 (HWPX) — the atomic P0-1 path (`hwp_core::atomic_write`: temp + fsync + rename) via the existing
  // path-based `export_hwpx` command. The byte twin (`toHwpx()`) exists on the adapter but the host chrome
  // reuses the tested atomic writer, so no bare-bytes write command is introduced (엔진 무접촉).
  const doSaveHwpx = useCallback(async () => {
    if (!hasDoc) return;
    try {
      const path = await saveDialog({ defaultPath: "export.hwpx", filters: [{ name: "HWPX", extensions: ["hwpx"] }] });
      if (typeof path !== "string") return;
      flash(await invoke<string>("export_hwpx", { path }));
    } catch (e) {
      flash(`저장 실패: ${e}`);
    }
  }, [hasDoc, flash]);

  // 내보내기 (HTML/PDF) — the workspace's export buttons route HERE (opt-in `onExport`) instead of a
  // browser download. Native save dialog + the existing path-based atomic export commands, which
  // re-serialize the SAME live Rust session ⇒ byte-identical to the workspace's own `adapter.export*`.
  const onExport = useCallback(
    async (data: Uint8Array | string, filename: string, mime: string) => {
      void data; // reusing the atomic path commands (P0-1), not writing the passed bytes — same session.
      try {
        if (mime === "application/pdf") {
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
    [flash],
  );

  // 드래그드롭 열기 — the WebView never fires a browser `drop`, so subscribe to Tauri's native
  // `onDragDropEvent` (it carries OS file PATHS). A dropped .hwp/.hwpx opens; anything else is ignored.
  const openPathRef = useRef(openPath);
  openPathRef.current = openPath;
  useEffect(() => {
    let un: undefined | (() => void);
    (async () => {
      un = await getCurrentWebviewWindow().onDragDropEvent((event) => {
        const p = event.payload;
        if (p.type !== "drop") return;
        const hit = p.paths.find((f) => IS_DOC.test(f));
        if (hit) openPathRef.current(hit);
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
        <span data-tauri-drag-region className="ml-1 text-sm font-medium">
          {docName ?? "한칸"}
        </span>
        {note && <span className="text-xs text-neutral-400">· {note}</span>}
        <div data-tauri-drag-region className="h-6 flex-1" />
      </header>

      {/* The shared workspace fills the rest. enableEditing turns on the manual editing chrome (더블클릭
          제자리 편집 · 서식 툴바 · 열/행 크기 조절 · 우클릭 메뉴). No fontCatalog: desktop renders with its
          native font stack (registerFont is a documented no-op). onExport intercepts HTML/PDF export. */}
      <div className="min-h-0 flex-1">
        <HwpWorkspace adapter={adapter} document={doc} onAiRequest={disabledAi} enableEditing onExport={onExport} />
      </div>
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
