import { StrictMode, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { HwpWorkspace, WasmAdapter, type Anchor, type DocContext, type Intent } from "../src/index";

// One WasmAdapter for the app's lifetime (it holds the wasm instance + open document).
const adapter = new WasmAdapter();

// R8: fonts are injected, never bundled. The demo offers an offline local .ttf picker (preferred) and
// an OFL Noto Sans KR network fetch — the workspace calls this when PDF is requested and no font is set.
const NOTO_URL =
  "https://cdn.jsdelivr.net/gh/notofonts/notofonts.github.io/fonts/NotoSansKR/hinted/ttf/NotoSansKR-Regular.ttf";

/// MOCK AI (R6 demo): the package delegates ALL AI to this host callback. Here it is a fixed, canned
/// responder — NO LLM, NO key. If a table anchor is marked, it fills that table's first cell; if a
/// paragraph is marked, it rewrites it; otherwise it appends a paragraph. A real host would POST the
/// instruction + anchors + docContext to its own server and return the model's Intents.
async function mockAi(instruction: string, anchors: Anchor[], _ctx: DocContext): Promise<Intent[]> {
  void _ctx;
  await new Promise((r) => setTimeout(r, 350)); // simulate a round-trip
  const a = anchors[0];
  if (a && (a.kind === "table" || a.kind === "range" || a.kind === "cell")) {
    return [{ intent: "SetTableCell", section: a.section, index: a.block, row: 0, col: 0, text: instruction.slice(0, 24) || "예시 값" }];
  }
  if (a && a.kind === "paragraph") {
    return [{ intent: "SetParagraphText", section: a.section, block: a.block, text: instruction.slice(0, 60) || "다듬어진 문단입니다." }];
  }
  return [{ intent: "ApplyContent", json: JSON.stringify({ blocks: [{ type: "paragraph", runs: [{ text: instruction || "에이전트 추가 문단" }] }] }) }];
}

function App() {
  const [doc, setDoc] = useState<{ bytes: Uint8Array; name?: string } | null>(null);
  const fontRef = useRef<File | null>(null);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setDoc({ bytes: new Uint8Array(await f.arrayBuffer()), name: f.name });
  }

  // Font supplier: prefer a locally-selected face (offline); else fetch OFL Noto Sans KR.
  async function requestFont(): Promise<{ family: string; bytes: Uint8Array } | null> {
    if (fontRef.current) {
      return { family: fontRef.current.name, bytes: new Uint8Array(await fontRef.current.arrayBuffer()) };
    }
    const useNoto = window.confirm("주입된 폰트가 없습니다.\n확인 = Noto Sans KR(OFL) 네트워크 다운로드,\n취소 = 먼저 로컬 .ttf 선택");
    if (!useNoto) return null;
    const bytes = new Uint8Array(await (await fetch(NOTO_URL)).arrayBuffer());
    return { family: "Noto Sans KR", bytes };
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", padding: "8px 14px", background: "#fff", borderBottom: "1px solid #e2e4e8" }}>
        <strong style={{ fontSize: 14 }}>@tf-hwp/react 데모</strong>
        <label style={{ font: "inherit", fontSize: 13, padding: "5px 10px", border: "1px solid #cdd0d6", borderRadius: 6, cursor: "pointer" }}>
          파일 열기 (.hwp/.hwpx)
          <input type="file" accept=".hwp,.hwpx" hidden onChange={onFile} />
        </label>
        <label style={{ font: "inherit", fontSize: 13, padding: "5px 10px", border: "1px solid #cdd0d6", borderRadius: 6, cursor: "pointer" }}>
          폰트 선택 (.ttf/.otf)
          <input type="file" accept=".ttf,.otf" hidden onChange={(e) => (fontRef.current = e.target.files?.[0] ?? null)} />
        </label>
        <span style={{ fontSize: 12, color: "#6b7280" }}>업로드 → 표/문단 클릭(마킹) → 프롬프트 → 미리보기 → 적용 → PDF</span>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <HwpWorkspace adapter={adapter} document={doc} onAiRequest={mockAi} requestFont={requestFont} isMock />
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
