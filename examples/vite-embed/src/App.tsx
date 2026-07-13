import { useCallback, useMemo, useRef, useState } from "react";
import {
  HwpWorkspace,
  WasmAdapter,
  type Anchor,
  type DocContext,
  type Intent,
  type WasmAdapterOptions,
} from "@tf-hwp/react";
import { buildDocContext } from "@tf-hwp/ai-protocol";
import "@tf-hwp/react/styles.css";

// ── 비-Next(Vite) 임베드 예제 (issue 063) ────────────────────────────────────────────────────────
// 이 파일은 소스 트리가 아니라 **설치된 발행본**(node_modules/@tf-hwp/*, npm pack tarball)만 import 한다.
// wasm/worker 는 public 정적 에셋(/hwp/*)으로 서빙된다(scripts/copy-assets.mjs 가 설치본에서 복사).
// LLM 은 이 예제에 없다(R6) — onAiRequest 는 **로컬 결정적 mock**(참조 프록시의 mock 과 동형)이라
// 서버 없이도 "셀 편집" 왕복이 완주된다. 실제 호스트는 이 자리에 자신의 서버 프록시 fetch 를 꽂으면 된다
// (examples/ai-proxy-express 템플릿 참고).

const DEFAULT_FONT_PATH = "/fonts/NanumGothic-Regular.ttf";
const DEFAULT_FONT_FAMILY = "Nanum Gothic";

/** 참조 프록시(apps/hwp-lab/.../route.ts)의 mockIntents 와 동형인 로컬 mock. 클릭한 셀(rows/cols)에
 *  "PoC ✔" 를 써 넣어, 서버 없이도 뷰어 렌더 + 셀 편집 스모크가 완주된다. */
function mockIntents(instruction: string, anchors: Anchor[]): Intent[] {
  const a = anchors[0];
  if (!a) return [];
  if (a.kind === "table" || a.kind === "range" || a.kind === "cell") {
    return [{ intent: "SetTableCell", section: a.section, index: a.block, row: a.rows?.[0] ?? 0, col: a.cols?.[0] ?? 0, text: "PoC ✔" }];
  }
  if (a.kind === "paragraph") {
    return [{ intent: "SetParagraphText", section: a.section, block: a.block, text: instruction.slice(0, 60) || "PoC ✔" }];
  }
  return [];
}

export default function App() {
  const [doc, setDoc] = useState<{ bytes: Uint8Array; name: string } | null>(null);
  const [defaultFont, setDefaultFont] = useState<{ family: string; bytes: Uint8Array } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const loadedFontRef = useRef(false);

  // wasm/worker 는 public 정적 에셋을 명시적 URL 로 로드한다(번들러 마법 X — 비-Next 서빙 레시피).
  const adapter = useMemo(() => {
    const wasmUrl = new URL("/hwp/hwp_wasm_bg.wasm", window.location.origin);
    const options: WasmAdapterOptions = { worker: { url: new URL("/hwp/worker.js", window.location.origin) } };
    return new WasmAdapter(wasmUrl, options);
  }, []);

  // 기본 폰트(OFL NanumGothic)를 한 번 fetch — 열기 직후 자동 registerFont(화면/조판/PDF 일치, R8).
  const ensureFont = useCallback(async () => {
    if (loadedFontRef.current) return;
    loadedFontRef.current = true;
    try {
      const r = await fetch(DEFAULT_FONT_PATH);
      if (r.ok) setDefaultFont({ family: DEFAULT_FONT_FAMILY, bytes: new Uint8Array(await r.arrayBuffer()) });
    } catch {
      /* 폰트 미배치 — copy-assets 전이거나 오프라인. PDF 는 폰트 주입 후 활성화된다. */
    }
  }, []);

  const openBytes = useCallback(
    async (bytes: Uint8Array, name: string) => {
      if (!/\.(hwp|hwpx)$/i.test(name)) {
        setError(`지원하지 않는 형식: ${name} (.hwp/.hwpx 만)`);
        return;
      }
      setBusy(true);
      setError(null);
      void ensureFont();
      // 손상/악성 파일이 현재 세션을 깨지 않도록 프로브 어댑터로 먼저 검증(워커 격리).
      const probe = new WasmAdapter(new URL("/hwp/hwp_wasm_bg.wasm", window.location.origin), {
        worker: { url: new URL("/hwp/worker.js", window.location.origin) },
      });
      try {
        await probe.open(bytes, name);
        probe.dispose();
        setDoc({ bytes, name });
      } catch (e) {
        probe.dispose();
        setError(`파일을 열 수 없습니다: ${name}\n${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setBusy(false);
      }
    },
    [ensureFont],
  );

  const onFile = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = "";
      if (!file) return;
      await openBytes(new Uint8Array(await file.arrayBuffer()), file.name);
    },
    [openBytes],
  );

  // R6: 패키지는 LLM/키를 갖지 않는다. 여기선 로컬 mock. 실제 호스트는 이 자리에서 서버 프록시로 POST.
  // (ai-protocol.buildDocContext 는 서버로 보낼 R5-펜스 문자열을 만든다 — isomorphic 패키지가 클라에서도
  //  동작함을 증명하려고 mock 경로에서도 호출한다.)
  const onAiRequest = useCallback(async (instruction: string, anchors: Anchor[], ctx: DocContext): Promise<Intent[]> => {
    buildDocContext({ format: ctx.format, pages: ctx.pages, editable: ctx.editable, sections: ctx.sections }, anchors);
    return mockIntents(instruction, anchors);
  }, []);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", fontFamily: "system-ui, sans-serif" }}>
      <header style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 16px", borderBottom: "1px solid #ddd" }}>
        <strong>tf-hwp Vite 임베드 예제</strong>
        <label style={{ cursor: "pointer", padding: "4px 12px", border: "1px solid #888", borderRadius: 6 }}>
          파일 열기 (.hwp/.hwpx)
          <input type="file" accept=".hwp,.hwpx" hidden onChange={onFile} data-testid="file-input" />
        </label>
        {busy && <span data-testid="busy">여는 중…</span>}
        <span style={{ marginLeft: "auto", fontSize: 12, color: "#888" }}>published tarball · no server · mock AI</span>
      </header>

      {error && (
        <div role="alert" data-testid="error" style={{ whiteSpace: "pre-wrap", padding: 12, background: "#fee", color: "#900" }}>
          {error}
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0 }}>
        {doc ? (
          <HwpWorkspace
            adapter={adapter}
            document={doc}
            onAiRequest={onAiRequest}
            defaultFont={defaultFont}
            fontUrlBase="/fonts"
            enableEditing
            isMock
          />
        ) : (
          <div style={{ padding: 24, color: "#555" }}>
            상단 <b>파일 열기</b>로 <code>.hwp / .hwpx</code>를 업로드하세요. 데모 픽스처: 레포 <code>benchmarks/benchmark.hwp</code>(8쪽).
          </div>
        )}
      </div>
    </div>
  );
}
