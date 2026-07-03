# 031 — R5-2: 열너비/행높이 변경 신뢰성 — "성공 토스트인데 무반영" 버그

- 상태: **open** · 우선순위: **R5-P0** (기능이 거짓 성공 중) · 영역: editor-core(units)/react
  (ColumnResizeOverlay)/e2e (+필요 시 wasm/엔진 조사)
- 병렬: 030(useHwpEditor/HwpPageView/styles 소유 — **이 이슈는 그 파일들 금지**), 033(docs)
- **파일 소유권**: editor-core units.ts·edit.ts, ColumnResizeOverlay.tsx, HwpWorkspace의
  onColCommit/리사이즈 배선 함수만, e2e editing 스펙, (조사 결과에 따라) 엔진 검증 스크립트.

## 사용자 QA 관찰
"열 너비 변경을 시도했는데, **열 너비는 변경되지 않고 변경 완료 토스트가 뜨는 경우가
압도적**." 표 선택/행너비 변경도 부자연.

## 아키텍트 진단 (출발점)
- **e2e의 구멍 확정**: editing-027의 열너비 시나리오는 "핸들 드래그 → intent 발사"까지만
  검증하고 **렌더된 경계가 실제로 이동했는지 assert하지 않는다** — 그래서 무반영 버그가
  통과했다. 이 이슈의 수용 기준은 "시각 변화 assert"다.
- 유력 기전 후보(순서대로 기각/채택하고 기록):
  (a) `widthsToRatios`의 정수화가 델타 붕괴 — SetTableColWidths는 `Vec<i32>` 상대값인데
      비슷한 픽셀 폭들이 같은 정수 비율로 뭉개지면 엔진 입장에선 무변경.
  (b) Outcome/캐시: 변경이 적용됐는데 wasm placed 캐시나 페이지 SVG 갱신(bumpRefresh)이
      안 타서 화면만 그대로.
  (c) 엔진 Op 자체가 특정 표(병합/분할)에서 no-op.
- **1단계는 node 재현**: 브라우저 없이 `applyIntent(SetTableColWidths)` → `renderPageSvg`
  전후 경계 x좌표 비교로 어느 층에서 끊기는지 특정하라(엔진이 정상인데 UI만 문제인지,
  ratios가 문제인지). 이 재현 스크립트는 tracked 벤치/스모크로 남겨라.

## 목표
열너비 드래그가 **실제로 반영**되고(렌더 경계 이동), 실패 시엔 실패로 알린다(거짓 성공 금지).
행높이 드래그(SetTableRowHeights)도 같은 신뢰성으로 추가. 표 선택/핸들 어포던스 개선.

## 구현 단계
1. **node 재현·기전 특정**(위) → 보고에 층위 판정 기록.
2. **수정**: 특정된 기전만. (a)면 ratios 정밀도(예: 합 10000 스케일 정수) — INTENT-SCHEMA의
   widths 의미 재확인 후 발명 없이; (b)면 커밋 경로에서 refresh/캐시 일관화; (c)면 엔진 이슈로
   분리 보고(이 이슈는 UI까지). **적용 결과를 커밋 후 재조회로 검증해 불일치면 에러 토스트**
   (거짓 성공 원천 차단 — "적용 확인" 패턴).
3. **행높이 드래그**: 행 경계 핸들(hw-row-grip) + SetTableRowHeights — 열과 동일 패턴
   (프리뷰→커밋→검증). 단위: INTENT-SCHEMA 확인(행 최소높이 오버라이드).
4. **어포던스**: 표 hover 시 그립 가시화(현재 발견성 낮음), 그립 히트영역 확대(≥8px),
   드래그 중 가이드라인 표시.
5. **e2e 강화**: 열·행 각각 "드래그 → **렌더된 경계/행높이가 실제로 K px 이상 이동**"을
   SVG 좌표로 assert(그립 위치 재조회 or SVG line x 비교). 실패했던 기존 방식(intent만 확인)
   금지. 기존 시나리오 전부 무회귀.

## 수용 기준
- [ ] node 재현 스크립트(tracked) + 기전 판정 기록(a/b/c 중 무엇이었나)
- [ ] 열너비 드래그가 렌더에 반영 — e2e가 **경계 이동 px를 assert**
- [ ] 적용-확인 패턴: 커밋 후 재조회 불일치 시 에러 토스트(거짓 성공 0)
- [ ] 행높이 드래그 동일 패턴+e2e, 그립 어포던스(호버 가시화·히트영역)
- [ ] 게이트 2종 유지, vitest·Playwright 전부 그린, 030 소유 파일 무접촉

## 함정
- 분할표: 경계는 페이지-로컬, 행 인덱스는 전역(first_row) — 023 규칙.
- SetTableRowHeights 0=content-sized 시맨틱(INTENT-SCHEMA) — 드래그로 0 이하 방지.
- HwpWorkspace 수정은 리사이즈 배선 함수 내부로 한정(030과 충돌 방지).
