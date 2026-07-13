# CURRENT STATE — 단일 복원 지점

> 새 세션·compact 후 **이 파일 하나만 읽으면 재개할 수 있어야 한다.**
> 갱신 시점: 작업 단위 완료 · 결정 확정 · 머지 직후 (보고보다 먼저). 프로토콜: `AGENTS.md` §세션 연속성.

- 기준 커밋: `50db8f0`(063 병합) — **R12(051~057) + R13(058·059·060) + R14(062 quick win·063 패키징) 완료**. GitHub: https://github.com/kwakseongjae/tf-hwp (private)
- 갱신: 2026-07-13 · Claude — 063 웹 이식 패키징 병합·검증 → 승인 배치(060→062→063) 전부 완료

## 지금 (현재 위치)
- 로드맵 기준: **R12 + R13 완료, R14(062 quick win·063 패키징) 완료** — 승인 배치(060→062→063) 전부 병합·검증.
  R12(051~057), R13(058·059·060), R14 062-1 배포용복호(056해소)·062-2 옛한글·062-3 금칙, **063 웹 이식 패키징(50db8f0)**.
- **063 = 병합 완료**: file:→실버전(prepack 치환)·prepack 빌드훅 4패키지·발행 CI(publish.yml dry_run 기본)·
  Vite 임베드 예제(published tarball 설치→렌더 스모크 그린)·AI 프록시 Express 템플릿·EMBED-GUIDE. `npm pack`
  4종 tarball 실측(pkg/dist 포함·file:의존 0). ai-protocol dist ESM `.js` 결함 수정. **실 npm publish는 미실행(pack까지).**
  → 외부 사이트에 `npm i @tf-hwp/react @tf-hwp/engine` 임베드 준비 완료(발행은 사람이 workflow_dispatch로).
- **오픈소스 조사 헤드라인(2026-07-13)**: 우리 약점 상당수(배포용복호·금칙·정렬·다단·대각선·수식·옛한글·
  폰트메트릭)가 이미 external/rhwp(MIT, 우리 소유)에 완성 — 파스전용이라 미배선. → **062 신설**(라이선스 0 승격).
  056 crypto는 062-1(배포용 복호화 quick win)로 해소 경로 확정. 웹 이식 갭 → 063 승격 대기(패키징 최종 1마일).
- 로드맵 정본: `docs/PRODUCT-DIRECTION-V2.md`(북극성 = 브라우저 프로덕션: 업로드→바이브+수동 편집→PDF) + 진행표 `docs/issues/README.md`(상태 진실은 git log — 복원 스크립트가 대조).
- 제품 현 수준: 웹(`apps/hwp-lab`)에서 업로드→수동+챗 편집→PDF/HWPX export가 전부 클라이언트사이드로 동작. 판정 = "강한 내부 데모/프라이빗 베타, GA 아님"(격차 5개가 이슈 051~056).

## 다음 (사용자 승인 완료 2026-07-13 — 이 순서로 자율 진행)
1. **060 프레임표(R13 마감)** — 구현 중. 병합 후 →
2. **062 quick win 배치** — external/rhwp(MIT, 우리소유) 승격. 착수 순서: 062-1 배포용복호화(=056 해소,
   난이도 낮음·rhwp crypto.rs NIST벡터) → 062-2 옛한글 PUA(Public Domain) → 062-3 금칙(줄바꿈 향상).
   ⚠️ 062는 조판 입력 변경 가능(금칙) → 게이트 V5 필수 재확인. rhwp는 읽어서 우리 crate에 재구현(vendored 수정 금지).
3. **063 웹 이식 패키징** — 이슈 파일 신설 필요(README 웹이식 절 근거). 블로커: file:→실버전 + prepublish훅 +
   발행CI + 비-Next wasm서빙 레시피 + 임베드 예제. npm 발행 준비.
- **웹 QA(사용자, 로컬)**: `cd apps/hwp-lab && npm run dev` → localhost:3000 (QA.md). WKWebView IME 4항목 수동 큐(059).
- 검증 정본: `scripts/verify-local.sh` (--full 포함). CI는 수동 전용(`gh workflow run ci`).

## 알려진 flaky (추적 — 실회귀 아님)
- `packages/react/.../workspace.editing.test.tsx` "in-place 에디터 열림 중 028 툴바 숨김" — 전체 스위트에서
  간헐 실패(063 --full에서 1회), **격리·재실행 시 296/296 그린**. 테스트 순서/타이밍 격리 결함(소스 회귀 아님).
  후속: 이 테스트의 공유 상태(타이머/DOM leak) 격리. verify 실패 시 이 테스트면 재실행으로 판별.

## 막힘 / 대기 (없으면 "없음")
- 없음. (056 배포용 crypto는 "수요 확인" 게이트 — 미착수가 정상 상태)

## 진행 중 레인 (병렬 작업 시에만)
| 레인/ID | owner | 상태 | 다음 체크포인트 |
|---|---|---|---|
| B1 062-4 대각선 X-교차 | — | **done** (342b833) — DiagonalKind::Cross, render-only, 게이트 8==8·18==18, cross 테스트 2 | 병합 완료 |
| B2 062-5 수식 렌더 v1 | 구현 에이전트(워크트리) | **착수 예정** — rhwp bootstrap SVG 임베드 | verify --full → 병합 |
소유권: 잔여(수식 B2/차트 B3) 전부 document.rs+lift.rs 공유 → **순차 강제**. 폰트메트릭 디스코프.
계획 근거: docs/issues/062 §잔여 배치 계획(워크플로 wf_842c2cd1). ⚠️함정: B1 에이전트가 커밋 전 external/rhwp
심링크 제거→워크트리 재검증 불가였음→코드-only 커밋이라 main cherry-pick+거기서 검증으로 해소. 앞으로 rhwp 제거 금지 지시.
