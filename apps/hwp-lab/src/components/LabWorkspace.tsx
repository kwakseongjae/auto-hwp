"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { HwpWorkspace, WasmAdapter, FONT_CATALOG, type Anchor, type DocContext, type Intent } from "@tf-hwp/react";
import { buildDocContext } from "@tf-hwp/ai-protocol";
import { resetEngine } from "@tf-hwp/engine";

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
// 인스턴스를 재생성해야 한다(이슈 §QA ⑨ 트랩 복구 안내).
const isTrap = (e: unknown): boolean => {
  const code = (e as { code?: string })?.code;
  return code === "wasm_trap" || /RuntimeError|unreachable|memory access out of bounds/i.test(msg(e));
};

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

  // ssr:false 로 로드되므로 window 존재. wasm은 public 정적 에셋을 명시적 URL로 fetch(번들러 마법 X).
  const wasmUrl = useMemo(() => new URL("/hwp/hwp_wasm_bg.wasm", window.location.origin), []);
  const adapter = useMemo(() => new WasmAdapter(wasmUrl), [wasmUrl]);

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

  // 바이트 → 문서 열기: 파일 픽커와 (HwpWorkspace 의) 문서 드롭이 공유하는 단일 경로. 손상/악성 파일이
  // 현재 세션을 깨지 않도록 프로브 어댑터로 먼저 검증한다(이슈 050: 문서 드롭=열기 분기가 여기로 온다).
  const openBytes = useCallback(
    async (bytes: Uint8Array, name: string) => {
      if (!/\.(hwp|hwpx)$/i.test(name)) {
        setDoc(null);
        setLabError(`지원하지 않는 형식입니다: ${name}\n.hwp 또는 .hwpx 파일만 열 수 있습니다.`);
        return;
      }
      if (bytes.length === 0) {
        setDoc(null);
        setLabError(`빈 파일입니다: ${name}`);
        return;
      }
      setBusy("문서 여는 중…");
      setLabError(null);
      const probe = new WasmAdapter(wasmUrl);
      try {
        await probe.open(bytes, name);
        probe.dispose();
        setDoc({ bytes, name });
      } catch (err) {
        // 트랩이면 전역 wasm 인스턴스가 오염됨 → 다음 업로드를 위해 재생성(트랩 복구).
        if (isTrap(err)) {
          try {
            await resetEngine(wasmUrl);
          } catch {
            /* 재생성 실패는 다음 상호작용에서 다시 시도됨 */
          }
        }
        setDoc(null);
        setLabError(
          `파일을 열 수 없습니다: ${name}\n${msg(err)}\n` +
            `손상되었거나 지원하지 않는 파일일 수 있습니다. 다른 파일을 시도하거나 원본을 다시 저장해 보세요.`,
        );
      } finally {
        setBusy(null);
      }
    },
    [wasmUrl],
  );

  const onFile = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = ""; // 같은 파일 재선택 허용
      if (!file) return;
      await openBytes(new Uint8Array(await file.arrayBuffer()), file.name);
    },
    [openBytes],
  );

  // 채팅 바이브편집 브리지(R6): 패키지는 LLM/키를 갖지 않는다. 서버 프록시(/api/hwp-edit)로 위임.
  const onAiRequest = useCallback(async (instruction: string, anchors: Anchor[], ctx: DocContext): Promise<Intent[]> => {
    const res = await fetch("/api/hwp-edit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        instruction,
        anchors,
        // R5-펜스용 doc-context 문자열 — ai-protocol 이 서버와 공유하는 조립기(이슈 026).
        docContext: buildDocContext({ format: ctx.format, pages: ctx.pages, editable: ctx.editable, sections: ctx.sections }, anchors),
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
    const data = (await res.json()) as { intents?: Intent[] };
    return data.intents ?? [];
  }, []);

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
          </span>
        )}
        {badge}
      </header>

      {labError && (
        <div className="lab-error" role="alert" data-testid="lab-error">
          {labError}
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
            isMock={mode === "mock"}
            // 이슈 027: 수동 편집 UI(표 추가·룰러·열너비 드래그·더블클릭 텍스트·서식 툴바) 옵트인.
            enableEditing
            // 이슈 050: 페이지 위에 이미지를 드롭하면 삽입, .hwp/.hwpx 를 드롭하면 이 콜백으로 열기.
            onOpenFile={openBytes}
          />
        ) : (
          <div className="lab-empty">
            상단의 <b>&nbsp;파일 열기&nbsp;</b>로 <code>.hwp / .hwpx</code>를 업로드하세요.
            <br />
            데모 픽스처: 레포 루트의 <code>benchmark.hwp</code>(8쪽) · <code>benchmark1.hwp</code>(18쪽).
          </div>
        )}
        {busy && doc && <div className="lab-loading-overlay">{busy}</div>}
      </div>
    </div>
  );
}
