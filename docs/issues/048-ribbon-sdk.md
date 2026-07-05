# 048 — R11-4: 상단 서식 리본 SDK 승격 — 선택+편집 겸용 영속 바

- 상태: **open** · 우선순위: R11-P1 · 영역: packages/react(신규 Ribbon + HwpWorkspace **헤더/상단 영역** + 에디터 라이브 스타일 브리지)
- 병렬: 047(표 오버레이/그립/다이얼로그 소유 — 그 영역 접촉 금지).

## 근거 (감사표 "리본" M — 데스크톱 R11)
데스크톱은 영속 상단 리본이 **비편집 시 = 선택 대상 서식 op / 편집 중 = 라이브 선택 스타일**로
이중 동작한다(플로팅 툴바가 드래그 선택을 가리는 문제의 해법이기도 했다). SDK는 028 플로팅
툴바뿐 — 편집 중엔 숨고(두 크롬 원칙), 라이브 스타일은 ⌘단축키(040)로만 가능하다.

## 목표
- HwpWorkspace 상단(기존 툴바 줄 확장 또는 아래 한 줄)에 **영속 서식 리본**: 굵게/기울임/밑줄/
  취소선·글자 크기 스테퍼·글자색·배경색·정렬(+FontPicker 기존 배치 유지). enableEditing 전제.
- **이중 동작**(데스크톱 시맨틱 그대로):
  - 비편집 + 셀/범위 선택: useSelectionActions(039 공용 유틸) 경유 — 028 툴바와 동일 op·토스트.
  - **편집 중(040 에디터 열림): richedit.applyLiveStyle로 에디터 내 라이브 선택 스타일** —
    커밋 경로/latch 무접촉, 포커스 유지(040의 selInside 가드 교훈 — 리본 클릭이 에디터 선택을
    잃게 하면 안 된다: preventDefault/pointerdown 처리 실측).
- 현재 상태 반영: 선택/커서 위치의 굵게 여부 등 토글 상태 표시(028 curBold 로직 재사용).
- 028 플로팅 툴바와의 관계: 리본 도입 후에도 유지(피그마도 이중) — 단 동작·문구 완전 일원화
  (공용 유틸 하나만). 리본은 데스크톱 신 셸(044)에서도 그대로 뜬다 — 별도 작업 불요 확인.

## 실측 출발점
- 데스크톱 리본: crates/hwp-viewer/ui의 FormatControls(R11~R13) — onPatch→applyLiveStyle /
  commitCharFmt 이중 라우팅 원형.
- SDK 부품: useSelectionActions(039), richedit.applyLiveStyle(040), FontPicker(022), fmt 토스트.

## 수용 기준
- [ ] 리본 표시+비편집 서식 적용(028과 동일 op) — vitest+e2e
- [ ] 편집 중 라이브 스타일(에디터 선택 유지·latch 무접촉·커밋 시 run 보존) — vitest+e2e
      (부분 선택 굵게를 리본 버튼으로 → 커밋 → SVG 부분 반영 assert)
- [ ] 토글 상태 반영, 028 툴바 무회귀(공용 유틸 일원화), 두 크롬 시각 충돌 없음
- [ ] 047 소유 영역 무접촉, 엔진 무접촉, 기존 스위트 그린, 언스테이지 0

## 함정
- 리본 버튼 mousedown이 contentEditable 선택을 붕괴시킨다 — 데스크톱이 이미 푼 문제
  (preventDefault 타이밍). 원형 코드를 정독하고 같은 방식으로.
- 편집 중 색상 피커: onChange만 사용(onInput은 드래그 스텝마다 op 스팸 — R13d 교훈).
- e2e 전 빌드 순서 + **apps/hwp-lab `rm -rf .next` 필수**.
