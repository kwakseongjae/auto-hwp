"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HwpWorkspace, WasmAdapter, FONT_CATALOG, type AiRequestOptions, type Anchor, type Citation, type DocContext, type Intent, type WasmAdapterOptions } from "@tf-hwp/react";
import { buildDocContext } from "@tf-hwp/ai-protocol";
import { isTrapError, resetEngine } from "@tf-hwp/engine";
import { AutosaveController, IdbSnapshotStore, findRecoverable, formatAge, recoveredName, type SnapshotRecord } from "@/lib/autosave";
import { limitMessage, oversizeMessage } from "@/lib/limits";

type Mode = "loading" | "mock" | "live";
type Doc = { bytes: Uint8Array; name: string };

// 기본 폰트: 레포 자산 NanumGothic(OFL) — copy-fonts.mjs 가 public/fonts 로 복사하므로 오프라인에서도
// 항상 존재한다. 열기 직후 자동 등록되어 화면·조판·PDF 가 즉시 이 폰트로 일치하고 PDF 버튼이 활성화된다.
// 카탈로그의 나머지 폰트(scripts/fetch-fonts.mjs, git 제외)는 툴바 FontPicker 에서 선택/업로드한다.
const DEFAULT_FONT_PATH = "/fonts/NanumGothic-Regular.ttf";
const DEFAULT_FONT_FAMILY = "Nanum Gothic";
const FONT_URL_BASE = "/fonts";

const msg = (e: unknown): string => {
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
};

// wasm 트랩(패닉)은 전역 인스턴스를 오염시킨다. 손상 파일 프로브 열기가 트랩나면 다음 업로드를 위해
// 인스턴스를 재생성해야 한다(이슈 §QA ⑨ 트랩 복구 안내). 분류기는 @tf-hwp/engine 의 `isTrapError`
// 단일 소스를 소비한다(이슈 055 사후 #8 — 로컬 사본은 'table index is out of bounds' 패턴이 빠져
// 메인스레드 폴백(?engineWorker=off)에서 트랩을 놓치고 resetEngine 을 건너뛰었다).

// 마킹된 앵커/문서 메타를 프록시가 R5 펜스로 감쌀 "문서 콘텐츠" 문자열로 만드는 로직은 이제
// @tf-hwp/ai-protocol 의 buildDocContext 가 소유한다(이슈 026) — 서버 route.ts 의 프롬프트/펜스
// 조립과 같은 모듈에서 나와 계약이 어긋날 수 없다. 앵커의 `text`는 문서 파생 신뢰불가 데이터.

export default function LabWorkspace() {
  const [mode, setMode] = useState<Mode>("loading");
  const [doc, setDoc] = useState<Doc | null>(null);
  const [labError, setLabError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // 기본 폰트 바이트(NanumGothic) — 열기 직후 자동 등록되도록 HwpWorkspace 에 defaultFont 로 전달.
  const [defaultFont, setDefaultFont] = useState<{ family: string; bytes: Uint8Array } | null>(null);

  // ── 이슈 052: 자동저장 + 세션 복구 상태 ─────────────────────────────────────────────────────────
  // 열기 화면의 미복구 스냅샷(배너), 자동저장/복구 안내 문구, 마지막 자동저장 라벨(헤더 표시 + e2e 신호).
  const [recovery, setRecovery] = useState<SnapshotRecord | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [savedLabel, setSavedLabel] = useState<string | null>(null);
  // 복구 클릭으로 연 문서: 열기 성공 시 adoptRecovered(재귀속 + 옛 키 삭제)할 원본 레코드.
  const pendingRecoveryRef = useRef<SnapshotRecord | null>(null);
  // 포인터 제스처(드래그) 진행 중엔 자동저장 flush 를 미룬다(렌더-0 규율). 이슈 055 워커화로 toHwpx
  // 는 이제 비차단이지만, 제스처 중 불필요한 직렬화/RPC 왕복을 피하는 유휴 게이트는 그대로 유효하다.
  const pointerDownRef = useRef(false);

  // ssr:false 로 로드되므로 window 존재. wasm은 public 정적 에셋을 명시적 URL로 fetch(번들러 마법 X).
  const wasmUrl = useMemo(() => new URL("/hwp/hwp_wasm_bg.wasm", window.location.origin), []);
  // 이슈 055(FG-14): 엔진은 기본적으로 Web Worker 에서 돈다(파싱/재조판/export/toHwpx 가 메인스레드를
  // 멈추지 않는다). 워커 스크립트도 public 정적 에셋(모듈 워커 — copy-wasm.mjs 가 배치). 계측/롤백용
  // 탈출구: `?engineWorker=off` 로 열면 기존 메인스레드 엔진으로 동작한다(BEFORE/AFTER 실측이 이 스위치).
  const workerMode = useMemo(() => new URLSearchParams(window.location.search).get("engineWorker") !== "off", []);
  const adapterOptions = useMemo<WasmAdapterOptions | undefined>(
    () => (workerMode ? { worker: { url: new URL("/hwp/worker.js", window.location.origin) } } : undefined),
    [workerMode],
  );
  const adapter = useMemo(() => new WasmAdapter(wasmUrl, adapterOptions), [wasmUrl, adapterOptions]);
  // 열기(프로브) 진행 중 취소용 핸들 — 워커 모드에선 dispose()가 프로브 워커를 종료해 파싱을 즉시 중단한다.
  const probeRef = useRef<WasmAdapter | null>(null);

  // 자동저장 파이프라인(052): 성공한 편집(onMutation) → 2s 유휴 디바운스 → adapter.toHwpx() →
  // IndexedDB(문서당 최신 1개 · 전체 상한 · TTL 7일). IndexedDB 실패는 1회 안내 후 비활성 —
  // 메모리 최신본으로 트랩 직후 복구는 계속 동작한다.
  const store = useMemo(() => new IdbSnapshotStore(), []);
  const autosave = useMemo(
    () =>
      new AutosaveController(store, adapter, {
        canFlushNow: () => !pointerDownRef.current,
        onSaved: (rec) => setSavedLabel(`자동저장됨 rev ${rec.rev} · ${new Date(rec.savedAt).toLocaleTimeString()}`),
        onDisabled: () =>
          setNotice(
            "자동저장을 사용할 수 없습니다(시크릿 모드/저장공간 거부). 이 세션에서는 복구 스냅샷이 브라우저에 저장되지 않습니다 — 트랩 직후 복구만 동작합니다.",
          ),
      }),
    [store, adapter],
  );

  // 어댑터 ↔ 자동저장 배선: 편집 신호(onMutation), 트랩 복구의 스냅샷 우선(setRecoverySource),
  // 복구 결과의 정직한 안내(onRecovered — 스냅샷 복구 vs 원본 폴백+사유).
  useEffect(() => {
    adapter.onMutation = () => autosave.noteEdit();
    adapter.setRecoverySource(() => autosave.getRecoverySnapshot());
    adapter.onRecovered = (info) => {
      if (info.source === "snapshot") {
        setNotice(`엔진 트랩 복구: 마지막 자동저장 편집본(${info.label ?? "최신"})으로 복구했습니다. 스냅샷 이후의 편집은 소실되었을 수 있습니다.`);
      } else if (info.reason) {
        setNotice(`엔진 트랩 복구: 자동저장 편집본을 열지 못해(${info.reason}) 원본 파일로 복구했습니다 — 편집 내용이 소실되었습니다.`);
      }
      // reason 없는 original(스냅샷이 아예 없던 경우)은 기존 워크스페이스 토스트만으로 충분.
    };
    return () => {
      adapter.onMutation = null;
      adapter.setRecoverySource(null);
      adapter.onRecovered = null;
    };
  }, [adapter, autosave]);

  // 드래그 게이트 소스: 포인터가 눌린 동안 flush 금지(캡처 단계 — 워크스페이스 내부 제스처 모두 포착).
  useEffect(() => {
    const down = () => (pointerDownRef.current = true);
    const up = () => (pointerDownRef.current = false);
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", up, true);
    return () => {
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", up, true);
    };
  }, []);

  // 문서 수명 → 자동저장 세션: 열기 성공 시 세션 시작(+복구본이면 재귀속), 닫힘/언마운트 시 정리.
  useEffect(() => {
    if (doc) {
      autosave.openSession(doc.name);
      setSavedLabel(null);
      const rec = pendingRecoveryRef.current;
      if (rec) {
        pendingRecoveryRef.current = null;
        void autosave.adoptRecovered(rec).then(() => setRecovery(null));
      }
    } else {
      autosave.closeSession();
      setSavedLabel(null);
    }
  }, [doc, autosave]);
  useEffect(() => () => autosave.dispose(), [autosave]);

  // 열기 화면(문서 없음)에서 미복구 스냅샷을 조회해 배너를 띄운다(만료분은 이 자리에서 청소).
  useEffect(() => {
    if (doc) return;
    let cancelled = false;
    findRecoverable(store)
      .then((rec) => {
        if (!cancelled) setRecovery(rec);
      })
      .catch(() => {
        if (!cancelled) setRecovery(null); // IndexedDB 접근 불가 — 배너 없음(저장도 곧 1회 안내 후 비활성)
      });
    return () => {
      cancelled = true;
    };
  }, [doc, store]);

  // 프록시 모드(mock/live)를 조회해 배지에 표시. 키는 서버 전용이므로 여기서 알 수 있는 건 모드뿐.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/hwp-edit", { method: "GET" })
      .then((r) => r.json())
      .then((d: { mode?: Mode }) => {
        if (!cancelled) setMode(d.mode === "live" ? "live" : "mock");
      })
      .catch(() => {
        if (!cancelled) setMode("mock");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 기본 폰트(NanumGothic)를 한 번 fetch 해 둔다 — HwpWorkspace 가 문서를 열면 이 바이트를 자동
  // registerFont 하여(메트릭+PDF) 화면/PDF 가 즉시 일치하고 PDF 버튼이 활성화된다. copy-fonts.mjs 가
  // public/fonts 에 레포 자산을 복사하므로 오프라인에서도 성공한다(실패 시 FontPicker 업로드로 폴백).
  useEffect(() => {
    let cancelled = false;
    fetch(DEFAULT_FONT_PATH)
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
      .then((buf) => {
        if (!cancelled) setDefaultFont({ family: DEFAULT_FONT_FAMILY, bytes: new Uint8Array(buf) });
      })
      .catch(() => {
        /* 기본 폰트 미배치 — copy-fonts.mjs 실행 전이거나 오프라인. FontPicker 로 직접 선택/업로드 가능. */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 열기 시퀀스 번호(이슈 055 사후 #5): 두 파일을 연이어 열면 먼저 시작한 open 의 finally 가 나중
  // open 의 probe/busy 를 지우고, 늦게 끝난 쪽 setDoc 이 이기는 경합이 있었다. 규칙은 ctxMenuSeqRef 와
  // 동일 — "최신 open 만이 doc/busy/probe/에러 표면을 만진다". 새 open 은 이전 인플라이트 프로브를
  // dispose 로 취소한다(그쪽 catch 는 worker_terminated 로 조용히 접힌다).
  const openSeqRef = useRef(0);

  // 바이트 → 문서 열기: 파일 픽커와 (HwpWorkspace 의) 문서 드롭이 공유하는 단일 경로. 손상/악성 파일이
  // 현재 세션을 깨지 않도록 프로브 어댑터로 먼저 검증한다(이슈 050: 문서 드롭=열기 분기가 여기로 온다).
  // 열기 성공 여부를 돌려준다(이슈 052: 복구 배너가 성공/실패 분기를 정직하게 처리).
  // 이슈 055 사후 #2: 거부/취소/실패 경로는 busy/probe 상태만 정리하고 **현재 doc 은 유지**한다 — 두
  // 번째 파일 열기가 거부됐다고 이미 열린 문서를 언마운트하지 않는다(열린 문서가 없었다면 그대로 없음).
  const openBytes = useCallback(
    async (bytes: Uint8Array, name: string): Promise<boolean> => {
      if (!/\.(hwp|hwpx)$/i.test(name)) {
        setLabError(`지원하지 않는 형식입니다: ${name}\n.hwp 또는 .hwpx 파일만 열 수 있습니다.`);
        return false;
      }
      if (bytes.length === 0) {
        setLabError(`빈 파일입니다: ${name}`);
        return false;
      }
      // 이슈 055 한도 UX: 엔진(hwp-ingest limits.rs MAX_RAW_FILE=64MiB)이 어차피 거부할 파일은
      // 파싱(워커 복사)을 시작하기 전에 정직한 사유로 거부한다.
      const tooBig = oversizeMessage(bytes.length, name);
      if (tooBig) {
        setLabError(tooBig);
        return false;
      }
      const seq = ++openSeqRef.current;
      const latest = () => openSeqRef.current === seq;
      probeRef.current?.dispose(); // 이 open 이 최신 — 이전 인플라이트 프로브는 취소(워커 종료)
      setBusy("문서 여는 중…");
      setLabError(null);
      const probe = new WasmAdapter(wasmUrl, adapterOptions);
      probeRef.current = probe; // 취소 버튼이 이 핸들의 dispose()로 파싱을 중단한다(워커 종료)
      try {
        await probe.open(bytes, name);
        probe.dispose();
        if (!latest()) return false; // 더 새 open 이 시작됨 — 그쪽 결과가 이긴다
        setDoc({ bytes, name });
        return true;
      } catch (err) {
        // 이슈 055: 사용자가 취소(워커 종료)한 경우 — 오류가 아니다. 조용히 접는다(현재 문서 유지).
        if ((err as { code?: string })?.code === "worker_terminated") {
          return false;
        }
        if (workerMode) {
          // 워커 모드: 트랩이 나도 프로브 워커에 격리된다(어댑터가 자체 reset까지 수행). 프로브
          // 워커를 종료해 자원만 회수하면 된다 — 메인 어댑터/엔진은 애초에 오염되지 않았다.
          probe.dispose();
        } else if (isTrapError(err)) {
          // 메인스레드 모드(폴백): 전역 wasm 인스턴스가 오염됨 → 다음 업로드를 위해 재생성(트랩 복구).
          try {
            await resetEngine(wasmUrl);
          } catch {
            /* 재생성 실패는 다음 상호작용에서 다시 시도됨 */
          }
        }
        if (!latest()) return false; // 뒤에 새 open 이 시작됐다 — 그쪽 표면을 어지럽히지 않는다
        // 이슈 055 한도 UX: DocLimit/형식 계열 오류는 사람이 읽는 사유로 매핑, 모르는 오류는 기존 문구.
        const friendly = limitMessage(msg(err));
        setLabError(
          friendly
            ? `파일을 열 수 없습니다: ${name}\n${friendly}`
            : `파일을 열 수 없습니다: ${name}\n${msg(err)}\n` +
                `손상되었거나 지원하지 않는 파일일 수 있습니다. 다른 파일을 시도하거나 원본을 다시 저장해 보세요.`,
        );
        return false;
      } finally {
        if (latest()) {
          probeRef.current = null;
          setBusy(null);
        }
      }
    },
    [wasmUrl, adapterOptions, workerMode],
  );

  // 이슈 055: 파싱 취소 — 진행 중 프로브의 워커를 종료한다(위 catch 가 worker_terminated 로 접는다).
  const cancelOpen = useCallback(() => {
    probeRef.current?.dispose();
  }, []);

  const onFile = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = ""; // 같은 파일 재선택 허용
      if (!file) return;
      await openBytes(new Uint8Array(await file.arrayBuffer()), file.name);
    },
    [openBytes],
  );

  // ── 이슈 052: 복구 배너 액션 ─────────────────────────────────────────────────────────────────────
  // 복구 = 스냅샷 바이트(편집된 HWPX본)를 " (복구본).hwpx" 이름으로 연다. 열기 성공 시(위 doc 이펙트)
  // adoptRecovered 가 새 세션으로 재귀속 + 옛 키 삭제 — 콘텐츠는 절대 유실되지 않는다. 열기 실패 시
  // 스냅샷을 지우지 않고 정직한 사유를 남긴다(배너 유지 — 다시 시도/무시는 사용자의 선택).
  const onRestore = useCallback(async () => {
    if (!recovery) return;
    pendingRecoveryRef.current = recovery; // 열기 성공 시 [doc] 이펙트가 소비(adoptRecovered)한다
    const ok = await openBytes(recovery.bytes, recoveredName(recovery.docName));
    if (!ok) {
      // 열기 실패 — 재귀속되지 않았다. 스냅샷은 보존하고 사유만 알린다(다시 시도/무시는 사용자의 선택).
      pendingRecoveryRef.current = null;
      setNotice("복구본을 여는 데 실패했습니다 — 스냅샷은 보존됩니다. 다시 시도하거나 무시를 눌러 삭제하세요.");
    }
  }, [recovery, openBytes]);

  // 무시 = 스냅샷 삭제(설계 확정) — 배너도 내려간다.
  const onDismissRecovery = useCallback(async () => {
    if (!recovery) return;
    await store.delete(recovery.key).catch(() => {});
    setRecovery(null);
  }, [recovery, store]);

  // ── 이슈 052: 명시 내보내기 성공 시 스냅샷 정리 (v1 R13) ─────────────────────────────────────────
  // HwpWorkspace 의 onExport 시임(이슈 044)을 받아 웹 기본 동작(브라우저 <a download>)을 그대로 수행한
  // 뒤 markExported 로 이 세션의 스냅샷을 정리한다. 다운로드가 곧 "명시 저장"인 웹 셸의 규칙.
  const onExport = useCallback(
    async (data: Uint8Array | string, filename: string, mime: string) => {
      const part = typeof data === "string" ? data : (() => {
        const c = new Uint8Array(data.length);
        c.set(data);
        return c;
      })();
      const a = window.document.createElement("a");
      a.href = URL.createObjectURL(new Blob([part], { type: mime }));
      a.download = filename;
      a.click();
      window.setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      await autosave.markExported();
      setSavedLabel(null);
    },
    [autosave],
  );

  // 채팅 바이브편집 브리지(R6): 패키지는 LLM/키를 갖지 않는다. 서버 프록시(/api/hwp-edit)로 위임.
  // Feature A: opts.webSearch(있으면)를 본문에 실어 서버가 OpenRouter web 플러그인을 켜게 하고, 응답의
  // citations(url_citation → {title,url})를 opts.onCitations로 채팅에 넘긴다. 키/검색은 서버사이드(R6).
  const onAiRequest = useCallback(async (instruction: string, anchors: Anchor[], ctx: DocContext, opts?: AiRequestOptions): Promise<Intent[]> => {
    // 066: 표/셀 앵커마다 엔진에서 그 표의 셀 그리드(행×열·각 셀 텍스트·빈칸)를 조회해 doc-context 에
    // 첨부한다 — 그래야 모델이 "표 채워줘"·라벨 옆 값칸 지정·구조편집(행 N개)을 정확히 한다(얇은 앵커
    // 컨텍스트에선 intents 0 이었음). 표가 아니거나 조회 실패면 null(첨부 없음 → 기존 동작, 회귀 방지).
    const grids = await Promise.all(
      anchors.map((a) =>
        (a.kind === "table" || a.kind === "cell") && adapter.tableGrid
          ? adapter.tableGrid(a.section, a.block).catch(() => null)
          : Promise.resolve(null),
      ),
    );
    const res = await fetch("/api/hwp-edit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        instruction,
        anchors,
        // R5-펜스용 doc-context 문자열 — ai-protocol 이 서버와 공유하는 조립기(이슈 026). 066: 그리드 첨부.
        docContext: buildDocContext({ format: ctx.format, pages: ctx.pages, editable: ctx.editable, sections: ctx.sections }, anchors, { grids }),
        // Feature A: 웹 검색 grounding 옵트인(토글). 서버가 이 플래그일 때만 web 플러그인을 켠다.
        webSearch: opts?.webSearch ?? false,
        // 멀티모달: 첨부(이미지=vision dataUrl, 문서=추출 텍스트)를 서버로 전달. 서버가 이미지 present면
        // OpenAI content-parts로, 문서 텍스트는 R5 <attachment> 펜스로 조립한다. 키/모델은 서버사이드(R6).
        ...(opts?.attachments?.length ? { attachments: opts.attachments } : {}),
      }),
    });
    if (!res.ok) {
      let detail = `${res.status}`;
      try {
        const j = (await res.json()) as { error?: string };
        if (j?.error) detail = j.error;
      } catch {
        /* 비-JSON 오류 본문 */
      }
      throw new Error(`AI 서버 오류: ${detail}`);
    }
    const data = (await res.json()) as { intents?: Intent[]; citations?: Citation[] };
    // Feature A: 근거(출처)를 채팅으로 전달 — intents 반환 계약(Promise<Intent[]>)은 불변(InlineEditPanel 안전).
    if (opts?.onCitations) opts.onCitations(data.citations ?? []);
    return data.intents ?? [];
  }, [adapter]);

  // R8: 폰트는 번들하지 않는다. 기본 NanumGothic 이 자동 등록되므로 PDF 는 곧바로 활성화되지만,
  // (기본 폰트 fetch 실패 등으로) 미주입 상태에서 PDF 를 누르면 이 폴백이 호출된다: 기본 폰트를 다시
  // 시도하고, 그래도 없으면 툴바 FontPicker(카탈로그/업로드)로 안내한다.
  const requestFont = useCallback(async (): Promise<{ family: string; bytes: Uint8Array } | null> => {
    if (defaultFont) return defaultFont;
    try {
      const r = await fetch(DEFAULT_FONT_PATH);
      if (r.ok) return { family: DEFAULT_FONT_FAMILY, bytes: new Uint8Array(await r.arrayBuffer()) };
    } catch {
      /* 기본 폰트 미배치 — FontPicker 로 폴백 */
    }
    setLabError(
      `PDF용 폰트가 없습니다.\n상단 툴바의 "글꼴" 선택기에서 카탈로그 폰트를 고르거나 .ttf/.otf 를 업로드하세요. ` +
        `(scripts/fetch-fonts.mjs 로 카탈로그를 내려받을 수 있습니다. 한컴/함초롬 폰트는 재배포 불가로 번들하지 않습니다.)`,
    );
    return null;
  }, [defaultFont]);

  const badge =
    mode === "loading" ? (
      <span className="lab-badge lab-badge-loading">모드 확인 중…</span>
    ) : mode === "live" ? (
      // NOTE: 여기 클라이언트 배지 문구에는 키/모델 리터럴을 넣지 않는다(클라이언트 번들 grep 위생).
      // 실제 모델 ID(Opus 4.8)와 키 참조는 서버 전용 route.ts 에만 존재.
      <span className="lab-badge lab-badge-live" title="API 키 감지됨 — 서버가 실제 LLM 모델로 편집 제안">
        실 LLM 모드
      </span>
    ) : (
      <span className="lab-badge lab-badge-mock" title="키 없음 — 결정적 mock 편집(전체 플로우 완주 가능)">
        mock 모드
      </span>
    );

  return (
    <div className="lab-root">
      <header className="lab-header">
        <span className="lab-title">
          hwp-lab
          <small>tf-hwp 통합 실험 앱 (QA)</small>
        </span>

        <label className="lab-btn">
          파일 열기 (.hwp/.hwpx)
          <input type="file" accept=".hwp,.hwpx" hidden onChange={onFile} data-testid="file-input" />
        </label>

        {/* 글꼴 선택은 문서 툴바의 FontPicker(카탈로그+업로드)가 담당한다 — 화면·조판·PDF 일치. */}

        <span className="lab-spacer" />

        {busy && (
          <span className="lab-status lab-status-busy" role="status">
            {busy}
            {workerMode && (
              // 이슈 055: 워커 모드에선 파싱이 비차단이라 취소가 실제로 가능하다(프로브 워커 종료).
              <button className="lab-btn lab-cancel-open" data-testid="open-cancel" onClick={cancelOpen}>
                취소
              </button>
            )}
          </span>
        )}
        {savedLabel && (
          <span className="lab-status" role="status" data-testid="autosave-status" title="자동저장: 편집 2초 유휴 후 편집본(HWPX)을 브라우저(IndexedDB)에 보관">
            {savedLabel}
          </span>
        )}
        {badge}
      </header>

      {labError && (
        <div className="lab-error" role="alert" data-testid="lab-error">
          {labError}
        </div>
      )}

      {notice && (
        <div className="lab-error lab-notice" role="status" data-testid="autosave-notice">
          {notice}
          <button className="lab-btn lab-notice-close" onClick={() => setNotice(null)}>
            닫기
          </button>
        </div>
      )}

      <div className="lab-body">
        {doc ? (
          <HwpWorkspace
            adapter={adapter}
            document={doc}
            onAiRequest={onAiRequest}
            requestFont={requestFont}
            fontCatalog={FONT_CATALOG}
            defaultFont={defaultFont}
            fontUrlBase={FONT_URL_BASE}
            // 이슈 058: 명조(serif) 서체를 OFL 대체(Nanum Myeongjo)로 화면 @font-face + PDF 임베드까지 라우팅.
            // fetch-fonts.mjs 가 public/fonts 에 Nanum Myeongjo 를 받아 두면 명조/고딕이 구분 렌더된다.
            injectSerifSubstitute
            isMock={mode === "mock"}
            // 이슈 027: 수동 편집 UI(표 추가·룰러·열너비 드래그·더블클릭 텍스트·서식 툴바) 옵트인.
            enableEditing
            // 이슈 050: 페이지 위에 이미지를 드롭하면 삽입, .hwp/.hwpx 를 드롭하면 이 콜백으로 열기.
            onOpenFile={async (bytes, name) => {
              await openBytes(bytes, name); // 성공 여부는 복구 배너 전용 — 드롭 열기는 결과 무시(050 동작 유지)
            }}
            // 이슈 052: 내보내기는 웹 기본(브라우저 다운로드)을 그대로 수행하고 스냅샷을 정리한다.
            onExport={onExport}
          />
        ) : (
          <div className="lab-empty">
            {recovery && !busy && (
              // 이슈 052: 재방문 복구 배너 — 복구본은 "편집된 HWPX본"(원본 .hwp 아님)임을 명시한다.
              <div className="lab-recovery" role="alert" data-testid="recovery-banner">
                <div className="lab-recovery-text">
                  <b>『{recovery.docName}』</b>의 {formatAge(Date.now() - recovery.savedAt)} 편집본이 있습니다 (편집 {recovery.rev}회).
                  <br />
                  <small>복구본은 편집 내용이 반영된 <b>HWPX본</b>이며 원본 .hwp 파일이 아닙니다. 무시를 누르면 스냅샷이 삭제됩니다.</small>
                </div>
                <div className="lab-recovery-actions">
                  <button className="lab-btn lab-btn-accent" data-testid="recovery-restore" onClick={() => void onRestore()}>
                    복구
                  </button>
                  <button className="lab-btn" data-testid="recovery-dismiss" onClick={() => void onDismissRecovery()}>
                    무시
                  </button>
                </div>
              </div>
            )}
            <div>
              상단의 <b>&nbsp;파일 열기&nbsp;</b>로 <code>.hwp / .hwpx</code>를 업로드하세요.
              <br />
              데모 픽스처: 레포 루트의 <code>benchmark.hwp</code>(8쪽) · <code>benchmark1.hwp</code>(18쪽).
            </div>
          </div>
        )}
        {busy && doc && <div className="lab-loading-overlay">{busy}</div>}
      </div>
    </div>
  );
}
