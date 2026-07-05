# 047 — R11-3: 열너비 mm 정밀 + 균등 분배 + 편집 중 셀음영 SDK 승격

- 상태: **done** (d84da6f) · 우선순위: R11-P1 · 영역: packages/react(표 오버레이/유틸/신규 다이얼로그) + editor-core(폭 커맨드) — **HwpWorkspace는 표 오버레이·그립 배선 영역만**
- 병렬: 048(리본 — HwpWorkspace **헤더/상단 영역** + 에디터 라이브 스타일 소유). 그 영역 접촉 금지.

## 근거 (TAURI-CONVERGENCE.md 감사표 "셀음영/열너비mm" M)
데스크톱 R13-5: 열너비 **mm 단위 정밀 입력** + **균등 분배**(set_table_col_widths 커맨드),
R7-Part1: 편집 중 포커스 셀 배경색. SDK는 드래그 리사이즈(031)와 선택-후 배경색(028/039)만 있다.

## 목표
1. **열너비 mm**: 표/열 선택 상태에서 "열 너비…" 진입(플로팅 툴바 또는 컨텍스트 메뉴에 항목 추가
   — 039 공용 액션 유틸 경유) → 소형 다이얼로그: 현재 열 폭 mm 표시(실측값), mm 입력 → 적용.
   HWPUNIT↔mm 변환은 units.ts 한 곳(§4.5 — 새 산술 흩뿌리기 금지). 적용-확인(031 정신):
   커밋 후 실제 경계 변화 검증, 무변화면 정직한 실패 토스트.
2. **균등 분배**: 같은 진입점에 버튼 — 선택 표의 전 열을 등폭으로. 데스크톱과 동일 시맨틱.
3. **편집 중 셀음영**: 040 리치 에디터 열림 중에도 현재 셀 배경색 적용 가능(데스크톱 R7-Part1
   동작 실측 후 포팅 — 에디터 셀 대상 SetCellRangeShade 1셀 경로, 커밋/에디터 상태와 경합 금지).
4. 분할표(페이지 걸침)와 1×1 프레임 래핑 표에서의 동작을 실측 — 데스크톱의 기존 가드
   (fragment-local vs global rows, R13d 교훈)를 SDK에 동일 적용.

## 실측 출발점
- 데스크톱: crates/hwp-viewer set_table_col_widths 커맨드 + ui의 R13-5 UI. wasm 동등 인텐트
  존재 여부(SetTableColWidths?) — 없으면 additive 바인딩(파사드 경유)+게이트/골든/wasm-safe 직접 실행.
- SDK 기존 부품: units.ts(boundariesToRatios/resizeBoundary), ColumnResizeOverlay(031),
  useSelectionActions(039), tableColBoundaries/tableBox 지오메트리.

## 수용 기준
- [ ] mm 입력 적용+실측 검증(적용-확인)·균등 분배 — vitest+e2e(경계 px 이동 assert)
- [ ] 편집 중 셀음영 — vitest(에디터 열림 중 적용·에디터 유지)+e2e
- [ ] 두 어댑터 동형(필요 시 wasm additive+게이트·골든 증빙), 분할표/프레임표 가드
- [ ] 048 소유 영역(헤더/에디터 라이브스타일) 무접촉, 기존 스위트 그린, 언스테이지 0

## 함정
- mm 표기: 실제 적용은 HWPUNIT 정수 반올림 — 왕복(mm→HWPUNIT→mm) 오차를 다이얼로그 표시에
  반영(거짓 정밀도 금지). 데스크톱과 동일 반올림 규칙.
- 균등 분배 후 재선택 좌표가 낡는다 — R13-4 reselectRangeAfterRepaint 교훈 적용.
- e2e 전 빌드 순서 + **apps/hwp-lab `rm -rf .next` 필수**.
