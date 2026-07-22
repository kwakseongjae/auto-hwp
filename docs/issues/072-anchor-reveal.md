# 072 — AI 카드 대상 위치 보기 (앵커 자동 후보 제시 v1)

- 상태: **done (2026-07-22 구현 완료)** · 우선순위: P2 · 영역: packages/react
- 근거: 067로 마킹 0 편집이 열리며 카드가 `s0·b1` 주소만 보여줌 — 사용자가 "어느 블록이 바뀌는지"를
  적용 전에 눈으로 확인할 길이 없다(진단 U1 후속 UX).

## 설계 (v1 — 최소)
제안 카드에 "위치 보기" 액션: 클릭 시 대상 `(section, block)`의 화면 박스를 찾아 스크롤+임시
하이라이트(2s 플래시 오버레이). 박스 탐색 = 표는 기존 `tableBbox`/경계 API, 일반 블록은 페이지
순회 `blocksInRect(page, 전체영역)`에서 section/block 매치(클릭 시 1회라 비용 무시 가능).
엔진 신규 API 불필요 — 순수 react 배선. 후속 v2: 앵커 미마킹 요청 시 모델 응답 전 "이 표를
말씀하시는 것 같아요" 후보 침 제시(프로필 표 목록 기반).

## 구현 (2026-07-22)
설계 그대로: `OpCard` "⊙ 위치 보기"(`onRevealTarget`) → `HwpWorkspace.revealBlock`이 페이지 순회
`blocksInRect`로 (section, block) 박스를 찾아 `jumpToPage` + `SelectionOverlay.flash` 1.8s 페이드.
미지원 백엔드/대상 소실은 정직 토스트, 페이지 점프 링크는 폴백 유지.

## 수용 기준
- [x] AI 제안 카드 → 위치 보기 → 해당 블록 스크롤·플래시(overlay 레이어 — 렌더-0 규율 무접촉)
- [x] react vitest(flash 스케일/타페이지 미표시) — 카드 플로우는 기존 e2e가 커버, 전체 42/42
