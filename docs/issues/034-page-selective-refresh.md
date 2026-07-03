# 034 — R6-1: 페이지 선택적 갱신 — 편집 반영 DOM 세금 107ms 제거

- 상태: **done** (8c9cc5a) · 우선순위: **R6-P0** (033 백로그 1순위) · 영역: packages/react (useHwpEditor/HwpPageView)
- 병렬: 035(HwpWorkspace 뷰포트/줌/팬 소유 — **이 이슈는 그 영역 금지**), 서로 파일 소유권 준수

## 실측 근거 (033, scripts/figma-grade/measure-browser.mjs)
편집 1회 → **전 페이지 재조회·재주입**: sanitize 28.6ms + re-inject 78.3ms ≈ **107ms** (25p 기준).
엔진은 무죄: wasm 단일 페이지 재렌더 0.1ms, 전체도 15.6ms. 코드 확정: HwpPageView.tsx:61-80이
refreshToken마다 `for p=0..pageCount` 전 페이지 재조회.

## 목표
편집 후 **바뀐 페이지만** sanitize+DOM 주입. 편집→화면 반영 DOM 세금 107ms → 단일 페이지
수준(~10ms 이하). 측정으로 증명(033 스크립트 재사용).

## 설계 (영향 페이지 계산 대신 내용 비교 — 리플로우 연쇄에도 안전)
편집이 페이지를 밀 수 있으므로(행 성장→이후 페이지 전부 이동) "영향 페이지 계산"은 취약하다.
대신: refresh 시 각 페이지의 svg **문자열을 이전 값과 비교**(String 동일성 — wasm svg 캐시
덕에 미변경 페이지는 동일 문자열이거나, 재생성이어도 memcmp는 저렴) → **다르면만**
sanitize+setState. 페이지 수 변화(증감)도 처리(추가 페이지 주입/잉여 제거).

## 구현 단계
1. **측정 먼저**: measure-browser.mjs의 edit-DOM-tax 지표로 BEFORE 캡처(재실행).
2. HwpPageView(또는 useHwpEditor)의 refresh 경로에 per-page prev-string 캐시 →
   동일 문자열이면 sanitize/setState 스킵(스킵 카운터 dev 계측 — 030 패턴, prod 트리셰이킹).
3. 페이지 수 변화 처리 + 폰트 교체(전 페이지 변경)에서도 정상(전부 재주입) 확인.
4. **AFTER 측정** + 테스트 고정: vitest — "단일 셀 편집 후 주입된 페이지 수 == 변경 페이지
   수(1~2)" (mock adapter로 페이지별 svg 지정), "폰트 교체 후 == 전체". e2e 무회귀 전부.
5. 030 memo와의 상호작용 확인: 스킵된 페이지의 PageSheet는 렌더 자체가 없어야(카운터).

## 수용 기준
- [ ] BEFORE/AFTER edit-DOM-tax 수치(measure-browser.mjs) — 목표 ≤15ms
- [ ] vitest: 편집→변경 페이지만 주입(카운터 assert), 폰트교체→전체, 페이지수 증감 처리
- [ ] 기존 vitest 78+ / e2e 8 전부 그린, 030 dragPerf 유지, 엔진 무접촉
- [ ] 언스테이지 잔여 0

## 함정
- sanitize를 문자열 비교 **전**에 돌리면 세금 그대로다 — 비교는 raw svg 문자열로.
- undo/redo도 같은 경로(변경 페이지만) — 테스트 포함.
- 035와 병렬: HwpWorkspace의 줌/뷰포트 코드 접촉 금지(refresh 경로만).
