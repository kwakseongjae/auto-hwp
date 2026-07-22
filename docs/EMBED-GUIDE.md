# tf-hwp 웹 임베드 가이드 (비-Next 호스트 · npm 발행본)

> 대상: **Next 가 아닌 임의 호스트**(Vite/CRA/SvelteKit 정적/S3+CloudFront 등)에서 `npm i @tf-hwp/react
> @tf-hwp/engine` 으로 hwp 뷰어/에디터를 자기 페이지에 심으려는 개발자. Next.js 통합은
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
npm i @tf-hwp/react @tf-hwp/engine @tf-hwp/editor-core @tf-hwp/ai-protocol
```

| 패키지 | 레이어 | 역할 |
|---|---|---|
| `@tf-hwp/engine` | L1 (wasm) | 파싱·조판(px)·렌더(SVG 문자열)·Intent 적용·undo·export. 폰트/LLM/키 0. |
| `@tf-hwp/editor-core` | L2 (headless) | DocSession·SelectionModel·EditController. React·DOM 0. |
| `@tf-hwp/ai-protocol` | L2' (isomorphic) | EditRequest/Response·buildDocContext(R5 펜스)·validate\*. fetch·키 0. 서버·클라 공유. |
| `@tf-hwp/react` | L3 (UI) | `<HwpWorkspace/>` + 오버레이·채팅. 전부 교체 가능. `peerDependencies`: react/react-dom ≥18. |

`@tf-hwp/react` 는 `@tf-hwp/engine`·`@tf-hwp/editor-core` 를 실버전(`^0.0.1`)으로 의존한다(모노레포
`file:` 아님 — 발행본은 레지스트리에서 정상 해석된다). `@tf-hwp/ai-protocol` 은 서버 프록시에서도 쓰므로
독립 설치한다.

---

## 2. wasm / 워커 정적 서빙 (핵심 — 번들러 마법 아님)

엔진은 기본적으로 **Web Worker** 안에서 돈다(파싱·재조판·export 가 메인스레드를 멈추지 않음). 워커와 wasm 은
**public 정적 에셋**으로 배포하고, `WasmAdapter` 가 런타임에 **명시적 URL** 로 로드한다. 번들러 import 마법에
기대지 않으므로 어떤 번들러/호스트에서도 동일하게 동작한다.

발행본(`node_modules/@tf-hwp/engine`)에서 아래 4파일을 **상대구조 그대로** 정적 루트로 복사한다
(`examples/vite-embed/scripts/copy-assets.mjs` 가 그 스크립트다):

```
public/hwp/hwp_wasm_bg.wasm      ← node_modules/@tf-hwp/engine/pkg/hwp_wasm_bg.wasm  (런타임에 URL fetch)
public/hwp/worker.js             ← node_modules/@tf-hwp/engine/worker.js             (모듈 워커 엔트리)
public/hwp/index.js              ← node_modules/@tf-hwp/engine/index.js              (worker.js 가 import)
public/hwp/pkg/hwp_wasm.js       ← node_modules/@tf-hwp/engine/pkg/hwp_wasm.js       (wasm-bindgen 글루)
```

> `worker.js → ./index.js → ./pkg/hwp_wasm.js` 의 **상대 import 체인**이 `public/hwp/` 안에서 그대로
> 성립하도록 디렉토리 구조를 보존해 복사해야 한다. Vite 라면 `vite.config` 에 `optimizeDeps.exclude:
> ["@tf-hwp/engine"]` 를 두어 워커/글루가 esbuild 사전번들 대상이 되지 않게 한다(런타임 정적 로딩 대상).
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

---

## 3. 마운트 — `<HwpWorkspace/>`

```tsx
import { HwpWorkspace, WasmAdapter } from "@tf-hwp/react";
import "@tf-hwp/react/styles.css";               // ← 스타일은 수동 import (사이드이펙트 CSS)

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
/>
```

전체 배선(파일 열기·프로브·폰트 fetch·mock AI)은 [`examples/vite-embed/src/App.tsx`](../examples/vite-embed/src/App.tsx) 참조.

### `styles.css` 는 수동 import

`@tf-hwp/react` 는 CSS-in-JS 가 아니다. `import "@tf-hwp/react/styles.css"` 를 **한 번** 넣어야 오버레이/
채팅/툴바가 스타일된다. 클래스는 네임스페이스드(`hw-*`)라 호스트 스타일과 충돌하지 않고 오버라이드도 자유다.

### `"use client"` — 호스트가 클라이언트 경계를 친다

`@tf-hwp/react` 컴포넌트에는 `"use client"` 지시어가 **들어 있지 않다**(벤더 중립 — RSC 가 아닌 번들러도
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
worker-src 'self' blob:;                # 모듈 워커
font-src   'self' data:;                # 주입 폰트 @font-face
img-src    'self' data: blob:;          # 이미지 삽입/미리보기
connect-src 'self' <AI 프록시 오리진>;   # onAiRequest 가 POST 하는 서버
```

SVG 는 문서 파생 **신뢰불가 문자열**이다 — L3 `HwpPageView` 가 삽입 전 항상 `sanitizeSvg`(R7) 를
통과시킨다(`<script>`/`on*`/`javascript:` 제거). 직접 렌더하더라도 `sanitizeSvg` export 를 반드시 거쳐라.

---

## 5. AI 프록시 (R6 — 키는 서버 전용)

`@tf-hwp/react` 는 LLM/키를 갖지 않는다. `onAiRequest(instruction, anchors, ctx)` 가 **당신의 서버**로
위임한다. 서버는 `@tf-hwp/ai-protocol`(서버·클라 동일 모듈)로 프롬프트/펜스/검증을 조립한다. 정적/비-Next
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

`@tf-hwp/engine` 은 폰트를 하나도 번들하지 않는다. 호스트가 `defaultFont={{ family, bytes }}` 로 **한 벌의
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

```bash
# 발행본 tarball 을 만들고(examples/vite-embed 가 소비) 스모크:
cd examples/vite-embed
npm run pack-deps        # 4개 패키지 npm pack → vendor/*.tgz (prepack 이 pkg/dist 채움, file:→실버전)
npm install              # vendor tarball 설치 (레지스트리 없이 이식 재현)
npm run test:e2e         # Playwright: 업로드 → 8쪽 SVG → 셀 마킹 → mock 편집 → undo
```
