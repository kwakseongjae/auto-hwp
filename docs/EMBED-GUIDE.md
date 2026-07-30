# auto-hwp 웹 임베드 가이드 (비-Next 호스트 · npm 발행본)

> English: [`EMBED-GUIDE.en.md`](EMBED-GUIDE.en.md) (임계 경로 전문 번역).

> 대상: **Next 가 아닌 임의 호스트**(Vite/CRA/SvelteKit 정적/S3+CloudFront 등)에서 `npm i @auto-hwp/react
> @auto-hwp/engine` 으로 hwp 뷰어/에디터를 자기 페이지에 심으려는 개발자. Next.js 통합은
> [`INTEGRATION-HANDOVER.md`](INTEGRATION-HANDOVER.md)(참조 앱 `apps/hwp-lab`)를 보라 — 이 문서는 그
> Next 편중을 보완하는 **프레임워크 독립** 절이다.
>
> 실동작 예제(이 레포에서 실검증):
> - [`examples/vite-embed`](../examples/vite-embed) — **published tarball 을 설치**해 `<HwpWorkspace/>` 를
>   렌더하는 최소 Vite 앱 + Playwright 스모크(업로드→8쪽 렌더→셀 마킹→mock 편집→undo).
> - [`examples/ai-proxy-express`](../examples/ai-proxy-express) — 정적/비-Next 호스트용 얇은 AI 프록시(Express).

---

## 1. 설치 — 4개 패키지

```bash
npm i @auto-hwp/react @auto-hwp/engine @auto-hwp/editor-core @auto-hwp/ai-protocol
```

| 패키지 | 레이어 | 역할 |
|---|---|---|
| `@auto-hwp/engine` | L1 (wasm) | 파싱·조판(px)·렌더(SVG 문자열)·Intent 적용·undo·export. 폰트/LLM/키 0. |
| `@auto-hwp/editor-core` | L2 (headless) | DocSession·SelectionModel·EditController. React·DOM 0. |
| `@auto-hwp/ai-protocol` | L2' (isomorphic) | EditRequest/Response·buildDocContext(R5 펜스)·validate\*. fetch·키 0. 서버·클라 공유. |
| `@auto-hwp/react` | L3 (UI) | `<HwpWorkspace/>` + 오버레이·채팅. 전부 교체 가능. `peerDependencies`: react/react-dom ≥18. |

`@auto-hwp/react` 는 `@auto-hwp/engine`·`@auto-hwp/editor-core` 를 실버전(`^0.0.2`)으로 의존한다(모노레포
`file:` 아님 — 발행본은 레지스트리에서 정상 해석된다). `@auto-hwp/ai-protocol` 은 서버 프록시에서도 쓰므로
독립 설치한다.

---

## 2. wasm / 워커 로딩 — 기본값은 CDN, 자기 호스팅은 오버라이드

> ⚠️ **버전 주의(2026-07-30):** 이 절의 **CDN 기본값·`onProgress`·`prefetch()` 는 다음 발행(0.0.3)부터**
> 실린다. 현재 레지스트리 실물은 `0.0.2` 이며 거기서는 §2.2 의 **명시 URL(4파일 복사)** 만 동작한다.
> 아래 §2.1 코드는 0.0.3 이후 기준이고, `examples/vite-embed` 는 아직 0.0.2 기준(명시 URL)이다.

### 2.1 기본값 — 아무것도 복사하지 않는다

`WasmAdapter` 에 URL 을 주지 않으면 엔진은 **자기 패키지 버전으로 pin 된 jsDelivr** 에서 wasm/워커를 받는다:

```
https://cdn.jsdelivr.net/npm/@auto-hwp/engine@<설치된 버전>/pkg/hwp_wasm_bg.wasm
https://cdn.jsdelivr.net/npm/@auto-hwp/engine@<설치된 버전>/worker.js
```

```tsx
const adapter = new WasmAdapter();                 // 메인스레드 엔진 + CDN wasm
const adapter = new WasmAdapter(undefined, { worker: {} });  // 워커 엔진 + CDN worker.js/wasm
```

- **`@latest` 는 절대 쓰지 않는다.** wasm-bindgen 글루(JS)와 wasm 바이너리는 함께 컴파일된 **한 벌**이라
  버전이 어긋나면 링크에 실패하거나, 더 나쁘게는 링크된 뒤 신규 Intent 를 `unknown variant` 로 거부한다
  (이 레포의 "스테일 wasm 함정"을 제도화하는 셈). 그래서 pin 은 **로딩을 수행하는 JS 자신의 버전**이다
  (`ENGINE_VERSION`, `packages/engine/cdn.js` — 발행 훅이 package.json 과 하드 게이트로 대조).
- 교차 출처 **워커 스크립트**는 `new Worker(url)` 에 그대로 못 넘긴다(동일 출처 정책) → 클라이언트가
  같은 출처의 **blob 심**(`import "<cdn>/worker.js"`)으로 감싼다. 엄격 CSP 라면 `worker-src blob:` 필요(§4).
- 오프라인/내부망·CDN 차단 환경은 §2.2 로 간다. **CDN 은 기본값일 뿐, 요구사항이 아니다.**

실측(2026-07-30, `@auto-hwp/engine@0.0.2`):

| 항목 | 값 |
|---|---|
| jsDelivr `content-type` / CORS | `application/wasm` / `access-control-allow-origin: *`, `expose-headers: *` |
| 전송 크기 (brotli) | **2,962,776 B** (≈2.96 MB) |
| 비압축 크기 | **7,718,539 B** (≈7.72 MB) |
| GitHub Pages 자기 호스팅 (gzip) | 3,145,131 B / Vite 빌드 리포트 gzip 3,151,674 B |

### 2.2 오버라이드 — 자기 호스팅(정적 파일 복사)

CDN 을 못 쓰거나(폐쇄망·CSP·규정) 버전을 직접 고정하고 싶으면 **명시 URL** 을 준다. 그때만 발행본
(`node_modules/@auto-hwp/engine`)에서 아래 파일들을 **상대구조 그대로** 정적 루트로 복사한다
(`examples/vite-embed/scripts/copy-assets.mjs` 가 그 스크립트다):

```
public/hwp/hwp_wasm_bg.wasm      ← node_modules/@auto-hwp/engine/pkg/hwp_wasm_bg.wasm  (런타임에 URL fetch)
public/hwp/worker.js             ← node_modules/@auto-hwp/engine/worker.js             (모듈 워커 엔트리)
public/hwp/index.js              ← node_modules/@auto-hwp/engine/index.js              (worker.js 가 import)
public/hwp/cdn.js                ← node_modules/@auto-hwp/engine/cdn.js                (0.0.3~ — index.js 가 import)
public/hwp/pkg/hwp_wasm.js       ← node_modules/@auto-hwp/engine/pkg/hwp_wasm.js       (wasm-bindgen 글루)
```

> ⚠️ **0.0.3~ 는 `cdn.js` 가 필수다.** `index.js` 가 `./cdn.js` 를 import 하므로 빠지면 워커가 모듈
> 로드 404 로 즉사한다(0.0.2 에는 이 파일이 없으니 4파일 그대로다).

> `worker.js → ./index.js → ./pkg/hwp_wasm.js` 의 **상대 import 체인**이 `public/hwp/` 안에서 그대로
> 성립하도록 디렉토리 구조를 보존해 복사해야 한다. Vite 라면 `vite.config` 에 `optimizeDeps.exclude:
> ["@auto-hwp/engine"]` 를 두어 워커/글루가 esbuild 사전번들 대상이 되지 않게 한다(런타임 정적 로딩 대상).
>
> **Vite 프로덕션 빌드 사본 주의(무해):** `vite build` 는 엔진 글루의 기본 wasm 참조
> (`new URL('..._bg.wasm', import.meta.url)`)를 정적 에셋으로 **한 번 더** 방출한다
> (`dist/assets/hwp_wasm_bg-*.wasm`, ~8.1MB). 런타임엔 `WasmAdapter` 가 넘긴 `public/hwp` 의 명시적 URL 만
> fetch 되므로 이 사본은 **로드되지 않는다**(정상 동작). 배포 크기를 줄이려면 빌드 후 `dist/assets/*.wasm`
> 를 삭제하거나, 글루의 `import.meta.url` 자산화를 끄는 rollup 플러그인을 붙이면 된다(선택 — 게이트 아님).

빌드/개발 시 자동 복사(예제의 훅):

```jsonc
"predev":   "node scripts/copy-assets.mjs",
"prebuild": "node scripts/copy-assets.mjs",
```

번들러에게 wasm 을 자산으로 방출시키고 싶다면(복사 스크립트 없이) Vite 기준 한 줄이면 된다:

```ts
import wasmUrl from "@auto-hwp/engine/pkg/hwp_wasm_bg.wasm?url";
const adapter = new WasmAdapter(wasmUrl);   // 워커를 쓰려면 worker.js 는 여전히 정적 서빙 필요
```

### 2.3 진행률 + 프리페치 (0.0.3~)

wasm 은 비압축 ~7.7MB(압축 전송 ~3.0MB)라 첫 로드가 눈에 띈다. 어댑터가 두 가지를 준다:

```tsx
const adapter = new WasmAdapter(undefined, {
  onProgress: (p) => setPct(p.ratio == null ? null : Math.round(p.ratio * 100)),
});

// 랜딩에서 유휴에 미리 받아 둔다 → 사용자가 파일을 고르는 순간 대기 0
useEffect(() => { requestIdleCallback(() => void adapter.prefetch()); }, [adapter]);
```

- `onProgress` 는 **다운로드**만 측정한다(그 뒤의 wasm 컴파일은 측정 지점이 없다). 틱은
  `{loaded, total, ratio, done, estimated, url}`.
- ⚠️ **`estimated` 의 의미**: 응답이 brotli/gzip 이면 `Content-Length` 는 **압축 바이트**인데
  `response.body` 는 **비압축 바이트**를 흘린다 — 그대로 나누면 200% 가 된다. 그래서 압축 응답에서는
  발행 크기(`WASM_BYTES`)를 분모로 쓰고 `estimated:true` 를 세우며, 스트림이 실제로 끝나기 전에는
  절대 100% 를 표시하지 않는다. 자기 빌드를 자기 호스팅한다면 `expectedBytes` 로 분모를 직접 준다.
- `prefetch()` 는 실패를 삼키고 `false` 를 돌려준다(예열이 앱을 깨면 안 된다 — 진짜 오류는 실제 열기에서 난다).
- 워커 모드에서도 같은 콜백이 온다(워커 안에서 측정해 id 없는 `{progress}` 메시지로 올려보낸다).

### 2.4 아직 안 되는 것 (백로그)

- **Cloudflare Workers / 엣지 런타임**: 그쪽은 `fetch`+`instantiateStreaming` 대신 **번들에 박힌
  `WebAssembly.Module` 을 주입**하는 초기화가 필요하다. 지금은 `initEngineSync(module)` 로 수동
  배선해야 하고, 전용 진입점(`@auto-hwp/engine/edge` 류)은 **후속 작업**이다(W6.1 스코프 밖).
- CDN 기본값은 **브라우저 전용**이다(Node 에서는 URL 대신 바이트/모듈을 넘긴다).

---

## 3. 마운트 — `<HwpWorkspace/>`

```tsx
import { HwpWorkspace, WasmAdapter } from "@auto-hwp/react";
import "@auto-hwp/react/styles.css";               // ← 스타일은 수동 import (사이드이펙트 CSS)

// 0.0.3~ : 인자 없이 = CDN 기본값(§2.1). 자기 호스팅이면 아래처럼 명시 URL 을 준다(§2.2).
const adapter = new WasmAdapter(
  new URL("/hwp/hwp_wasm_bg.wasm", window.location.origin),
  { worker: { url: new URL("/hwp/worker.js", window.location.origin) } },
);

<HwpWorkspace
  adapter={adapter}
  document={{ bytes, name: "plan.hwpx" }}   // 업로드/드롭으로 얻은 Uint8Array
  onAiRequest={serverSideAi}                // R6 — 당신의 서버가 Intents 를 돌려준다(§5)
  defaultFont={{ family: "Nanum Gothic", bytes: fontBytes }}  // R8 — 폰트는 주입(§6)
  fontUrlBase="/fonts"
  enableEditing                             // 옵트인: 수동 편집 크롬(룰러/열너비/서식 툴바)
  sidePanel={(api) => <MyPanel {...api} />} // 오른쪽 패널은 호스트 것(아래 §3.1) — 생략하면 패널 없음
/>
```

전체 배선(파일 열기·프로브·폰트 fetch·mock AI)은 [`examples/vite-embed/src/App.tsx`](../examples/vite-embed/src/App.tsx) 참조.

### 3.1 `sidePanel` — 패널의 내용과 배치는 호스트가 조립한다

`HwpWorkspace` 는 **문서 표면만** 소유한다: 페이지·선택·오버레이·수동 편집. **채팅 뷰는 들어 있지 않다.**
패널은 슬롯이고, 호스트가 채팅·입력 폼·인스펙터를 넣거나 아무것도 안 넣는다. 슬롯 함수는
`WorkspaceSidePanel` 을 받는다 — 편집 표면 전체가 여기로 넘어오므로 워크스페이스 내부를 건드릴 일이 없다:

```tsx
sidePanel={(api) => (
  <MyPanel
    canEdit={api.canEdit}            // 문서가 열려 있고 편집 가능한가
    anchors={api.anchors}            // 사용자가 지정한 위치들([s/b] 주소 — docContext 와 동일 좌표)
    modLabel={api.modLabel}          // "⌘" / "Ctrl"
    onRemoveAnchor={api.removeAnchor}
    onClearAnchors={api.clearAnchors}
    docContext={api.docContext}      // AI 브릿지에 넘길 문서 컨텍스트(프로필+지정위치+표 그리드)
    onApply={api.apply}              // 검증된 Intent[] 적용 → 반영 개수
    onJumpToPage={api.jumpToPage}
    onRevealTarget={api.revealTarget}// 블록으로 스크롤 + 깜빡임("위치 보기")
    focusToken={api.focusToken}      // 증가하면 입력창에 포커스
    previewCards={api.previewCards}  // 적용 전 미리보기 보강
    onRevert={api.revert}            // 마지막 적용 묶음을 한 단위로 되돌리기
    undoDepth={api.undoDepth}
    selection={api.designSelection} // 종류·텍스트·페이지·X/Y/W/H·현재 서식
    onDesign={api.applyDesign}      // 선택 영역에 서식 delta 적용
    textEditing={api.textEditing}   // 엔진 캐럿 입력 중인지
  />
)}
```

정의: [`packages/react/src/components/HwpWorkspace.tsx`](../packages/react/src/components/HwpWorkspace.tsx) 의 `WorkspaceSidePanel`.

#### 기본 UI는 쓰되 배치만 바꾸기

참조 패널은 바이브 편집과 선택 디자인 인스펙터를 제공한다. 제품 셸을 처음부터 만들 필요 없이
`presentation`만 고를 수 있다:

```tsx
import { workspacePanel } from "@auto-hwp/react";

<HwpWorkspace
  {...props}
  sidePanel={workspacePanel({
    onAiRequest,
    presentation: "bottom", // "rail" | "bottom" | "modal" | "unstyled"
  })}
/>
```

`WorkspacePanel`을 직접 렌더하면 `tab`/`onTabChange`, `open`/`onOpenChange`를 앱 상태가 제어할 수 있다.
내용은 자기 것으로 유지하고 기본 배치만 빌리려면 `WorkspacePanelFrame` 안에 임의의 children을 넣는다.

#### 워크스페이스 밖에 마운트하기

`sidePanel`은 React 노드를 반환하는 일반 render prop이다. 따라서 portal을 쓰면 하단 앱 셸이나 전역 모달
루트처럼 워크스페이스 밖에도 같은 API를 연결할 수 있다:

```tsx
import { createPortal } from "react-dom";

sidePanel={(api) =>
  createPortal(<MyPanel api={api} />, document.querySelector("#product-tools")!)
}
```

우리 참조 패널을 그대로 쓰려면 `workspacePanel({ onAiRequest, notice })` 한 줄이면 된다
([`packages/react/src/chatSlot.tsx`](../packages/react/src/chatSlot.tsx)). 단 **그건 데모 어포던스지 제품
계약이 아니다** — 한국어 문구·카드 레이아웃·상호작용 모델이 전부 우리 것이다. 실제 제품은 자기 패널을
`WorkspaceSidePanel` 에 대고 그리고, 이 패키지에서는 편집 표면만 가져가는 쪽을 권한다.

### `styles.css` 는 수동 import

`@auto-hwp/react` 는 CSS-in-JS 가 아니다. `import "@auto-hwp/react/styles.css"` 를 **한 번** 넣어야 페이지/
오버레이/툴바가 스타일된다. 클래스는 네임스페이스드(`hw-*`)라 호스트 스타일과 충돌하지 않고 오버라이드도 자유다.
(`sidePanel` 에 넣는 패널은 당신 스타일이다 — 참조 채팅 `chatSidePanel` 을 쓸 때만 이 CSS 가 그 카드까지 그린다.)

### `"use client"` — 호스트가 클라이언트 경계를 친다

`@auto-hwp/react` 컴포넌트에는 `"use client"` 지시어가 **들어 있지 않다**(벤더 중립 — RSC 가 아닌 번들러도
많다). React Server Components 프레임워크(Next App Router 등)에서 쓸 땐 **호스트가** 워크스페이스를 감싸는
파일 맨 위에 `"use client"` 를 두거나 `dynamic(() => import(...), { ssr: false })` 로 클라이언트 전용
로드한다. 브라우저 전용(wasm/Web Worker/DOM)이므로 **SSR 은 반드시 끈다.**

### SSR 프레임워크: `ssr: false`

엔진은 `window`/`Worker`/`WebAssembly` 를 쓴다. 서버에서 렌더하면 죽는다. Next 라면
`dynamic(() => import("./Workspace"), { ssr: false })`, 다른 SSR 프레임워크도 클라이언트 전용 마운트로 감싼다.

---

## 4. CSP 헤더 (교차 출처/보안 호스트)

wasm 인스턴스화와 모듈 워커 때문에 CSP 를 쓰는 호스트는 아래를 허용해야 한다:

```
script-src 'self' 'wasm-unsafe-eval';   # WebAssembly.instantiate (구형 브라우저 대응 시 'unsafe-eval')
worker-src 'self' blob:;                # 모듈 워커 (CDN 기본값은 blob 심을 쓰므로 blob: 필수)
font-src   'self' data:;                # 주입 폰트 @font-face
img-src    'self' data: blob:;          # 이미지 삽입/미리보기
connect-src 'self' <AI 프록시 오리진>;   # onAiRequest 가 POST 하는 서버
```

**CDN 기본값(§2.1)을 쓴다면** 두 줄을 더 연다 — 자기 호스팅(§2.2)이면 필요 없다:

```
script-src  ... https://cdn.jsdelivr.net;   # 워커가 import 하는 index.js / pkg/hwp_wasm.js
connect-src ... https://cdn.jsdelivr.net;   # wasm fetch
```

SVG 는 문서 파생 **신뢰불가 문자열**이다 — L3 `HwpPageView` 가 삽입 전 항상 `sanitizeSvg`(R7) 를
통과시킨다(`<script>`/`on*`/`javascript:` 제거). 직접 렌더하더라도 `sanitizeSvg` export 를 반드시 거쳐라.

---

## 5. AI 프록시 (R6 — 키는 서버 전용)

`@auto-hwp/react` 는 LLM/키를 갖지 않는다. `onAiRequest(instruction, anchors, ctx)` 가 **당신의 서버**로
위임한다. 서버는 `@auto-hwp/ai-protocol`(서버·클라 동일 모듈)로 프롬프트/펜스/검증을 조립한다. 정적/비-Next
호스트용 얇은 서버 템플릿: [`examples/ai-proxy-express`](../examples/ai-proxy-express)(Express). 벤더 교체는
`liveIntents` 의 `import("@anthropic-ai/sdk")` 한 줄. 키 없으면 결정적 **mock** 으로 전체 플로우가 완주된다.

```ts
const onAiRequest = async (instruction, anchors, ctx) => {
  const res = await fetch("/api/hwp-edit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ instruction, anchors, docContext: buildDocContext(ctx, anchors) }),
  });
  return (await res.json()).intents ?? [];
};
```

---

## 6. 폰트 (R8 — 번들이 아니라 주입)

`@auto-hwp/engine` 은 폰트를 하나도 번들하지 않는다. 호스트가 `defaultFont={{ family, bytes }}` 로 **한 벌의
바이트**를 넣으면 ① 조판 메트릭 ② PDF 임베드 ③ 화면 `@font-face` 가 동시에 그 폰트로 맞춰진다. 미주입 상태의
PDF 는 `{code:"font_missing"}` 를 던진다(silent 빈 글리프 금지). **재배포 가능 폰트(OFL)만** 서빙하라 —
함초롬/한컴 계열은 재배포 라이선스가 없다([`docs/LICENSE-POLICY.md`](LICENSE-POLICY.md)).

**카탈로그 온디맨드 (2026-07-22):** `fontCatalog={FONT_CATALOG}` + `fontUrlBase` 를 주고 카탈로그
파일들(전부 OFL — Pretendard·Noto Sans/Serif KR 등 8종, `fetch-fonts.mjs`)을 정적 서빙하면, 리본
서체 피커/AI 가 카탈로그 family 를 지정할 때 워크스페이스가 자동으로 fetch→`registerFont`→화면
`@font-face` 까지 수행한다 — **그 서체가 화면과 PDF 에 실서체로 반영**된다(엔진의 explicit-family
bypass: 등록된 이름과 일치하는 명시 지정은 명조/고딕 대체를 우회, [`docs/FONT-CATALOG.md`](FONT-CATALOG.md)).
문서 고유 서체명(함초롬 등)은 종전대로 OFL 대체 렌더.

---

## 7. Next.js 특이사항 (참고)

- **Next 16 Turbopack 경고:** 참조 앱은 `next` 를 **15.5.x 로 고정**한다. 엔진 wasm 중복 방출을 막는 우회가
  `next.config.mjs` 의 **webpack 훅**(`parser.url=false` on `hwp_wasm.js`)에 있는데, Next 16 Turbopack 은 이
  `webpack()` 설정을 무시해 wasm 이 클라이언트 번들에 중복 방출될 수 있다. Next App Router 통합은
  [`INTEGRATION-HANDOVER.md §3`](INTEGRATION-HANDOVER.md) 참조.
- 비-Next(Vite 등)에서는 이 이슈가 없다 — wasm/워커를 애초에 public 정적 에셋으로 서빙하기 때문이다(§2).

---

## 8. 이식 검증 (이 레포에서 실검증)

예제의 의존은 **레지스트리 발행본이 기본**이다(외부 사용자와 같은 경로). 레포 로컬 빌드본으로 바꾸려면
`REPO_DEV=1` 만 붙인다 — `packages/*` 를 pack 해 `npm install --no-save` 로 얹으므로 `package.json` 선언은
레지스트리 그대로 남고 원복은 `npm install` 한 번이다.

```bash
cd examples/vite-embed
npm install              # 레지스트리 @auto-hwp/* ^0.0.2 (fresh clone 경로)
npm run dev              # predev 훅이 wasm/워커/폰트를 public/ 로 복사(0.0.2 = 명시 URL 경로)
npm run test:e2e         # Playwright: 업로드 → 8쪽 SVG → 셀 마킹 → mock 편집 → undo

REPO_DEV=1 npm run dev   # 미발행 변경(예: 0.0.3 CDN 기본값)을 이 예제에서 미리 확인
npm run use-local        # REPO_DEV 없이 강제로 로컬 tarball 얹기
```
