# auto-hwp Vite 임베드 예제 (issue 063 — 이식 증명)

비-Next(Vite) 앱에서 **published tarball 을 설치**해 `<HwpWorkspace/>` 를 렌더한다. 소스경로 import 는
0 — `node_modules` 의 발행본(`npm pack` tarball)만 소비한다. 이 예제가 그린이면 "제3자가 `npm i @auto-hwp/*`
로 자기 페이지에 hwp 뷰어/에디터를 심을 수 있다"가 증명된다.

전체 임베드 레시피(wasm/워커 정적 서빙, `"use client"`/`ssr:false`, CSP, 폰트, AI 프록시)는
[`docs/EMBED-GUIDE.md`](../../docs/EMBED-GUIDE.md) 참조.

## 실행

```bash
# 1) 발행본 만들기 — 4개 패키지 npm pack → vendor/*.tgz
#    prepack 훅이 빌드(engine=wasm 레시피, react=vite+tsc+file:→실버전 치환, 나머지=tsc)를 수행하므로
#    tarball 은 pkg/dist 를 담고 file: 의존이 0이다(발행본과 동일).
npm run pack-deps

# 2) 설치 — vendor tarball 을 소비(레지스트리 없이 이식 재현; package.json 의 file:./vendor + overrides)
npm install

# 3) 개발 서버 — predev 훅이 wasm/워커/폰트를 public/ 로 복사(설치된 발행본에서)
npm run dev            # http://localhost:5180

# 4) 스모크 — Playwright: 업로드 → 8쪽 SVG 렌더 → 셀 마킹 → mock 편집(서버 없음) → undo
npm run test:e2e
```

## 구성

| 파일 | 역할 |
|---|---|
| `package.json` | `@auto-hwp/*` 를 `file:./vendor/*.tgz`(+overrides)로 설치 — **발행본** 소비. |
| `scripts/pack-deps.mjs` | 4개 패키지 `npm pack` → `vendor/` (발행 순서 engine→editor-core→ai-protocol→react). |
| `scripts/copy-assets.mjs` | `node_modules/@auto-hwp/engine` 에서 wasm+worker+글루를 `public/hwp/` 로 복사(비-Next 정적 서빙 레시피). |
| `src/App.tsx` | `WasmAdapter`(명시적 wasm/worker URL) + `<HwpWorkspace/>` + **로컬 mock** `onAiRequest`(서버 없이 셀 편집 왕복). |
| `e2e/smoke.spec.ts` | 뷰어 렌더 + 셀 편집 이식 스모크. |

## AI 는 로컬 mock

이 예제는 서버가 없다 — `onAiRequest` 가 참조 프록시의 mock 과 동형인 **로컬 결정적 mock**이라 키 없이도
"셀 편집" 이 완주된다(R6: 패키지는 LLM/키를 갖지 않는다). 실제 호스트는 그 자리에 서버 프록시 fetch 를
꽂는다 → [`examples/ai-proxy-express`](../ai-proxy-express).
