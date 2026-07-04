# tf-hwp 이슈 트래커 (파일 기반)

깃 저장소가 아직 없어 이슈를 파일로 관리한다. 각 이슈는 `NNN-slug.md`. 상태: `open` · `in-progress` · `done` · `wontfix`.

| # | 제목 | 상태 | 우선순위 | 비고 |
|---|------|------|----------|------|
| [001](001-native-numbering-bullets.md) | 네이티브 자동번호/글머리표 풀(`hh:numbering`/`hh:bullet`) | **long-term** | P2 | 코퍼스 근거 0 + 오라클 검증 불가. 외부 샘플 확보 필요. 현재 행잉인덴트+마커로 대체 |
| [002](002-custom-tabs-numbering-formats.md) | 사용자정의 탭 정지 + 개요/번호 형식 문자열 | open | P3 | 폴리시(저가치). `hp:switch` 탭 doubling 주의 |
| [003](003-header-parse-in-dedup.md) | 헤더 풀 parse-in(기존 charPr/paraPr/style dedup, 정확한 styleIDRef) | **long-term** | P2 | dedup 슬라이스 완료. 전체 parse-in은 in-place 편집 op + 비-verbatim 재방출 인프라 선행 |
| [004](004-ai-fill-from-source-and-prompt-caching.md) | fill-from-source NodeID 인용 + prompt caching | **partial** | P3 | structure-preserving `to_markdown`(표=그리드 + `[s/b]` 앵커) 완료. prompt caching은 BYOK 키 필요(보류) |
| [005](005-page-section-layout.md) | 쪽/구역 레이아웃(여백·단·머리말/꼬리말·쪽번호) | **partial** | P2 | 방향+여백 완료. 단/머리말/쪽번호는 OWPML 검증 미완(워크플로 실패) → long-term |
| [006](006-image-embedding.md) | 이미지 임베드(BinData + manifest + `hp:pic`) | **long-term** | P2 | 코퍼스에 임베드 이미지 예제 0 → 검증 불가. 외부 샘플 확보 필요 |

## 제품 로드맵 v1 (2026-07-02) — "코어 하나, 셸 셋"

총괄 지시서: **[docs/PRODUCT-DIRECTION.md](../PRODUCT-DIRECTION.md)** (레드팀 R1–R13 + 빌더 공통 계약 §4 — **모든 이슈 착수 전 필독**).
착수 순서: 007 ∥ 008 ∥ 009 → 010 → 011 ∥ 012 → 014 → 013 → 015 → 016.

| # | 제목 | 상태 | 단계 | 선행 |
|---|------|------|------|------|
| [007](007-wasm-smoke-build.md) | wasm 스모크 빌드 → **A안 확정** (11/11 조합 컴파일, rhwp·krilla 포함) | **done** | P0-A | 7531b35 |
| [008](008-intent-schema-v0.md) | Intent 스키마 v0 동결 + 버저닝 (35 variant, deny_unknown, schema_v0 8테스트) | **done** | P0-B | 8fdae65 |
| [009](009-anchor-chips.md) | 앵커 칩: 마킹 → 채팅 컨텍스트 | **done** (수동검증 대기) | P1-A | 76c415a · LLM준수/first_row 시각확인은 cargo tauri dev 필요; ai_fill 펜스는 011로 이관 |
| [010](010-ai-preview-apply-undo.md) | AI 편집 프리뷰→적용 게이트 + undo (게이트 기존재 → undo 상한50 + ⌘Z 가드 잔여분) | **done** (수동검증 대기) | P1-B | e8c885c · 인터랙티브 e2e는 cargo tauri dev 필요 |
| [011](011-content-presets.md) | 콘텐츠 프리셋 (표 채우기·불릿 정렬) + ai_fill R5 펜스 + 헤더/음영 구조 가드 | **done** (수동검증 대기) | P1-C | a737c1b · e2e 시맨틱은 실 provider 필요; set_para_shape(행잉 인덴트)는 후속 |
| [012](012-hwp-session-extraction.md) | `hwp-session` 파사드 추출 (기능변화 0, golden 바이트동일) | **done** | P2 | a18a776 · LEAF(hwp-mcp 미wrap) 채택 → Session-core absorb는 013로 |
| [013](013-headless-service-container.md) | 헤드리스 서비스 컨테이너 (Shell B) | **done** (c0f8f3e, R2) | P3 | R9에서 전면 보안감사(라이브 공격 시나리오) 통과 — 아래 R9 참조 |
| [014](014-input-hardening.md) | 신뢰불가 입력 하드닝 (파서 DoS 방어) | **done** | P3-pre | b999dc1 · guard 노출만, 배선은 013 |
| [015](015-wasm-npm-package.md) | wasm npm 패키지 `@tf-hwp/engine` — HWP5 런타임 8p·골든 바이트동일·편집루프 wasm 실증 | **done** (PDF 글리프만 018) | P4-A | 4fb1ced · pkg/는 빌드산출물(gitignore, 레시피로 재빌드) |
| [017](017-hwp-mcp-wasm.md) | hwp-mcp wasm화 (http 게이트 + open_bytes/export_bytes) — 015 선행 | **done** | P2b | 3acfc5e · wasm exit0, 네이티브 무변경, smoke 14/14 |
| [018](018-pdf-font-injection.md) | PDF 폰트 바이트 주입(wasm 한글 PDF) + tableAt null 폴리시 | **done** | P4-A후속 | 10ab153 · 네이티브 PDF 골든 바이트동일, FontFile2/CIDFontType2 임베드 실증 |
| [019](019-business-plan-k-poc.md) | 통합 실험 앱 `apps/hwp-lab` (Next.js, **사용자 QA 기준**) — Playwright 스모크 통과 | **done** (사용자 QA 대기) | P5 | cf116e4 · QA.md ①~⑨로 QA; 실LLM·PDF육안·성능은 manual |
| [016](016-react-component-library.md) | React 컴포넌트 라이브러리 `@tf-hwp/react` — sanitize 강제·mock 플로우 10테스트 | **done** | P4-B | 5a18459 · 브라우저 데모는 manual |

## 로드맵 v2 — QA 라운드 1 (2026-07-02, 사용자 QA 피드백)

사용자 QA 4건 → 이슈 3개. 착수: **020 ∥ 021** (파일 disjoint) → **022** (020·021 병합 후).

| # | 제목 | 상태 | 단계 | 비고 |
|---|------|------|------|------|
| [020](020-benchmark1-page1-spill.md) | benchmark1 1페이지 스필 — **18==18 달성** (마지막줄 leading 트림 + stored 행높이 floor) | **done** | QA-P0 | b70ac3f · --rows 진단도구 tracked, 게이트 8==8 불변 |
| [021](021-selection-ux-v2.md) | 선택 UX v2 — 클릭=교체 / ⌘·Ctrl=토글 / 러버밴드 마퀴 | **done** | QA-P1 | 0cb666b · blocksInRect + vitest 14 + Playwright 갱신 통과 |
| [022](022-font-system-v1.md) | 폰트 시스템 v1 — OFL 카탈로그 8종+업로드+삼위일치 (**교차골든 26p 바이트동일**) | **done** | QA-P1 | cb9f7b3 · 셰이퍼 +8.8KB, 라이선스 표 전수 OFL |

## 로드맵 R10 — 라운드 10 (2026-07-04, Tauri 셸 수렴)

방향(사용자 승인): 데스크톱 셸이 @tf-hwp/react HwpWorkspace를 소비 → UI 코드베이스 1개, R5~R8
피그마급 UX가 데스크톱에도 반영. 순서: **043 감사+어댑터** → 044 플래그 뒤 셸 교체(기능 회귀 0 원칙) → 기본 전환.

| # | 제목 | 상태 | 단계 | 비고 |
|---|------|------|------|------|
| [043](043-tauri-convergence-audit.md) | 수렴 전제 — 양방향 격차 감사표 + TauriAdapter 완전화 | open | R10-P0 | UI 무수정; hwp-viewer 커맨드 additive만 |

## 로드맵 R9 — 라운드 9 (2026-07-04, 013 보안 감사)

013은 R2(c0f8f3e)에서 이미 병합돼 있었음이 착수 시점에 확인됨(인덱스 상태 줄이 낡아 있었다 — 이 표가 정정본).
R9는 기존 구현에 대한 **최초의 전면 보안 감사**로 전환: 라이브 컨테이너 공격 시나리오(빈/공백 토큰,
Host 스푸핑, ../ 순회 변형, 컨테이너 내 심링크 탈출 생성) 전부 방어 확인, 루프백 무변경(178 insertions/
0 deletions), HWPX 산출물 로컬 CLI와 byte-identical, PDF는 /Title stem 제외 byte-identical,
business_plan_k 픽스처 패리티 재확인(그쪽 레포 무변경), workspace 346 테스트 0 fail, 게이트 8==8·18==18,
wasm 14/14 + 017 불변, e2e 20/20. 발견·수정: benchmarks/ 이전(a6e6b4e)이 남긴 낡은 픽스처 경로 5파일.

## 로드맵 R8 — 라운드 8 (2026-07-04, 텍스트 편집 심화)

착수: **040 ∥ 041** (소유권: 040=에디터/richedit/HwpWorkspace, 041=어댑터/editor-core — UI 없음) → 실측 보고서(CARET-GAP.md) 기반으로 042(캐럿 UI)·FG-13 잔여분 재평가.

| # | 제목 | 상태 | 단계 | 비고 |
|---|------|------|------|------|
| [040](040-rich-inplace-editor.md) | 리치 제자리 에디터 — 부분 서식(런 단위), 데스크톱 richedit 포팅 | **done** (b807f7c) | R8-P0 | 부분볼드 e2e(SVG 반영+재개봉 왕복+undo); StrictMode 커밋 버그 발견·수정 |
| [041](041-caret-geometry-exposure.md) | 글리프 캐럿 지오메트리 노출 + 셀 캐럿 갭 실측(CARET-GAP.md) | **done** (7248b71) | R8-P1 | 실측: 바이너리 .hwp 앵커 0% → **042 캐럿 UI는 엔진 P1(셀 주소형 CaretRect) 전까지 보류** |

## 로드맵 R7 — 라운드 7 (2026-07-04, 033 백로그 잔여 P0/S급)

착수: **037 ∥ 038** (소유권: 037=HwpPageView, 038=HoverLayer 신규+HwpWorkspace+styles) → **039** (037·038 병합 후).

| # | 제목 | 상태 | 단계 | 비고 |
|---|------|------|------|------|
| [037](037-page-virtualization.md) | 페이지 가상화 — 뷰포트 밖 시트 언마운트(placeholder 크기 유지) | **done** (03969c2) | R7-P0 | DOM 19,826→3,819(−80.7%), SVG 25→3; 034 정합 |
| [038](038-hover-cursor-system.md) | 호버 프리하이라이트 + 커서 상태 체계(I-beam/row-resize/grab) | **done** (c3a9807) | R7-P1 | 호버 렌더 0 계측; hit-test 중앙값 1.2µs |
| [039](039-context-menu.md) | 컨텍스트 메뉴 — 우클릭 앵커 액션(기존 intent 위임만) | **done** (c98ea0a) | R7-P2 | 셀/문단/바탕 3분기; 행삭제·열삽입은 intent 부재로 정직하게 제외 |

## 로드맵 R6 — 라운드 6 (2026-07-03, 033 백로그 집행)

착수: **034 ∥ 035** (소유권: 034=HwpPageView/refresh, 035=HwpWorkspace 뷰포트/줌/팬) → **036** (키보드 셀 내비).

| # | 제목 | 상태 | 단계 | 비고 |
|---|------|------|------|------|
| [034](034-page-selective-refresh.md) | 페이지 선택적 갱신 — 편집 DOM 세금 107ms→≤15ms (문자열 비교 스킵) | **done** (8c9cc5a) | R6-P0 | 105.5→4.5ms(23.4×); 실앱 확인 inject=1/skip=7 |
| [035](035-pan-zoom-gestures.md) | 피그마식 팬/줌 — Space드래그·커서중심 ⌘휠/핀치·⌘0, 제스처 중 CSS transform | **done** (229f8e3) | R6-P0 | 고정점 ±2px e2e; 제스처 중 렌더 0 |
| [036](036-keyboard-cell-nav.md) | 키보드 셀 내비 — 방향키 이동·Enter 편집·Tab 저장+이동 | **done** (bb49949) | R6-P1 | moveCell=px 재프로브; 병합셀 span끝+1 자연 착지 |

## 로드맵 R5 — 라운드 5 (2026-07-03, 사용자 QA: 피그마급 UX)

착수: **030 ∥ 031 ∥ 033** (파일 소유권 분할: 030=useHwpEditor/HwpPageView/styles, 031=units/ColumnResizeOverlay/e2e, 033=docs) → **032** (030 후).

| # | 제목 | 상태 | 단계 | 비고 |
|---|------|------|------|------|
| [030](030-render-perf-cursor.md) | 드래그 버벅임 — **시트 렌더 90→0** (MarqueeLayer rAF+memo) + 커서 default | **done** | R5-P0 | 366ab20 |
| [031](031-resize-reliability.md) | 리사이즈 truth — closest 원점버그 수정+적용검증+행드래그+**분할표 remap** | **done(v2)** | R5-P0 | 72caa35 · v1 diff 병합사고 소실→스펙 기반 재구현(프로토콜 3칙 신설) |
| [032](032-figma-inplace-edit.md) | 피그마식 제자리 편집 — bbox<4px·run보존·IME가드 | **done** | R5-P1 | b211349 · API오류 중단→worktree 이어받기 재개로 완성; **R5 완료** |
| [033](033-figma-grade-research.md) | 피그마 격차 리서치 — **엔진은 이미 피그마급(2ms open)**, 병목=DOM 재주입 107ms | **done** | R5-P1 | 382e5d6 · 백로그 12행+ |

## 로드맵 R4 — 라운드 4 (2026-07-03)

착수: **028 ∥ 029** (react/lab vs docs — disjoint).

| # | 제목 | 상태 | 단계 | 비고 |
|---|------|------|------|------|
| [028](028-floating-selection-toolbar.md) | 플로팅 셀렉션 툴바 + "✨AI에게 전달" | **done** | R4-P0 | 7f1f85a · 위치유틸 6테스트·e2e 거리assert·vitest 61 |
| [029](029-integration-handover.md) | 실통합 인수인계 — INTEGRATION-HANDOVER.md + handover-verify.sh | **done** | R4-P1 | d8ae46f · 문서==스크립트 드리프트0, 아키텍트 직접 exit0 재현; **R4 완료** |

## 로드맵 R3 — 라운드 3 (2026-07-03, 사용자 QA + SDK 재설계)

설계 총괄: **[docs/SDK-LAYERS.md](../SDK-LAYERS.md)** (L1 엔진 / L2 editor-core / L2' ai-protocol / L3 react — 커스텀 계약).
착수: **024 ∥ 025** (엔진, disjoint) → **026** (SDK 재배치) → **027** (편집 패리티 UI).

| # | 제목 | 상태 | 단계 | 비고 |
|---|------|------|------|------|
| [024](024-para-border-frame-overflow.md) | 자가진단표 — draw-side leading 트림(귀하 상자 안 복귀) | **done** | R3-P0 | c445cb6 · 실측이 가설 2개 뒤집음(상자=셀테두리 기렌더/귀하=과전진); 무소실 회귀테스트 tracked |
| [025](025-layout-cache-perf.md) | 레이아웃 캐시 — hitTest 100회 293→3.8ms (**76×**), placeBuilds 100→1 | **done** | R3-P0 | 06b5fa0(amend 복구) · 동일성 2계층+무효화 5지점+골든 불변 |
| [026](026-editor-core-sdk.md) | @tf-hwp/editor-core + @tf-hwp/ai-protocol — headless SDK 재배치 | **done** | R3-P1 | core 20테스트(node)·protocol 13(프롬프트 바이트동일)·vanilla 증명·e2e 무수정 통과 |
| [027](027-editing-parity-ui.md) | 편집 패리티 — 룰러·열너비·표추가·텍스트(run보존)·서식·배경 | **done** | R3-P1 | d1b0c71 · core 37/react 48/e2e 6; **R3 완료** |

## 로드맵 R2 — 라운드 2 (2026-07-03)

착수: **023 ∥ 013** (파일 disjoint: wasm/react/lab vs hwp-mcp/ingest/Docker).

| # | 제목 | 상태 | 단계 | 비고 |
|---|------|------|------|------|
| [023](023-cell-level-marking-web.md) | 웹 셀 단위 마킹 + 스니펫 칩 (분할표 전역row 테스트 고정) | **done** | R2-P0 | a9f7664 · vitest 34, Playwright 셀편집 e2e 통과 |
| [013](013-headless-service-container.md) | 헤드리스 서비스 컨테이너 — 네트워크모드 fail-closed·경로감금·Docker 174MB | **done** | R2-P1 | c0f8f3e · 라이브 컨테이너 보안 검증(403/401/기동거부); **로드맵 v1 전체 종료** |

> 완료된 완성형 핵심(글자/문단/글꼴/표 병합·음영/목록)은 `docs/COMPLETION-ROADMAP.md`와 `CHECKLIST.md` 참고.
