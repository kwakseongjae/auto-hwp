# 063 — 웹 이식: npm 발행 + 외부 호스트 임베드 패키징

- 상태: open · 우선순위: R14(웹 이식) · 영역: packages/*(패키징) + 발행 CI + 통합 예제/문서
- 근거: 2026-07-13 SDK 이식 감사. 제3자가 `npm i @tf-hwp/react @tf-hwp/engine`으로 자기 페이지에
  hwp 뷰어/에디터를 심는 시나리오. **아키텍처 경계(어댑터·헤드리스·벤더중립·R7 sanitize)는 이식 준비
  우수** — 막는 건 패키징 "최종 1마일".

## 블로커 랭킹 (감사 확정, file:line은 감사 보고 참조)
1. **[치명] `@tf-hwp/react`의 `file:` 상호의존** (`packages/react/package.json:37-38` — `file:../engine`·
   `file:../editor-core`) → npm 레지스트리가 해석 불가. 실버전(`^0.0.1`)으로 바꾸고 발행 순서
   **engine → editor-core → ai-protocol → react**.
2. **[치명] prepublish 빌드 훅 부재** (engine엔 scripts 키 자체 없음) → gitignore된 pkg/dist가 빈 채
   발행되는 빈 tarball 위험. 4패키지 모두 `prepublishOnly`/`prepack` 추가(engine=wasm-bindgen 레시피
   +wasm-opt, react=vite+tsc).
3. **[높음] 발행 CI·publishConfig 부재** — `npm publish` 워크플로 + `.npmrc`/publishConfig(access:public)
   + 발행 순서 자동화(workflow_dispatch, CI는 수동 원칙).
4. **[높음] 비-Next 호스트용 wasm/워커 정적 서빙 레시피 부재** — 현 가이드(INTEGRATION-HANDOVER.md)가
   Next 편중. 워커 모드는 glue 기본경로 사용 불가 → Vite/CRA용 wasm+worker.js+worker-client.js 3파일
   상대구조 배포 레시피 문서화.
5. **[중] 프레임워크 독립 AI 프록시 템플릿** — 유일 서버구현이 Next route(`/api/hwp-edit`). 정적/타
   백엔드용 Express/Edge/Cloudflare 템플릿(로직은 ai-protocol 재사용, 얇음). BYOK 키 서버전용(R6) 유지.
6. **[중] published-package 임베드 예제·스모크** — 현 데모 전부 소스경로 import. `npm pack` tarball을
   설치해 Vite 프로젝트에서 렌더하는 최소 예제+스모크(이식 성공 증명).
7. **[낮] 문서화** — 컴포넌트 `"use client"` 미포함(호스트 래핑 책임 명시), styles.css 수동 import,
   CSP 헤더 가이드, SSR ssr:false 안내. Next16 Turbopack 회귀(next 15.5 고정 이유) 경고.

## 이미 잘 된 것 (재작업 금지)
어댑터 추상화(EngineAdapter seam) · 헤드리스 계층(editor-core/ai-protocol DOM 0) · AI 벤더중립(onAiRequest
위임, 키 0) · R7 sanitize 컴포넌트 내 강제 · engine files 화이트리스트(wasm/glue/worker 포함) · 트랩/워커
사망 복구. 이식 토대는 탄탄 — 063은 발행/배선/문서만.

## 착수 순서 (블로커 1~2 먼저 = 발행 가능, 4·6·7 = 임의 호스트 임베드 성립)
1. file:→실버전 + prepublish 훅 (블로커 1·2) → **npm 발행 가능**
2. 발행 CI + publishConfig (블로커 3)
3. 비-Next wasm 서빙 레시피 + Vite 임베드 예제/스모크 (블로커 4·6)
4. AI 프록시 템플릿 + 문서화 (블로커 5·7)

## 수용 기준
- [ ] `npm pack` 4패키지 → tarball에 pkg/dist/worker 포함(빈 tarball 아님), file: 의존 0
- [ ] 신규 Vite 프로젝트에서 published tarball 설치 → 뷰어 렌더 + 셀 편집 스모크 그린(이식 증명)
- [ ] 발행 순서 자동화(workflow_dispatch), access:public
- [ ] 비-Next wasm/워커 서빙 문서 + 최소 예제, AI 프록시 템플릿 1종
- [ ] 기존 apps/hwp-lab 무회귀(verify-local --full)

## 함정
- 발행은 되돌리기 어려움(npm unpublish 제약) — 버전/스코프/access 확인 후 발행. 첫 발행은 0.0.x 유지.
- wasm 재빌드 절차(AGENTS.md 함정) — prepublish 훅이 이걸 정확히 재현해야 빈 tarball 안 남.
- Next16 Turbopack이 fidelity webpack 훅 무시 → wasm 중복 방출(next 15.5 고정 근거 문서화).
