# 037 — R7-1: 페이지 가상화 — 뷰포트 밖 시트는 높이만 남기고 언마운트 (FG-01)

- 상태: **open** · 우선순위: **R7-P0** (FG 백로그 잔여 중 유일 P0) · 영역: packages/react (HwpPageView 소유)
- 병렬: 038(HoverLayer/HwpWorkspace/styles 소유 — **이 이슈는 그 파일 금지**). HwpPageView.tsx는 이 이슈의 단독 소유.

## 실측 근거 (033, scripts/figma-grade/measure-browser.mjs)
25p 문서에서 `.hw-sheet` 25개 전부 마운트 = **19,825 DOM 요소**. 스크롤·줌·리플로우가 전 페이지
DOM을 끌고 다닌다(줌 1스텝 reflow 50.5ms의 주요인). 가상화 로직 0 (grep).

## 목표
뷰포트 근처(±버퍼) 페이지만 SVG를 유지하고, 밖의 페이지는 **동일 크기의 빈 시트(placeholder)**로
남긴다. 25p 기준 마운트 SVG ≤ 6장, DOM 요소 수 대폭 감소(실측 재측정으로 증명). 스크롤 재진입 시
즉시 복원. 선택/편집/줌/선택적 갱신(034) 전부 무회귀.

## 설계
- IntersectionObserver: root=`.hw-canvas`(스크롤 컨테이너), target=각 `.hw-sheet-wrap`,
  rootMargin으로 위아래 1~2페이지 버퍼. 관찰 상태를 per-page visible set으로.
- placeholder는 **줌 반영된 실제 페이지 크기**(vbW/vbH × scale)를 유지해 스크롤 지오메트리를
  보존한다 — 034의 rawCache에 viewBox가 이미 있으므로 언마운트 후에도 크기를 안다.
- **034와의 정합(중요)**: refresh 시 raw svg fetch+문자열 비교는 전 페이지 유지(엔진 15.6ms/25p로
  저렴, 캐시 일관성 보존)하되, sanitize+주입은 **visible ∩ changed**만. 밖에서 변한 페이지는
  dirty 마크만 남기고, 재진입 시 주입. `__hwPageInject` 카운터 의미는 "실제 주입"으로 불변.
- **035와의 정합**: 연속 줌 CSS transform 중에는 observer 재평가에 의존하지 말고, settle
  (실 zoom 커밋) 후 관찰이 자연 갱신되는지 확인. placeholder 높이는 zoom을 곱해 유지.
- **036 scrollCellIntoView**: 언마운트 페이지에는 svg가 없다 — HwpPageView가 placeholder에도
  `data-page`+정확한 크기를 유지하므로 시트 rect 기반으로 폴백(스크롤 후 마운트가 따라온다).
  HwpWorkspace 수정 없이 되는지 실측하고, 안 되면 폴백을 시트 rect로 읽게 HwpPageView 쪽
  DOM 계약(placeholder 크기)을 지켜라 — HwpWorkspace 파일 접촉은 금지(038 소유).

## 구현 단계
1. BEFORE 실측: measure-browser.mjs(or 신규 measure-virtualization-037.mjs)로 25p DOM 요소 수·
   마운트 시트 수 캡처.
2. HwpPageView에 visible set(IntersectionObserver) + placeholder 렌더 경로. jsdom에는 IO가
   없으므로 폴백(전부 visible)을 두고 vitest는 mock IO로.
3. 034 refresh 경로에 visible 게이트(위 설계) + dirty 재진입 주입.
4. AFTER 실측 + 테스트: vitest(가시 페이지만 주입/재진입 시 dirty 주입/placeholder 크기),
   e2e 1개(25p 열기 → 마지막 페이지 svg 없음 assert → 스크롤 → svg 마운트 + 내용 정상).
5. 무회귀: 기존 vitest 103·e2e 12(선택/편집/줌/팬/키내비), 030 dragPerf, 034 선택적 갱신 테스트.

## 수용 기준
- [ ] 25p에서 마운트 SVG 시트 ≤ 6(버퍼 포함), DOM 요소 수 BEFORE/AFTER 수치
- [ ] 스크롤 재진입 복원 + 밖에서 변한 페이지 재진입 시 주입(dirty) — vitest+e2e
- [ ] 034/035/036 전부 무회귀(기존 스위트 그린), 엔진 무접촉, 언스테이지 0
- [ ] placeholder가 줌 변화에도 정확한 크기 유지(스크롤 점프 없음)

## 함정
- sanitize/주입을 visible로 게이트하되 rawCache 비교는 전 페이지 유지 — 캐시를 visible로만
  좁히면 재진입 때 "변경 없음"을 오판한다.
- e2e/vitest 전 패키지 빌드 순서 editor-core→ai-protocol→react, 그리고 **apps/hwp-lab에서
  `rm -rf .next` 필수**(웹팩 캐시가 dist 변경 미감지 — 검증된 함정).
- IntersectionObserver 콜백에서 setState 폭풍 금지 — visible set은 배치 갱신(한 콜백 한 커밋).
