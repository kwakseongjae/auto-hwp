# 026 — R3-3: 레이어드 SDK — @auto-hwp/editor-core + @auto-hwp/ai-protocol 신설

- 상태: **open**
- 우선순위: R3-P1
- 영역: packages/* (TS 전용 — Rust 크레이트 무수정)
- 선행: **024·025 병합 후** (025가 어댑터 표면을 바꾸고, 이 이슈가 그 위를 재배치)
- 설계 근거: **docs/SDK-LAYERS.md** (필독 — 레이어 역할/커스텀 계약/경계 위반 금지 목록)

## 목표
"우리 UI에 강제되지 않는" headless SDK로 재배치한다:
- **@auto-hwp/editor-core (신규)**: 프레임워크 무관 에디터 코어 — React 0줄, jsdom 없이 node로
  테스트 가능. `DocSession`(어댑터 위 문서 수명/재조판 신호/undo/폰트), `SelectionModel`
  (021/023의 클릭=교체·⌘토글·셀앵커·마퀴 로직을 React state에서 **하강**), `EditController`
  (Intent 조립·적용·프리뷰), 이벤트 구독(onSelectionChange/onDocChange/onLayoutInvalidated).
- **@auto-hwp/ai-protocol (신규)**: LLM 통신 규격 — 타입(EditRequest/EditResponse/intent_version),
  `buildDocContext`(R5 펜스), `buildSystemPrompt`(INTENT-SCHEMA 발췌, 허용 intent 서브셋 옵션),
  `validateResponse`(화이트리스트+구조 검증). **fetch/LLM 클라이언트/키 0줄** — 순수 변환.
  현재 apps/hwp-lab route.ts와 packages/react에 흩어진 이 로직들을 **여기로 승격**하고 양쪽이
  import (프록시 참조 구현은 lab에 유지 — "예시"로 문서화).
- **@auto-hwp/react**: 로직을 editor-core 호출로 치환한 thin 바인딩으로 축소(`useHwpEditor(core)`
  훅 + 기존 컴포넌트). 공개 API 하위호환(기존 lab 데모가 최소 diff로 동작).

## 파일 지도
- 신규: `packages/editor-core/` (src: session.ts/selection.ts/edit.ts/events.ts/index.ts + tests)
- 신규: `packages/ai-protocol/` (src: types.ts/context.ts/prompt.ts/validate.ts + tests)
- 수정: `packages/react/*` (로직 제거→core 위임; EngineAdapter 타입은 editor-core로 이동하고
  react가 re-export — 하위호환), `apps/hwp-lab`(route.ts가 ai-protocol 소비, LabWorkspace가
  core 경유), `packages/engine/README.md`(레이어 지도 갱신)
- 문서: `docs/SDK-LAYERS.md`의 이슈 매핑 체크, 각 패키지 README(호스트 통합 가이드 — "React
  없이 쓰기" 예제 필수)

## 구현 단계
1. **표면 설계 먼저 문서로**: editor-core/ai-protocol의 공개 API를 각 README에 먼저 쓰고
   (SDK-LAYERS 계약 준수 확인), 구현은 그 표면대로. 기존 HwpWorkspace의 상태·핸들러를
   목록화해 "core로 하강 / react 잔류(순수 표시)"를 분류해 보고에 남겨라.
2. **editor-core**: 어댑터만 의존(EngineAdapter 인터페이스 이동). SelectionModel은 기존 vitest
   시나리오(교체/토글/마퀴/셀)를 **node 환경으로 이식해 그대로 통과**시켜라(DOM 이벤트 대신
   순수 입력: `pointerDown({page,x,y,mod})` 류 — DOM 어댑팅은 react 몫).
3. **ai-protocol**: route.ts의 SYSTEM_PROMPT/화이트리스트/검증 + react의 docContext 조립을
   승격. 서버·클라 동형(isomorphic) — node/browser 양쪽 테스트.
4. **react 재배선**: 컴포넌트는 core 이벤트 구독+커맨드 호출만. 기존 34 vitest가 (react 계층
   재편 후에도) 전부 그린 — 로직이 core로 갔으면 해당 테스트도 core로 이동.
5. **lab 마이그레이션**: route.ts→ai-protocol import, LabWorkspace→useHwpEditor. Playwright
   전 시나리오(셀 마킹/폰트/PDF) 그대로 통과.
6. **"React 없이" 증명**: packages/editor-core/examples/vanilla.ts — 순수 TS로 open→선택→
   intent 적용→export까지 도는 예제 + node 테스트 1개(mock adapter). 이것이 커스텀 계약의 증거다.

## 수용 기준
- [ ] editor-core: React/DOM 의존 0 (package.json+import 검사), node 단위테스트로 selection
      시나리오 전부 통과, vanilla 예제 동작
- [ ] ai-protocol: fetch/키/벤더 0줄, route.ts·클라 양쪽이 동일 모듈 소비, 검증 테스트
- [ ] react: thin 바인딩화(로직 하강 목록 보고), 기존 공개 API 하위호환, vitest 전부 그린
- [ ] lab: Playwright 전 시나리오 그대로 통과 (기능 회귀 0)
- [ ] 각 패키지 README(호스트 통합 가이드) + SDK-LAYERS 경계 위반 0 (검증자가 grep으로 확인)
- [ ] Rust 크레이트/게이트 무접촉 (스테이지 범위 packages/+apps/+docs만)

## 함정
- 한 번에 다 옮기다 e2e가 깨지면 원인 격리가 안 된다 — core 신설→react 위임→lab 순으로
  각 단계 테스트 그린 후 다음으로.
- SelectionModel 하강 시 DOM 좌표 변환(클라이언트px→페이지px)은 **react에 남긴다**(core는
  페이지-로컬 px만 받음 — L1 단위 규약과 동일 층위).
- ai-protocol의 SYSTEM_PROMPT는 INTENT-SCHEMA 발췌 출처 라인 주석을 유지·이관하라(022 규율).
