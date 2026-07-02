"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HwpWorkspace, WasmAdapter, type Anchor, type DocContext, type Intent } from "@tf-hwp/react";
import { resetEngine } from "@tf-hwp/engine";

type Mode = "loading" | "mock" | "live";
type Doc = { bytes: Uint8Array; name: string };

// public/fonts 에 이 파일이 있으면 PDF용 폰트로 자동 fetch(폰트 파일은 git에 넣지 않음 — 사용자가
// 로컬에 떨어뜨리거나 헤더의 폰트 선택으로 주입). OFL Noto Sans KR 권장.
const PUBLIC_FONT_PATH = "/fonts/NotoSansKR-Regular.ttf";
const PUBLIC_FONT_FAMILY = "Noto Sans KR";

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

/**
 * 마킹된 앵커/문서 메타를 프록시가 R5 펜스(`<document-content>`)로 감쌀 "문서 콘텐츠" 문자열로
 * 만든다. 앵커의 `text`는 문서에서 파생된 신뢰불가 데이터다. (프록시 계약: docContext=string.)
 */
function buildDocContextString(anchors: Anchor[], ctx: DocContext): string {
  const head = `format=${ctx.format} pages=${ctx.pages} editable=${ctx.editable} sections=${ctx.sections}`;
  const lines = anchors.map((a, i) => {
    const rows = a.rows ? ` rows=[${a.rows[0]},${a.rows[1]}]` : "";
    const cols = a.cols ? ` cols=[${a.cols[0]},${a.cols[1]}]` : "";
    return `#${i} ${a.kind} section=${a.section} block=${a.block}${rows}${cols} text=${JSON.stringify(a.text ?? "")}`;
  });
  return [head, ...lines].join("\n").slice(0, 8000);
}

export default function LabWorkspace() {
  const [mode, setMode] = useState<Mode>("loading");
  const [doc, setDoc] = useState<Doc | null>(null);
  const [labError, setLabError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const fontRef = useRef<File | null>(null);
  const [fontName, setFontName] = useState<string | null>(null);

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

  const onFile = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = ""; // 같은 파일 재선택 허용
      if (!file) return;
      const name = file.name;
      if (!/\.(hwp|hwpx)$/i.test(name)) {
        setDoc(null);
        setLabError(`지원하지 않는 형식입니다: ${name}\n.hwp 또는 .hwpx 파일만 열 수 있습니다.`);
        return;
      }
      setBusy("문서 여는 중…");
      setLabError(null);
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (bytes.length === 0) {
        setBusy(null);
        setDoc(null);
        setLabError(`빈 파일입니다: ${name}`);
        return;
      }
      // 손상/악성 파일이 현재 열린 세션을 깨지 않도록 별도 프로브 어댑터로 먼저 검증한다.
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

  // 채팅 바이브편집 브리지(R6): 패키지는 LLM/키를 갖지 않는다. 서버 프록시(/api/hwp-edit)로 위임.
  const onAiRequest = useCallback(async (instruction: string, anchors: Anchor[], ctx: DocContext): Promise<Intent[]> => {
    const res = await fetch("/api/hwp-edit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        instruction,
        anchors,
        docContext: buildDocContextString(anchors, ctx),
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

  // R8: 폰트는 번들하지 않는다. PDF 클릭 시 폰트 미주입이면 호출된다.
  // 우선순위: 헤더에서 선택한 로컬 .ttf → public/fonts 의 폰트 → (없으면) 안내 후 취소.
  const requestFont = useCallback(async (): Promise<{ family: string; bytes: Uint8Array } | null> => {
    if (fontRef.current) {
      return { family: fontRef.current.name, bytes: new Uint8Array(await fontRef.current.arrayBuffer()) };
    }
    try {
      const r = await fetch(PUBLIC_FONT_PATH);
      if (r.ok) {
        return { family: PUBLIC_FONT_FAMILY, bytes: new Uint8Array(await r.arrayBuffer()) };
      }
    } catch {
      /* public/fonts 미배치 — 로컬 선택으로 폴백 */
    }
    setLabError(
      `PDF용 폰트가 없습니다.\n헤더의 "폰트 선택 (.ttf/.otf)"으로 폰트를 주입하거나, ` +
        `public/fonts/NotoSansKR-Regular.ttf 를 배치하세요. (한컴/함초롬 폰트는 재배포 불가로 번들하지 않습니다.)`,
    );
    return null;
  }, []);

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

        <label className="lab-btn">
          폰트 선택 (.ttf/.otf)
          <input
            type="file"
            accept=".ttf,.otf"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null;
              fontRef.current = f;
              setFontName(f?.name ?? null);
            }}
          />
        </label>
        {fontName && <span className="lab-note">폰트: {fontName}</span>}

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
            isMock={mode === "mock"}
          />
        ) : (
          <div className="lab-empty">
            상단의 <b>&nbsp;파일 열기&nbsp;</b>로 <code>.hwp / .hwpx</code>를 업로드하세요.
            <br />
            데모 픽스처: 레포 루트의 <code>benchmark.hwp</code>(8쪽) · <code>benchmark1.hwp</code>(19쪽).
          </div>
        )}
        {busy && doc && <div className="lab-loading-overlay">{busy}</div>}
      </div>
    </div>
  );
}
