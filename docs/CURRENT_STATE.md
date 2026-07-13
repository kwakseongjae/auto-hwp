# CURRENT STATE — 단일 복원 지점

> 새 세션·compact 후 **이 파일 하나만 읽으면 재개할 수 있어야 한다.**
> 갱신 시점: 작업 단위 완료 · 결정 확정 · 머지 직후 (보고보다 먼저). 프로토콜: `AGENTS.md` §세션 연속성.

- 기준 커밋: `50db8f0`(063 병합) — **R12(051~057) + R13(058·059·060) + R14(062 quick win·063 패키징) 완료**. GitHub: https://github.com/kwakseongjae/tf-hwp (private)
- 갱신: 2026-07-13 · Claude — 063 웹 이식 패키징 병합·검증 → 승인 배치(060→062→063) 전부 완료

## 지금 (현재 위치)
- 로드맵 기준: **R12 + R13 + R14 완료 + 후속 배치 진행** — R12(051~057), R13(058·059·060),
  R14 062(배포용복호=056해소·옛한글·금칙·대각선·수식v1·차트v1) + 063 웹 이식 패키징.
- **후속 배치(2026-07-13, 트리아지 90항목→7 actionable)**: ✅ flaky 028툴바 격리(Date.now 고정, 3회 296/296) ·
  ✅ IME Chrome CDP e2e(059 회귀락, main 통과) · ✅ BMP PDF 임베드(순수 Rust 파서, stub 제거) ·
  ✅ FaceName PANOSE 분류(rhwp type_info, 게이트 before==after) · ✅ rhwp upstream/kordoc 조사(→062 문서).
  ❌ 중첩표 토스트=엔진 nested 미방출 speculative→**revert, 064 신설**(엔진 선행). 
  남은 후속: **#7 npm 발행 자동화 = 063에서 이미 완료**(중복 계산이었음). **rhwp 재벤더링 v0.7.18 = 블로킹**
  (미러 포크에 태그 없음 → needsExternal, 062에 실행 스텝). → **지금 처리 가능한 후속 전부 완료.**

## 실물 QA 발견 (2026-07-13, ~/Desktop/archive 24개 실물 + Grok 4.5 실호출)
OpenRouter/Grok 4.5 웹 생성 연동 완료(`.env.local` BYOK). 실물 스윕 발견:
- **065 (P0, major)**: **압축 mimetype HWPX 거부 → 실물 6/24(25%, 작성완료본)가 안 열림.** detector가 앞 512B
  리터럴 매칭만(무압축 mimetype 가정) → 압축 시 Unknown 거부. fallback zip 디코드 필요. **업로드→렌더 직결.**
- **066 (P0, major)**: **바이브 표 편집이 컨텍스트 blindness로 실패.** 웹 doc-context가 표 그리드를 안 줌 →
  "표 채워줘" intents 0, 라벨 지정 엉뚱한 셀. **Grok A/B 실증: 그리드 주면 완벽 동작**(모델 아닌 컨텍스트 문제).
  to_markdown(004)을 웹에 배선하면 됨. 구조편집(행 추가)도 같은 뿌리(F3).
- 정상 확인: .hwp 렌더/export/게이트(8==8~25==25, 99.4%) OK, 문단 편집 Grok 정상, PDF/HTML export OK(작성완료본 제외).
- 스윕 도구: `scripts/`(임시 qa-sweep는 scratchpad), CLI own-render/export-html/export-pdf/layout-check.

## 다음 = 로컬 육안 QA (사용자) + 위 발견 수정 배치
`cd apps/hwp-lab && rm -rf .next && npm run dev` → Chrome. **QA.md 시나리오 ⑪~⑱**(이번 세션 신규 렌더:
수식·차트·대각선·옛한글·IME·명조고딕·금칙·배포용복호/BMP)을 원본 PDF/한컴 뷰어와 대조. 기존 ①~⑩도 회귀 확인.
QA 발견사항 → 이슈로 정리해 다음 배치. WKWebView IME 실기(059)는 데스크톱 Tauri에서 별도 수동.
- **062 렌더러 승격 요약**: 배포용복호·옛한글·금칙·대각선·수식·차트 = rhwp(MIT) 승격 완료.
  **잔여(후속)**: ① 수식/차트 자체 PaintOp 이식 v2(Path/Bezier 프리미티브 필요, XL) + krilla PDF 렌더
  ② 레거시 OLE VtChart(rhwp도 미렌더) ③ rhwp upstream(>v0.7.15) 델타 미확인 ④ 폰트메트릭=디스코프(영구).
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
| (없음 — 062 잔여 배치 B1·B2·B3 전부 병합·검증 완료) | | | |
