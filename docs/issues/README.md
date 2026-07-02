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
| [013](013-headless-service-container.md) | 헤드리스 서비스 컨테이너 (Shell B) | open | P3 | 012, **014** |
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
| [022](022-font-system-v1.md) | 폰트 시스템 v1 — 카탈로그(OFL)+업로드+화면·조판·PDF 삼위일치 | open | QA-P1 | R8 하드게이트; wasm 셰이퍼 켜기(메트릭 바이트 주입) |

> 완료된 완성형 핵심(글자/문단/글꼴/표 병합·음영/목록)은 `docs/COMPLETION-ROADMAP.md`와 `CHECKLIST.md` 참고.
