# 038 — R7-2: 호버 프리하이라이트 + 커서 상태 체계 (FG-09 + FG-06)

- 상태: **open** · 우선순위: R7-P1 · 영역: packages/react (신규 HoverLayer + HwpWorkspace 배선 + styles.css 소유)
- 병렬: 037(HwpPageView 소유 — **이 이슈는 HwpPageView.tsx 접촉 금지**; 포인터는 HwpPageView가
  이미 HwpWorkspace로 전달하는 onPagePointerMove 경로만 사용).

## 근거 (033 격차 카탈로그)
- FG-09: 피그마는 커서 아래 개체를 **클릭 전에** 얇은 테두리로 프리하이라이트한다. 우리는
  hover 로직 0 (grep `onMouseEnter`/hover 0) — 무엇이 선택될지 클릭해봐야 안다.
- FG-06: 커서가 상황을 안 알려준다 — text I-beam·row-resize·grab 부재(styles.css 5종 중 3종
  없음). 030이 crosshair→default 교체, 035가 grab/grabbing 추가, col-resize는 그립뿐.

## 목표
- 포인터가 셀/문단/이미지 위를 지나면 **≤1 rAF 지연**으로 해당 박스에 프리하이라이트
  (얇은 파란 외곽선, 선택 마킹과 시각 구분). 호버 중 **React 렌더 0**(030 MarqueeLayer 패턴 —
  ref 직접 DOM 변이 + dev 카운터로 증명).
- 커서 상태: 텍스트 문단 위 `text`(I-beam) · 셀/열/행 경계 근처 `col-resize`/`row-resize`(기존
  그립과 일원화) · Space 팬 `grab/grabbing`(035 유지) · 그 외 `default`. hit kind → 커서 클래스
  매핑 한 곳(순수 함수)으로.

## 설계
- 신규 `HoverLayer` 컴포넌트(030 MarqueeLayer와 동형): HwpWorkspace의 renderOverlay 또는
  캔버스 위 절대배치 레이어. pointermove는 **rAF 스로틀 + 동일 대상 dedup**(같은 (page,section,
  block,row,col)이면 스킵) 후 어댑터 지오메트리(blockAt/tableCellAt — own-render **px** 좌표,
  §4.5 준수) 재질의.
- 억제 조건: 드래그/마퀴 중 · Space 팬 모드 · 제자리 에디터 열림 · 리사이즈 그립 위 ·
  컨텍스트 비편집(editingOn off면 하이라이트만, 커서는 default).
- 커서 매핑 순수 함수 + styles.css 클래스. 경계 판정(리사이즈 커서)은 031 그립의 기존 판정
  재사용 — 새 산술 금지.

## 구현 단계
1. hit-test 비용 실측(pointermove당 wasm 질의 시간) → 스로틀 전략 근거 기록.
2. HoverLayer + useHover 훅(rAF+ref, dev 렌더 카운터) + 커서 매핑 순수 함수(단위테스트).
3. HwpWorkspace 배선(onPagePointerMove 경유, 억제 조건 게이트) + styles.css 커서/하이라이트.
4. 테스트: vitest(억제 조건·dedup·커서 매핑·호버 중 렌더 0 카운터), e2e 1개(셀 위 호버 →
   하이라이트 박스 존재+위치 근사, 문단 위 → I-beam 클래스).
5. 무회귀: 030 dragPerf(호버가 드래그 성능을 해치지 않는지 30-move 카운터 재확인) 포함 전부.

## 수용 기준
- [ ] 호버 프리하이라이트 ≤1 rAF, 호버 중 시트/워크스페이스 렌더 0(계측 수치)
- [ ] 커서: text/col-resize/row-resize/grab/default 전환 — vitest+e2e
- [ ] 억제 조건(드래그·팬·에디터·그립) 전부 동작, 기존 스위트 전부 그린
- [ ] HwpPageView.tsx 무접촉(037 소유), 엔진 무접촉, 언스테이지 0

## 함정
- pointermove마다 async 질의를 쌓지 마라 — in-flight 1개+최신 좌표만(낡은 응답 폐기, 레이스).
- 037이 페이지를 언마운트할 수 있다 — 하이라이트 대상 페이지가 사라지면 하이라이트도 제거
  (visible 이벤트에 의존하지 말고 다음 pointermove에서 자연 소거되는 구조로).
- e2e 전 패키지 빌드 순서 + **apps/hwp-lab `rm -rf .next` 필수**(웹팩 캐시 함정).
