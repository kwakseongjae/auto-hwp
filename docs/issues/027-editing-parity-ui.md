# 027 — R3-4: 편집 기능 패리티 — 룰러·열너비·표추가·텍스트/서식/배경 (웹)

- 상태: **open**
- 우선순위: R3-P1
- 영역: packages/editor-core(커맨드) + packages/react(옵트인 UI) + apps/hwp-lab
- 선행: **026 (editor-core)** — 모든 기능은 core 커맨드로 먼저, UI는 그 위 옵트인

## 사용자 QA 관찰
데스크톱 앱에는 있는데 웹에 없는 것: 표 열 너비 수동 조절, 표 추가, 상단 룰러(페이지 너비
표시/수정), 텍스트 수정, 폰트(서체/크기/볼드/이탤릭), 표·텍스트 배경 처리.

## 아키텍트 진단 — 엔진은 전부 준비돼 있다 (UI 계층 작업)
필요 Intent가 이미 008 스키마에 동결·wasm으로 노출돼 있다: `SetTableColWidths`(열너비),
`InsertTableAt`/`TableAppendRow`/`TableInsertRows`(표), `SetPageMargins`(mm — 룰러),
`SetTableCellRuns`/`SetParagraphRuns`(run 보존 텍스트 수정), `SetCellRangeFmt`(볼드/이탤릭/
크기/서체/색/정렬), `SetCellRangeShade`(배경). **새 엔진 능력 발명 금지** — 전부 applyIntent로.

## 구현 단계 (기능별 — core 커맨드 → react 옵트인 컴포넌트 → lab 배선 → e2e)
1. **열 너비 드래그**: SelectionOverlay에 열 경계 핸들(기존 table geometry의 col boundaries —
   엔진 노출 필요 시 hwp-session `table_col_boundaries` 존재 확인 후 wasm 바인딩 추가만) →
   드래그 프리뷰(로컬) → 놓으면 `SetTableColWidths`(비율) 적용. ⚠️단위: 화면 px→비율 변환은
   core에서 한 번.
2. **표 추가**: 툴바 버튼 → 행×열 픽커 → 클릭 위치(또는 문서 끝) `InsertTableAt`.
3. **룰러**: 페이지 폭·좌우 여백 표시(PageGeom — wasm 노출 확인/추가), 여백 핸들 드래그 →
   `SetPageMargins`(mm). 표시 전용 우선, 수정은 확인 다이얼로그(전 페이지 영향 명시).
4. **텍스트 수정**: 셀/문단 더블클릭 → 인라인 팝오버 에디터(간단 textarea 기반 v1 — 데스크톱
   contentEditable WYSIWYG의 gotcha는 이식하지 않는다) → 커밋은 `SetTableCellRuns`/
   `SetParagraphRuns`로 **기존 run 서식 보존**(첫 run 스타일 승계 규칙 명시). ⚠️평문 variant 금지.
5. **서식 툴바**: 선택(셀/범위) 위 플로팅 툴바 — B/I/크기 스테퍼/서체(FontPicker 연계)/글자색/
   배경색 → `SetCellRangeFmt`/`SetCellRangeShade`. 문단 선택 시 지원 범위만 활성(미지원은
   비활성+툴팁 — 조용한 무시 금지).
6. **e2e**: Playwright에 열너비 드래그/표 추가/텍스트 수정/볼드+배경 각 1 시나리오. UI 문구
   전부 한글.

## 수용 기준
- [ ] 6개 기능이 core 커맨드(applyIntent 경유)로 동작 — 각 기능 undo 1회로 복구(스냅샷 undo)
- [ ] 열너비: 드래그 프리뷰+적용, 분할표에서도 정상(경계는 페이지-로컬)
- [ ] 텍스트 수정이 run 서식을 보존(볼드 셀 수정 후 볼드 유지 — 테스트)
- [ ] 룰러 표시 정확(mm)·여백 수정 반영, 표 추가 위치 정확
- [ ] 전부 옵트인 컴포넌트(개별 import 가능, HwpWorkspace 없이도 core로 조립 가능 문서화)
- [ ] Playwright 신규 4 시나리오 + 기존 전부 그린, 게이트 v2 유지(엔진 무접촉이면 자동)

## 함정
- 룰러/열너비의 px↔mm↔비율 변환을 UI에 흩뿌리지 마라 — core 유틸 한 곳.
- 텍스트 팝오버 에디터에서 IME(한글 조합) 이벤트 처리 확인 — compositionend 전 커밋 금지.
- SetPageMargins는 문서 전체에 적용된다 — 사용자에게 명시(개별 페이지 아님).
- 데스크톱 richedit(#000 규칙 등)의 코드를 복사해오지 마라 — v1은 단순 팝오버가 스코프.
