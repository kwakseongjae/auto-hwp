# 035 — R6-2: 피그마식 팬/줌 — Space+드래그, 커서 중심 ⌘휠/핀치 줌

- 상태: **open** · 우선순위: R6-P0 · 영역: packages/react (HwpWorkspace 뷰포트 영역) + styles
- 병렬: 034(HwpPageView/refresh 경로 소유 — **이 이슈는 그 파일/경로 금지**)

## 사용자 북극성 (033 카탈로그)
피그마 필수 제스처가 없다: Space+드래그 팬(grab 커서), ⌘/Ctrl+휠 = **커서 중심** 줌,
맥 트랙패드 핀치(ctrlKey 붙은 wheel), ⌘+/⌘-/⌘0(100%) 키. 현재 줌은 툴바 버튼뿐이고
줌 스텝 리플로우 50.5ms(033 실측).

## 목표
- **Space 홀드+드래그 = 팬**(커서 grab/grabbing; Space 중 선택/마퀴 비활성 — 편집 중이면 무시).
- **⌘/Ctrl+휠·핀치 = 줌**, **커서 아래 문서 지점이 고정**되는 줌(피그마 시맨틱). 범위 25%~400%.
- ⌘+/⌘-(스텝), ⌘0(100%), 기존 툴바 줌과 상태 일원화.
- 줌 중 성능: 연속 줌은 CSS transform(scale)로 즉시 반응 → 정지 후(debounce ~150ms) 실 스케일
  재렌더로 정착(50ms 리플로우를 제스처 중 매 틱 내지 않기). 정착 후 선택 오버레이/툴바 위치 재계산.

## 구현 단계
1. 뷰포트 상태 정리: zoom + scroll 컨테이너 파악(현재 구조 실측) → panBy/zoomAt(clientX,Y,factor)
   유틸(순수 함수 + 단위 테스트: 커서 고정점 수학 — zoom 후 scrollLeft/Top 보정식).
2. 이벤트: window keydown/up(Space — 입력/에디터 포커스 중 제외), wheel(ctrlKey/metaKey →
   preventDefault+zoomAt; 일반 휠은 스크롤 유지), pointer drag 팬. IME/에디터/툴바와 경합 금지.
3. 연속 줌 최적화: 제스처 중 CSS transform, 정지 후 실 zoom 커밋(한 번의 재렌더). 034의
   문자열-비교 스킵과 자연 합치(줌은 svg 불변 — scale만 변경이면 재주입 0이 이상적; 현 구조가
   zoom을 svg 재생성에 쓰는지 실측 후 최선 선택, 근거 보고).
4. 테스트: zoomAt 수학 단위테스트(고정점 오차<1px, 클램프), Space 팬 상태 전이(에디터 열림 중
   무시), e2e 1: ⌘휠 줌 → 커서 지점 문서 좌표 고정 assert(±2px) + Space 드래그 → scroll 변화.
5. 커서: Space 홀드 grab, 드래그 중 grabbing(030의 default와 공존).

## 수용 기준
- [ ] Space+드래그 팬, ⌘/Ctrl휠·핀치 커서 중심 줌(고정점 e2e ±2px), ⌘+/-/0, 25~400% 클램프
- [ ] 연속 줌이 매 틱 재렌더를 내지 않음(계측/근거) — 정착 시 1회
- [ ] zoomAt 순수 함수+단위테스트, 기존 vitest·e2e 전부 그린(032 편집·028 툴바·031 리사이즈 무회귀)
- [ ] 034 소유 파일/경로 무접촉, 엔진 무접촉, 언스테이지 0

## 함정
- wheel 리스너는 passive:false 필요(⌘휠 preventDefault) — 스크롤 컨테이너에만 부착.
- 줌 정착 시 선택 마킹/플로팅 툴바/리사이즈 그립이 새 scale로 재배치되는지(기존 scale 소스
  일원화 확인 — 새 산술 금지).
- Space는 텍스트 입력(제자리 에디터/채팅 컴포저) 포커스 중엔 절대 가로채지 않기.
