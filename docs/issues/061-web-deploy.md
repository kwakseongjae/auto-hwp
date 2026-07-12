# 061 — 웹 배포: hwp-lab 외부 URL(Vercel prebuilt) — 사용자 QA용

- 상태: **deferred (2026-07-12)** — 사용자가 로컬 QA(`cd apps/hwp-lab && npm run dev`)로 진행 결정.
  설계는 완료(아래). 외부 URL이 필요해지면 §⑤ "가장 빠른 QA(오늘)" 30분 경로로 착수.
- 우선순위: R12 QA 인프라 · 영역: apps/hwp-lab + 신규 배포 파이프라인(빌드산출물은 호스팅 CI 밖)
- 근거: 2026-07-11 리서치. 현재 로컬 브라우저 QA만 가능 → 외부 URL 필요.

## 핵심 발견 (레포 사실)
- Next 15.5 App Router, 서버 라우트 `/api/hwp-edit` 1개(`runtime=nodejs`·`force-dynamic`, 키 없으면 mock — **키 없이도 배포만으로 전체 QA 가능**).
- wasm: `LabWorkspace.tsx:54`가 `/hwp/hwp_wasm_bg.wasm` 명시 fetch, `instantiateStreaming` 실패 시 폴백 내장(MIME 안전).
- **COOP/COEP 불필요 확정**(SharedArrayBuffer 0건, 055도 회피 방향), 업로드 CORS 무관(클라 wasm 처리).
- ⚠️ **git 클론만으론 빌드 즉사**: `packages/engine/pkg`(wasm+글루), `packages/{react,editor-core,ai-protocol}/dist`, `public/{hwp,fonts}`가 전부 gitignore → prebuild 훅이 채움 → **Git 연동 자동 배포 금지**.

## 설계 (핵심: wasm은 호스팅 CI에서 절대 빌드하지 않는다 — prebuilt)
- **권장 호스팅 = Vercel**(API route Node 서버리스 + 정적 wasm 무설정, `.wasm`→application/wasm+CDN brotli, Fluid compute 300s로 opus 응답 여유). 세션에 vercel 스킬 설치돼 운영 마찰 최소.
- **파이프라인 = Vercel prebuilt**(`vercel build` 우리 환경 → `vercel deploy --prebuilt`): Rust/wasm-bindgen/JS dist를 로컬·GH Actions에서 빌드해 `.vercel/output`만 업로드.
  - **최소 경로(오늘 30분)**: 로컬 산출물 존재 상태에서 `vercel link → env add ANTHROPIC_API_KEY → vercel build → vercel deploy --prebuilt --archive=tgz` → Preview URL.
  - **프로덕션 경로**: GH Actions `workflow_dispatch`(기존 ci.yml의 rust-toolchain@1.95+wasm32 재사용) → wasm 빌드 → JS dist 3종(각 npm ci) → vercel prebuilt deploy(`VERCEL_TOKEN`/`ORG_ID`/`PROJECT_ID`). **Vercel Git 자동배포는 Ignored Build Step으로 차단**.
- **시크릿/접근제어**: 키는 Vercel env(sensitive). QA 전용 접근 = Basic Auth 미들웨어(`middleware.ts`+`QA_PASSWORD` env — 플랜 무관·`/api` 포함 보호·키 남용 1차 방어 겸함) 권장, 또는 Preview URL + Vercel Authentication. 레이트리밋 = WAF 1규칙(Hobby 무료)로 `/api/hwp-edit`에 IP당 20req/min.

## 수용 기준
- [ ] URL에서 QA.md 시나리오 완주(mock + live 양 모드)
- [ ] 키 미노출(네트워크 탭 검증), 비인가 접근 401
- [ ] wasm application/wasm + immutable 캐시 헤더(`/hwp/*`), 첫 로드 후 재방문 캐시
- [ ] Git 자동배포 차단 확인(prebuilt만), QA.md에 배포 URL QA 절 추가

## 함정
- Git-연동 빌드는 반드시 실패(copy-wasm exit 1) → prebuilt로 통일해 분기 제거.
- 라우트에 `export const maxDuration` 명시(구형 프로젝트 Fluid off 대비).
- 폰트 카탈로그 fetch-on-demand 항목은 배포본에 나눔고딕만 → 404 정직 처리됨(원하면 prebuild에 fetch-fonts).
- Hobby 비상업 제한 — 팀/회사 QA면 Pro.
