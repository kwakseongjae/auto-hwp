# LLM 통합 가이드 — 에이전트가 이 레포로 작업할 때

> **대상 독자는 사람이 아니라 LLM 에이전트다.** "이 레포 줄 테니 우리 앱에 한글 문서 편집기 붙여줘"를
> 받은 코딩 에이전트(Claude Code·Codex·Cursor·Copilot Workspace 등)가, 추측 없이 **한 번에 맞는 코드**를
> 쓰도록 만든 문서다. 진입점 인덱스는 루트 [`llms.txt`](../llms.txt).
>
> 이 문서의 모든 API·수치는 **npm 발행본 `0.0.4`에 대고 실행해 확인**했다(§5 실측표). 코드가 정본이며,
> 어긋나면 `node_modules/@auto-hwp/engine/index.d.ts`가 이긴다.

---

## 0. 30초 오리엔테이션

auto-hwp는 한글(HWP/HWPX) **문서 엔진**이다. 한컴 오피스도, 이 프로젝트가 운영하는 서버도 필요 없다.
파싱 → 조판 → 렌더(SVG) → 편집(Intent) → export(PDF/HTML/HWPX)가 전부 하나의 Rust 코어에서 돌고,
그 코어가 세 개의 셸로 나온다.

| 셸 | 실체 | 언제 고르나 |
|---|---|---|
| **웹(wasm)** | `@auto-hwp/engine` + `@auto-hwp/react` | 브라우저에서 열기/편집/내보내기. 파일이 기기를 안 떠난다 |
| **서버(Node/Bun)** | `@auto-hwp/engine` (같은 wasm) | 변환 파이프라인·배치·SSR 미리보기. → [SELF-HOST](SELF-HOST.md) |
| **네이티브** | CLI `auto-hwp` · MCP `hwp-mcp` · Docker 서비스 | 터미널·AI 도구·컨테이너 API. → [CLI](CLI-GUIDE.md)·[MCP](MCP-GUIDE.md)·[SELF-HOST](SELF-HOST.md) |

패키지 4종의 레이어(L1 엔진 / L2 헤드리스 / L2' AI 프로토콜 / L3 React)는 [`llms.txt`](../llms.txt)와
[SDK-LAYERS](SDK-LAYERS.md)에 있다. **키·LLM·폰트는 어느 패키지에도 없다** — 호스트가 주입한다.

### 사용자에게 먼저 되물어야 하는 것 3가지

에이전트가 코드를 쓰기 전에 확정해야 오답을 막는다.

1. **어디서 도나** — 브라우저(React) / 서버(Node·Bun) / 컨테이너(Docker) / 터미널(CLI)?
2. **편집이 필요한가, 보기·변환만인가** — 편집이면 [INTENT-SCHEMA](INTENT-SCHEMA.md)를 읽어야 하고
   AI 편집이면 **호스트 쪽 프록시 서버**가 반드시 필요하다(§1-C).
3. **폰트를 무엇으로 임베드하나** — PDF는 폰트를 주입하지 않으면 **에러로 거부**한다(조용히 빈 글리프를
   내지 않는다). 재배포 가능한 서체(OFL)만 쓸 수 있다 → [LICENSE-POLICY](LICENSE-POLICY.md).

---

## 1. 과업별 레시피

각 레시피는 **① 읽을 문서 → ② 설치 → ③ 최소 코드 → ④ 검증 커맨드** 순서다. 그 순서대로 하면 된다.

### A. React 앱에 한글 편집기 임베드

**① 읽을 문서** — [EMBED-GUIDE](EMBED-GUIDE.md) 전문(§2 wasm 로딩 / §3 마운트·sidePanel / §4 CSP /
§6 폰트). 편집 커맨드를 직접 만들 거면 [INTENT-SCHEMA](INTENT-SCHEMA.md)도.

**② 설치**

```bash
npm i @auto-hwp/react          # @auto-hwp/engine · @auto-hwp/editor-core 가 함께 설치된다
npm i @auto-hwp/ai-protocol    # AI(바이브) 편집을 붙일 때만 — 서버 프록시와 공유하는 모듈
```

**③ 최소 코드** (브라우저 전용 컴포넌트로 격리할 것 — §2 함정 3)

```tsx
"use client";                       // RSC 프레임워크라면 호스트가 이 경계를 친다(패키지엔 없다)
import { useMemo, useState } from "react";
import { HwpWorkspace, WasmAdapter, workspacePanel } from "@auto-hwp/react";
import "@auto-hwp/react/styles.css"; // ← 빼먹으면 스타일이 통째로 빠진다

export default function Editor() {
  const adapter = useMemo(() => new WasmAdapter(), []);      // 인자 없음 = 자기 버전 pin CDN(jsDelivr)
  const [doc, setDoc] = useState<{ bytes: Uint8Array; name: string } | null>(null);

  return (
    <div style={{ height: "100vh" }}>
      <input type="file" accept=".hwp,.hwpx" onChange={async (e) => {
        const f = e.currentTarget.files?.[0];
        if (f) setDoc({ bytes: new Uint8Array(await f.arrayBuffer()), name: f.name });
      }} />
      <HwpWorkspace
        adapter={adapter}
        document={doc}
        enableEditing
        onAiRequest={askAi}                              // §1-C. AI 없으면 () => []
        sidePanel={workspacePanel({ onAiRequest: askAi })} // 생략하면 패널 없는 순수 에디터
        defaultFont={{ family: "Nanum Gothic", bytes: fontBytes }} // PDF를 낼 거면 필수
      />
    </div>
  );
}
```

`HwpWorkspaceProps`의 전체 필드(실제 시그니처):
`adapter`(필수) · `document` · `onAiRequest`(필수) · `sidePanel` · `enableEditing` · `defaultFont` ·
`fontCatalog` · `fontUrlBase` · `requestFont` · `injectSerifSubstitute` · `preferEngineCaretEditing` ·
`formatSurface`(`"ribbon"|"inspector"`) · `onExport` · `onOpenFile` · `messages` · `brand` · `className`.
정의: [`packages/react/src/components/HwpWorkspace.tsx`](../packages/react/src/components/HwpWorkspace.tsx).

**④ 검증**

```bash
# 1) 타입이 실제로 맞는가
npx tsc --noEmit

# 2) 개발 서버에서 실제 문서를 열어본다 (SSR 프레임워크면 반드시 ssr:false 로 감싼 뒤)
npm run dev

# 3) 레퍼런스 앱으로 대조 — 발행본을 설치해 도는 최소 Vite 앱 + Playwright 스모크
cd examples/vite-embed && npm install && npm run test:e2e
#    업로드 → 8쪽 SVG 렌더 → 셀 마킹 → mock 편집 → undo 까지 완주하면 배선이 옳다
```

브라우저 콘솔에서의 즉석 확인은 §4 스모크 코드.

---

### B. 엔진만으로 변환 파이프라인 (`.hwp`/`.hwpx` → SVG·PDF·HTML·HWPX)

React가 필요 없다. `@auto-hwp/engine` 하나면 **Node·Bun·브라우저 어디서든** 같은 코드가 돈다.

**① 읽을 문서** — [SELF-HOST §3](SELF-HOST.md)(Node/Bun 실행 패턴·실측) → 필요하면
[EMBED-GUIDE §2](EMBED-GUIDE.md)(브라우저 wasm 로딩).

**② 설치**

```bash
npm i @auto-hwp/engine
```

**③ 최소 코드 (Node/Bun — 실행 검증됨, §5)**

```js
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { initEngine, HwpDoc } from "@auto-hwp/engine";

const require = createRequire(import.meta.url);
// Node에서는 CDN URL이 아니라 로컬 wasm '바이트'를 넘기는 것이 정답이다(§2 함정 12).
await initEngine(await readFile(require.resolve("@auto-hwp/engine/pkg/hwp_wasm_bg.wasm")));

const doc = HwpDoc.open(new Uint8Array(await readFile("문서.hwp")), "문서.hwp");
const svgs = Array.from({ length: doc.pageCount() }, (_, i) => doc.renderPageSvg(i));

doc.registerFont("Nanum Gothic", new Uint8Array(await readFile("NanumGothic-Regular.ttf")));
// ⚠ registerFont 는 재조판을 유발한다 — 쪽수/렌더를 여기서 다시 질의해야 한다(§2 함정 6)
const pdf = doc.exportPdf();          // Uint8Array
const html = doc.exportHtml();        // string (자체 완결)
const hwpx = doc.toHwpx();            // Uint8Array (편집 안 한 영역은 바이트 보존)
doc.free();
```

**④ 검증**

```bash
node convert.mjs 문서.hwp
# 기대: PDF 매직 "%PDF-", HWPX 매직 "PK", SVG가 "<svg" 로 시작
# 쪽수 대조가 필요하면 이 레포의 게이트 문서와 맞춰본다: benchmarks/benchmark.hwp → 8쪽
```

CLI로 같은 일을 하고 싶다면(설치가 cargo면 되는 환경) → [CLI-GUIDE](CLI-GUIDE.md)의
`auto-hwp export-pdf` / `export-html` / `own-render`. 같은 엔진, 같은 결과.

---

### C. AI(바이브) 편집 프록시 구축 — BYOK

**핵심 계약: 이 레포의 어떤 패키지도 API 키를 보지 않는다(R6).** 브라우저는 지시문과 문서 컨텍스트를
**당신의 서버**로 보내고, 서버가 LLM을 부르고, 서버가 **검증된 Intent 배열**을 돌려준다. 프롬프트·펜스·
검증은 `@auto-hwp/ai-protocol`이 소유하며 **서버와 클라이언트가 같은 모듈을 import**한다.

**① 읽을 문서** — [`examples/ai-proxy-express/README.md`](../examples/ai-proxy-express/README.md) →
[INTENT-SCHEMA](INTENT-SCHEMA.md)(무엇을 생성해도 되는지) → [EMBED-GUIDE §5](EMBED-GUIDE.md).

**② 설치**

```bash
npm i @auto-hwp/ai-protocol        # 서버·클라 양쪽
```

**③ 최소 코드**

```ts
// ── 클라이언트 (브라우저) ────────────────────────────────────────────────
import { buildDocContext } from "@auto-hwp/ai-protocol";

const askAi: HwpWorkspaceProps["onAiRequest"] = async (instruction, anchors, ctx) => {
  const res = await fetch("/api/hwp-edit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ instruction, anchors, docContext: buildDocContext(ctx, anchors) }),
  });
  return (await res.json()).intents ?? [];   // 반드시 Intent[] 를 돌려준다
};

// ── 서버 (Express/Next route/Lambda — 어디든) ──────────────────────────
import { buildSystemPrompt, validateRequest, validateResponse } from "@auto-hwp/ai-protocol";

app.post("/api/hwp-edit", async (req, res) => {
  const check = validateRequest(req.body);              // 구조·한도 검사(화이트리스트)
  if (!check.ok) return res.status(400).json({ error: check.error });

  const raw = await callYourLlm({                        // ← 벤더는 당신 것. 키는 여기에만 있다
    system: buildSystemPrompt(),                         // INTENT-SCHEMA 발췌 + 허용 Intent 부분집합
    user: check.value.instruction,
    context: check.value.docContext,                     // R5: <document-content> 펜스로 감싸인 데이터
  });
  res.json({ intents: validateResponse(raw) });          // 화이트리스트 밖 Intent는 여기서 탈락
});
```

**④ 검증** — 키 없이도 전체 플로우가 완주하는 mock 모드가 있다.

```bash
cd examples/ai-proxy-express && npm install && node server.mjs       # 키 없으면 mock
curl localhost:8787/api/hwp-edit                                     # → {"mode":"mock"}
curl -X POST localhost:8787/api/hwp-edit -H 'content-type: application/json' \
  -d '{"instruction":"이 칸을 채워줘","anchors":[{"kind":"cell","section":0,"block":1,"rows":[0,0],"cols":[0,0]}],"docContext":"<document-content>x</document-content>"}'
# → {"intents":[{"intent":"SetTableCell",...}],"mode":"mock"}
```

> **에이전트가 사용자에게 반드시 고지할 것:** 이 경로에서는 지시문과 **문서 컨텍스트(프로필·본문 발췌·표
> 문맥)가 외부 LLM으로 전송된다.** 파일 원본이 가는 것은 아니지만, 나머지 전 과정(열기·조판·렌더·적용)이
> 로컬인 것과 대비되는 유일한 예외다. 동의 UI 없이 조용히 붙이지 마라.

---

### D. 양식 일괄 작성 (양식 1개 + 명단 N행 → 완성본 N부)

**LLM 호출이 0회인 규칙 기반 경로다.** 에이전트가 이걸 AI 편집(§C)으로 구현하려 들면 오답이다.

**① 읽을 문서** — [BULK-GUIDE](BULK-GUIDE.md)(웹 5단계 퍼널 / CLI `inspect`→검수→`fill`).

**② 설치** — 웹은 설치 0(라이브: https://kwakseongjae.github.io/auto-hwp/bulk ). 자동화는 CLI:

```bash
cargo install --git https://github.com/kwakseongjae/auto-hwp auto-hwp-cli --features rhwp,shaper,pdf
```

**③ 최소 절차**

```bash
auto-hwp inspect 양식.hwpx --out fill-map.json      # 라벨→값칸 초안 유도(autohwp.fillmap.v1)
$EDITOR fill-map.json                               # 사람이 검수 — 이 단계를 건너뛰지 마라
auto-hwp fill 양식.hwpx --map fill-map.json --data 명단.csv --out 결과/
```

**④ 검증** — `결과/report.json`의 `rows[].needsReview`가 전부 `false`인지 본다(사유는 `rows[].reasons` —
`unpinned:<키>` · `apply_failed:<키>:<사유>` · `value_not_found:<값>` · `overflow:pages_<실제>_vs_<기준선>`).
**명단의 열 이름과 fill-map의 필드 이름이 일치해야 값이 들어간다** — 어긋나면 조용한 빈칸이 아니라
리포트에 남는다. (배치 전체의 이름 대조 코드 `unmatched_column` / `unmatched_field`를 `warnings`에 담는
것은 **웹 퍼널의 `report.json`**이다 — CLI 리포트에는 그 키가 없다. 사유코드 전표는
[BULK-GUIDE](BULK-GUIDE.md).) 웹 규격 파일과 CLI `--map`은 **같은 포맷**이라 웹에서 잡고 CLI로 돌려도 된다.

---

### E. (보너스) 사용자의 AI 도구에 상시 장착

사용자가 "내 Claude/Cursor가 한글 파일을 직접 다루게 해줘"라고 하면 웹 임베드가 아니라 **로컬 MCP 서버**다.

```bash
cargo install --git https://github.com/kwakseongjae/auto-hwp hwp-mcp --features rhwp
claude mcp add auto-hwp -- hwp-mcp
```

툴 15종·전송 모드·정직 고지는 [MCP-GUIDE](MCP-GUIDE.md). 컨테이너로 띄우는 네트워크 모드는
[SELF-HOST §2](SELF-HOST.md).

---

## 2. 함정 목록 — 에이전트가 실제로 틀리는 것들

기존 문서·코드에서 추출했고, 번호 옆 ✔은 이번에 0.0.4로 **재현 확인**한 항목이다.

1. **버전 pin은 협상 대상이 아니다 — `@latest` 금지.** wasm-bindgen 글루(JS)와 `.wasm` 바이너리는 함께
   컴파일된 **한 벌**이다. 버전이 어긋나면 링크 실패하거나, 더 나쁘게는 링크된 뒤 신규 Intent를
   `unknown variant`로 거부한다. 기본 CDN은 **로딩을 수행하는 JS 자신의 버전**으로 pin된다
   (`ENGINE_VERSION`). 직접 URL을 쓴다면 반드시 설치된 버전과 같은 태그를 박아라.
2. ✔ **자기 호스팅은 파일 5개 + 상대구조 보존.** `hwp_wasm_bg.wasm`, `worker.js`, `index.js`,
   `cdn.js`, `pkg/hwp_wasm.js`. wasm 바이너리의 위치는 자유(명시 URL로 fetch)지만
   `worker.js → ./index.js → ./cdn.js` + `./pkg/hwp_wasm.js`의 상대 import 체인은 그대로 살아 있어야
   한다. **`cdn.js`를 빼면 워커가 404로 즉사한다**(0.0.2 시절 4파일 레시피를 그대로 옮기는 것이
   대표적 오답). → [EMBED-GUIDE §2.2](EMBED-GUIDE.md) · [SELF-HOST §4](SELF-HOST.md)
3. **SSR에서 렌더하면 죽는다.** 엔진은 `WebAssembly`/`Worker`/DOM을 쓴다. Next면
   `dynamic(() => import("./Editor"), { ssr: false })`, 다른 SSR 프레임워크도 클라이언트 전용 마운트.
   패키지에는 `"use client"`가 **들어 있지 않다**(벤더 중립) — 경계는 **호스트가** 친다.
4. **`import "@auto-hwp/react/styles.css"` 를 빼먹지 마라.** CSS-in-JS가 아니다. 빼면 페이지·오버레이·
   툴바가 전부 무스타일로 나오고, 사용자는 "깨졌다"고 보고한다. 클래스는 `hw-*` 네임스페이스.
5. ✔ **Intent는 알 수 없는 필드를 조용히 무시하지 않는다(`deny_unknown_fields`).** 오타 하나가 하드
   에러다. 실측:

   ```text
   요청  { "intent": "SetParagraphRuns", "section": 0, "index": 1, "runs": [...] }
   결과  { code: "bad_intent" }
         unknown field `index`, expected one of `section`, `block`, `runs`
   ```

   **필드 이름을 기억으로 쓰지 말고 [INTENT-SCHEMA](INTENT-SCHEMA.md)에서 복사하라.**
   (같은 함정: `SetTableCellRuns`는 표 블록을 `index`로, `SetParagraphRuns`는 문단을 `block`으로 가리킨다.)
6. ✔ **텍스트 커밋은 `SetParagraphRuns` / `SetTableCellRuns`로.** 평문 variant(`SetParagraphText`,
   `SetTableCell` 텍스트 경로)는 run을 하나로 **붕괴**시켜 서식이 날아간다. 기존 서식을 살리려면
   `blockRuns(section, block[, row, col])`로 현재 run을 읽어 수정본을 되돌려준다.
7. ✔ **`registerFont`는 재조판을 유발한다 — 쪽수가 바뀐다.** 실측: `k-water-rfp.hwp` 31쪽 → 폰트 등록 후
   30쪽, `benchmark1.hwp` 19쪽 → 18쪽. 등록 뒤 **반드시** `pageCount()`를 다시 묻고 모든 페이지를
   다시 렌더하라. (`setNormalize(true)`도 같은 성질이다.)
8. ✔ **PDF는 폰트 없이 나오지 않는다.** `exportPdf()`는 `{code:"font_missing"}`으로 **거부**한다
   (조용한 빈 글리프 금지). 메시지: `exportPdf requires a font — call registerFont(family, bytes)`.
   그리고 **함초롬/한컴 계열은 재배포 라이선스가 없다** — OFL 서체만 서빙하라
   ([LICENSE-POLICY](LICENSE-POLICY.md)).
9. **렌더된 SVG는 문서에서 나온 신뢰불가 문자열이다.** 절대 raw `innerHTML` 하지 마라. `HwpPageView`는
   삽입 전에 항상 `sanitizeSvg`를 통과시킨다. 직접 그린다면 `sanitizeSvg`/`renderPageSvgSanitized`를 써라.
   ⚠ ✔ **Node에는 `DOMParser`가 없어 정규식 폴백으로 떨어진다**(약한 방어) — 서버에서 만든 SVG를
   브라우저로 보낸다면 **브라우저 쪽에서 한 번 더** `sanitizeSvg`를 통과시켜라(→ [SELF-HOST §3.4](SELF-HOST.md)).
10. **엄격 CSP에서 필요한 지시문.** `script-src 'self' 'wasm-unsafe-eval'` · `worker-src 'self' blob:`
    (CDN 워커는 동일 출처 blob 심을 쓴다) · `font-src 'self' data:` · `img-src 'self' data: blob:` ·
    `connect-src 'self' <AI 프록시 오리진>`. CDN 기본값을 쓰면 `script-src`/`connect-src`에
    `https://cdn.jsdelivr.net`을 더한다.
11. **`sidePanel`은 슬롯이지 제품이 아니다.** 생략하면 패널이 없고 그때 `onAiRequest`는 호출되지 않는다.
    `workspacePanel({...})`은 **데모 어포던스**(한국어 문구·카드 레이아웃이 전부 우리 것)다. 제품이라면
    `WorkspaceSidePanel` API에 자기 패널을 대고 그려라. 배치만 빌리려면 `presentation:
    "rail"|"bottom"|"modal"|"unstyled"`.
12. ✔ **Node에서는 CDN 기본값에 기대지 마라.** `initEngine()`을 인자 없이 부르면 네트워크에서 wasm을
    받는다. Node 24에서는 실제로 **동작하긴 하지만**(측정함), 서버 부팅이 CDN 가용성에 묶이는 것은
    나쁜 설계다. `require.resolve("@auto-hwp/engine/pkg/hwp_wasm_bg.wasm")`로 **로컬 바이트**를 넘겨라.
13. ✔ **`@auto-hwp/engine/worker-client`는 브라우저 전용이다.** Node/Bun에서 `new EngineWorkerClient()`는
    `Worker is not defined`로 실패한다(`node:worker_threads`와 다른 API다). 서버에서 격리가 필요하면
    워커가 아니라 **프로세스**를 나눠라.
14. ✔ **wasm 선형 메모리는 `free()` 후에도 OS로 돌아오지 않는다.** 측정: 초기화 후 79MB rss →
    문서 3개 동시 오픈 126MB → 전부 `free()` 후에도 128MB → 2.7MB짜리 문서를 30회 열고 닫은 뒤 224MB.
    `free()`는 **다음 문서가 재사용할 힙**을 돌려주는 것이지 프로세스 메모리를 줄이지 않는다.
    장수(長壽) 서버라면 N건마다 워커/프로세스를 재활용하라.
15. **좌표계 슬립.** 지오메트리 API(`hitTest`/`imageAt`/`tableCellAt`/`pageGeometry` …)는 **px**
    (= HWPUNIT/75)로 말하고, Intent(ops)는 **HWPUNIT**로 받는다. 변환은 한 지점
    (`@auto-hwp/editor-core`의 `units`)에서만 하라. 섞으면 클릭 선택·이동·리사이즈가 **조용히** 죽는다.
16. **wasm trap 회복 절차.** Rust 패닉은 인스턴스 전체를 오염시킨다. `isTrapError(e)`가 참이면
    `resetEngine()` 후 **문서를 다시 열어야** 한다(이전 핸들은 전부 죽는다). 워커 모드에서는
    `worker_dead`도 같은 취급, `worker_terminated`(의도적 종료)는 아니다.
17. **저장 포맷은 HWPX다.** `.hwp`로 되돌려 저장하는 경로는 없다. `.hwp`를 입력하면 산출물은 변환본이라
    쪽 나눔·표 너비가 원본과 달라질 수 있다(HWPX 입력은 고치지 않은 영역이 바이트 그대로 보존된다).
    암호(password) `.hwp`는 **열지 못한다**(정직 거부). PDF의 수식·차트는 자리표시 상자다.
18. **`file:` 의존을 그대로 복사하지 마라.** 이 레포 안의 `packages/*`·`examples/*`는 모노레포라
    `"@auto-hwp/engine": "file:../engine"` 같은 로컬 경로 의존이 섞여 있다. 외부 프로젝트로 옮길 때는
    **레지스트리 버전(`^0.0.4`)** 으로 바꿔야 한다(발행본 `@auto-hwp/react`는 이미
    `@auto-hwp/engine ^0.0.4` / `@auto-hwp/editor-core ^0.0.4`를 의존한다 — 확인함).

---

## 3. 무엇을 만들면 안 되는가 (에이전트가 자주 지어내는 것)

- **`.hwp`로 저장하는 API** — 없다. 만들지 마라.
- **번들된 한글 폰트** — 없다(라이선스). `defaultFont`/`registerFont`로 주입한다.
- **프로젝트가 운영하는 변환 API 엔드포인트** — 없다. 셀프호스팅뿐이다(→ [SELF-HOST](SELF-HOST.md)).
- **자유 2D 오프셋 이동** — 이미지/블록 이동은 **앵커 재배열**이다. 픽셀 좌표를 자유롭게 주는 UI를
  흉내내면 커밋과 화면이 어긋난다.
- **Intent 스키마 임의 확장** — v0는 동결이며 확장은 additive만, 미지 필드는 명시적 거부다.

---

## 4. 설치 후 스모크 — 붙여넣어 바로 돌리는 코드

### 4.1 Node/Bun (이 레포에서 실행 검증)

```js
// smoke.mjs  —  node smoke.mjs 문서.hwpx   /   bun smoke.mjs 문서.hwpx
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { initEngine, HwpDoc, ENGINE_VERSION } from "@auto-hwp/engine";

const require = createRequire(import.meta.url);
console.log("engine", ENGINE_VERSION);
await initEngine(await readFile(require.resolve("@auto-hwp/engine/pkg/hwp_wasm_bg.wasm")));

const doc = HwpDoc.open(new Uint8Array(await readFile(process.argv[2])), "smoke");
console.log("pages", doc.pageCount());
console.log("svg0 bytes", doc.renderPageSvg(0).length);
console.log("profile", doc.docProfile().title, doc.docProfile().table_count, "tables");
try { doc.exportPdf(); } catch (e) { console.log("no-font guard →", e.code); }  // font_missing 이어야 정상
doc.free();
```

기대 출력: `engine 0.0.4` / `pages` ≥ 1 / `svg0 bytes` > 0 / `no-font guard → font_missing`.
어느 한 줄이라도 다르면 **배선이 틀린 것이지 문서가 틀린 게 아니다** — §2 함정 1·2·12를 다시 보라.

### 4.2 브라우저 (콘솔/스크래치 페이지)

```html
<script type="module">
  import { initEngine, HwpDoc, sanitizeSvg } from "https://cdn.jsdelivr.net/npm/@auto-hwp/engine@0.0.4/index.js";
  await initEngine();                       // 인자 없음 = 같은 버전의 wasm을 자동으로
  const bytes = new Uint8Array(await (await fetch("./sample.hwpx")).arrayBuffer());
  const doc = HwpDoc.open(bytes, "sample.hwpx");
  document.body.innerHTML = sanitizeSvg(doc.renderPageSvg(0));   // 절대 raw 삽입 금지
  console.log("pages", doc.pageCount());
</script>
```

### 4.3 컨테이너 API

→ [SELF-HOST §2.4](SELF-HOST.md)의 curl 3콜(`open_document` → `apply_content` → `export_hwpx`).

---

## 5. 실측 기준선 (2026-08-05, npm `0.0.4`, macOS arm64 / Node v24.14.0)

에이전트가 "이 정도면 정상인가"를 판단할 기준. 재현 방법은 §4.1 + 반복 루프.

| 항목 | 실측값 |
|---|---|
| `@auto-hwp/engine@0.0.4` 언팩 크기 / 파일 수 | 8,378,694 B / 14개 |
| `pkg/hwp_wasm_bg.wasm` (비압축) | 7,725,936 B |
| `initEngine(bytes)` (로컬 바이트, 캐시 없음) | 23 ms |
| `benchmark.hwp` (67 KB) → open / 8쪽 SVG / PDF | 14 ms / 1 ms(465 KB) / 61 ms(92 KB) |
| `benchmark1.hwp` (280 KB) → open / 19쪽 SVG / PDF | 10 ms / 3 ms(2.4 MB) / 164 ms(365 KB) |
| `k-water-rfp.hwp` (2.7 MB) → open / 31쪽 SVG / PDF | 67 ms / 33 ms(26 MB) / 260 ms(2.0 MB) |
| 폰트 등록 후 쪽수 변화 | 19→18 · 31→30 (§2 함정 7) |
| 프로세스 rss: init 후 / 문서 3개 / free 후 / 30회 반복 후 | 79 → 126 → 128 → 224 MB (§2 함정 14) |
| Bun 1.3.8에서 §4.1 스모크 | Node와 **동일 출력** |

> 쪽수 게이트(`benchmark.hwp` 8쪽 등)는 **벤치마크 문서 기준**이지 임의 문서의 완전 일치 보증이 아니다.
> 충실도의 정직한 범위는 [FIDELITY](FIDELITY.md)·[BENCHMARK](BENCHMARK.md)를 보고 사용자에게 그대로 전하라.

---

## 6. 다음 문서

- 웹 임베드 정본 → [EMBED-GUIDE](EMBED-GUIDE.md) (영문 임계경로: [EMBED-GUIDE.en](EMBED-GUIDE.en.md))
- 편집 명령 스펙 → [INTENT-SCHEMA](INTENT-SCHEMA.md)
- Docker·Node/Bun 셀프호스팅 → [SELF-HOST](SELF-HOST.md)
- 터미널 / AI 도구 → [CLI-GUIDE](CLI-GUIDE.md) · [MCP-GUIDE](MCP-GUIDE.md)
- 양식 N부 → [BULK-GUIDE](BULK-GUIDE.md)
- 이 레포의 **코드를 고칠 때** → [AGENTS.md](../AGENTS.md)(불변식·게이트) · [CONTRIBUTING](../CONTRIBUTING.md)
