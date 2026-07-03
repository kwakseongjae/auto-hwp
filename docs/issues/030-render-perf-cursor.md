# 030 — R5-1: 드래그 버벅임 제거 (React 렌더 경로) + 커서 정상화

- 상태: **open** · 우선순위: **R5-P0** · 영역: packages/react (+ useHwpEditor)
- 병렬: 031(ColumnResizeOverlay/units/e2e 소유 — **이 이슈는 그 파일들 금지**), 033(docs)
- **파일 소유권**: useHwpEditor.ts · HwpPageView.tsx · SelectionOverlay.tsx · styles.css ·
  HwpWorkspace의 포인터/구독 배선. (031이 소유한 ColumnResizeOverlay·units.ts 접촉 금지.)

## 아키텍트 진단 (하드 팩트 — 이 위에서 시작)
- **원흉 확정**: `useHwpEditor.ts:29-30` — selection/marquee가 core 이벤트마다 `useState`로
  미러링된다. 마퀴 드래그 = **pointermove마다 setState → HwpWorkspace 전체 리렌더**(18개
  HwpPageView + 모든 오버레이 + 툴바). 025의 엔진 캐시(76×)와 무관한 **React 계층 병목**.
- 커서: `styles.css:69`의 `cursor: crosshair` — 기본 커서로 교체(사용자 확인).

## 목표
드래그(마퀴/이동) 중 **문서 시트가 리렌더되지 않는다**(렌더 카운터로 증명). 선택 확정
시에만 1회 상태 반영. 체감: 피그마급 즉각성(60fps 드래그).

## 구현 단계 (측정 → 수정 → 재측정)
1. **측정 하네스 먼저**: HwpPageView에 dev 전용 렌더 카운터(전역 window.__hwRenders 류,
   프로덕션 스트립)를 넣고, Playwright로 "마퀴 드래그 30 move" 중 시트 렌더 횟수를 측정해
   BEFORE 수치를 보고에 남겨라.
2. **마퀴를 React state에서 분리**: 드래그 중 마퀴 사각형은 rAF + ref로 전용 오버레이 div의
   style을 직접 갱신(또는 마퀴 상태만 구독하는 최소 컴포넌트로 격리 — useSyncExternalStore
   selector). pointermove가 워크스페이스 setState를 유발하지 않게. 선택 결과는 pointerUp에서만
   상태 반영(기존 시맨틱 유지 — editor-core는 무수정이 이상적, 이벤트 구독 세분화가 필요하면
   core에 추가만).
3. **시트 메모화**: HwpPageView를 (page, svg문자열, scale) 기준 React.memo — 선택/마퀴/툴바
   상태 변화가 시트 리렌더를 못 일으키게. SelectionOverlay는 별도 레이어로 이미 분리돼 있으니
   그쪽만 selection 구독.
4. **커서**: `.hw-sheet`(styles.css:69) crosshair → default. 열 그립은 col-resize 유지,
   텍스트 위 I-beam은 스코프 밖(033 리서치로).
5. **AFTER 측정**: 같은 하네스로 드래그 30 move 중 시트 렌더 **0회**(마퀴 레이어 제외) +
   pointerUp 후 1회를 assert하는 테스트(vitest 또는 Playwright)로 고정. 기존 vitest 61 +
   Playwright 7 무회귀.

## 수용 기준
- [ ] BEFORE/AFTER 렌더 카운트 수치 보고 (드래그 30 move: 시트 렌더 N→0)
- [ ] 드래그 중 setState 경유 워크스페이스 리렌더 0 (테스트로 고정)
- [ ] 선택 시맨틱 무변경 (기존 selection vitest 전부 그대로 통과 — editor-core 계약 유지)
- [ ] 커서 default (crosshair 제거), 열 그립 col-resize 유지
- [ ] vitest·Playwright 전부 그린, 엔진/크레이트 무접촉, 언스테이지 잔여 0

## 함정
- editor-core의 이벤트 시맨틱(마퀴 이벤트 발행)은 바꾸지 마라 — React 쪽 구독/반영 방식만.
  코어에 손대면 031/032와 충돌한다. 구독 세분화 API가 필요하면 **추가만**+사유.
- React.memo의 svg prop은 문자열 동일성 — 025의 wasm svg 캐시 덕에 동일 revision이면 같은
  문자열이 오는지 확인하고, 아니면(매번 새 문자열) 페이지·revision 키 메모를 어댑터/훅에서.
- 플로팅 툴바(028)의 "드래그 중 숨김"은 pointerActive 상태에 의존 — 이 리팩터로 깨지지 않게
  (툴바 표시 상태는 저빈도라 state 유지 OK).
