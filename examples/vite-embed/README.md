# auto-hwp Vite 임베드 예제 (issue 063 — 이식 증명)

비-Next(Vite) 앱에서 **레지스트리 발행본**(`@auto-hwp/* ^0.0.5`)을 설치해 `<HwpWorkspace/>` 를 렌더한다.
소스경로 import 는 0 — `node_modules` 의 발행본만 소비한다. 이 예제가 그린이면 "제3자가
`npm i @auto-hwp/*` 로 자기 페이지에 hwp 뷰어/에디터를 심을 수 있다"가 증명된다.

전체 임베드 레시피(wasm/워커 로딩, `"use client"`/`ssr:false`, CSP, 폰트, AI 프록시)는
[`docs/EMBED-GUIDE.md`](../../docs/EMBED-GUIDE.md) / [영문](../../docs/EMBED-GUIDE.en.md) 참조.

## 실행

```bash
# 1) 설치 — 레지스트리에서 그대로 (fresh clone 이 겪는 경로와 동일)
npm install

# 2) 개발 서버 — predev 훅이 wasm/워커/폰트를 public/ 로 복사(설치된 발행본에서)
npm run dev            # http://localhost:5180

# 3) 스모크 — Playwright: 업로드 → 8쪽 SVG 렌더 → 셀 마킹 → mock 편집(서버 없음) → undo
npm run test:e2e
```

### 레포 로컬 빌드본으로 바꾸기 (미발행 변경 확인)

```bash
REPO_DEV=1 npm run dev   # packages/* 를 pack → npm install --no-save 로 덮어씀
npm run use-local        # REPO_DEV 없이 강제 적용
npm install              # 원복(레지스트리)
```

`--no-save` 라 `package.json` 의 선언은 **레지스트리 그대로**다. 즉 이 예제의 선언은 언제나 외부
사용자가 보는 것과 같고, 로컬본은 `node_modules` 에만 얹힌다.

> 이 예제는 stable `0.0.5`의 CDN 기본값 대신 wasm/워커를 명시 URL로 로드한다. CDN 없이도 동작해야 하는
> 폐쇄망·엄격 CSP 호스트의 자기호스팅 경로를 계속 검증하기 위한 의도된 선택이다.

## 구성

| 파일 | 역할 |
|---|---|
| `package.json` | `@auto-hwp/*` 를 레지스트리 `^0.0.5` 로 설치 — **발행본** 소비. |
| `scripts/prepare-deps.mjs` | REPO_DEV=1 일 때만 로컬 `packages/*` pack → `npm install --no-save` 오버라이드. |
| `scripts/pack-deps.mjs` | 4개 패키지 `npm pack` → `vendor/` (발행 순서 engine→editor-core→ai-protocol→react). |
| `scripts/copy-assets.mjs` | `node_modules/@auto-hwp/engine` 에서 wasm+worker+글루를 `public/hwp/` 로 복사(비-Next 정적 서빙 레시피). |
| `src/App.tsx` | `WasmAdapter`(명시적 wasm/worker URL) + `<HwpWorkspace/>` + **로컬 mock** `onAiRequest`(서버 없이 셀 편집 왕복). |
| `e2e/smoke.spec.ts` | 뷰어 렌더 + 셀 편집 이식 스모크. |

## AI 는 로컬 mock

이 예제는 서버가 없다 — `onAiRequest` 가 참조 프록시의 mock 과 동형인 **로컬 결정적 mock**이라 키 없이도
"셀 편집" 이 완주된다(R6: 패키지는 LLM/키를 갖지 않는다). 실제 호스트는 그 자리에 서버 프록시 fetch 를
꽂는다 → [`examples/ai-proxy-express`](../ai-proxy-express).
