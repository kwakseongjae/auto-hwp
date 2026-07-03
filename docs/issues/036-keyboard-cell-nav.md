# 036 — R6-3: 키보드 셀 네비게이션 — 방향키 이동 · Enter 편집 · Tab 이동

- 상태: **open** · 우선순위: R6-P1 · 영역: editor-core(SelectionModel 커맨드) + react(keydown 배선)
- 선행: **034·035 병합 후** (HwpWorkspace 키/포커스 영역 충돌 방지)

## 목표 (피그마/스프레드시트 관례)
- 셀이 선택된 상태에서 **방향키 = 인접 셀로 선택 이동**(표 경계에서 멈춤; 분할표는 전역 row
  기준 — 다음 페이지 조각으로 자연 이동). ⌘/Ctrl 미조합 시에만.
- **Enter = 제자리 편집 진입**(032 에디터), **편집 중 Tab = 저장 후 오른쪽 셀 이동+편집**,
  Shift+Tab = 왼쪽. 편집 중 Enter/Esc 규약은 032 그대로.
- 이동 시 화면 밖이면 해당 셀로 스크롤(scrollIntoView 최소 이동).

## 설계 (SDK-LAYERS)
- 이동 로직은 **editor-core**: `SelectionModel.moveCell(dir)` — 현재 셀 앵커(section/block/
  row/col)에서 rows/cols 경계 클램프로 다음 좌표 계산 → cellBox/tableCellAt 재조회로 새 앵커
  +마크 갱신(어댑터 지오메트리 사용, React 0). node 테스트로 4방향+경계+분할표(전역 row) 고정.
- react는 keydown 배선만: 에디터/컴포저 포커스 중·⌘조합·비셀 선택이면 무시.

## 구현 단계
1. editor-core: moveCell(dir) + 어댑터 cellBox 재조회(023의 전역 좌표 규칙 — first_row 재가산
   금지) + node 테스트(4방향/경계 멈춤/분할표 페이지 전환 좌표).
2. react: keydown(방향키→moveCell, Enter→openEditorAt(현재 셀), 편집 중 Tab/Shift+Tab→커밋 후
   moveCell+재진입). 포커스 가드(에디터·textarea·input·채팅 중 무시). scrollIntoView.
3. 테스트: core node 테스트 + react vitest(키 가드/Enter 진입/Tab 시퀀스 mock) + e2e 1:
   셀 클릭→→키 3회→라벨 열 증가 assert→Enter→에디터 열림→Tab→오른쪽 셀 에디터.
4. 무회귀: 기존 Esc 해제·⌘토글·032/031/030 전부.

## 수용 기준
- [ ] 방향키 이동(경계 클램프·분할표 전역 row) — core node 테스트
- [ ] Enter=편집 진입, 편집 중 Tab/Shift+Tab=저장+이동+재진입 — e2e
- [ ] 포커스 가드(입력 요소·에디터·⌘조합 무시), scrollIntoView
- [ ] 기존 테스트 전부 그린, 엔진 무접촉, 언스테이지 0

## 함정
- 방향키가 페이지 스크롤 기본동작과 경합 — 셀 선택 있을 때만 preventDefault.
- 병합 셀: cellBox가 span을 반환하면 다음 좌표는 span 끝+1 — 실측 후 규칙 기록.
- Tab 이동 중 커밋 실패 시: 이동 취소하고 에디터 유지(031 적용-확인 정신).
