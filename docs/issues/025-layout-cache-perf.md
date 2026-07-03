# 025 — R3-2: 인터랙션 성능 — 레이아웃 캐시 (클릭/드래그 딜레이 제거)

- 상태: **open**
- 우선순위: **R3-P0** (사용자 QA: "선택/선택취소/드래그 딜레이 엄청")
- 영역: hwp-wasm(캐시 보유) + hwp-session(placed 재사용 API) + packages/react(호출 빈도)
- 선행: 023 (done). 병렬 가능: 024 (파일 disjoint — 024는 lift/typeset/render 내부)

## 아키텍트 진단 (원인 확정적)
모든 지오메트리 질의(`own_hit_test_with`/`table_cell_at_with`/`table_at_with`/`blocks_in_rect_with`)와
`render_svg_with`가 **호출마다 `place_doc`으로 문서 전체를 재조판**한다(hwp-session은 순수 함수
설계라 상태가 없음). 18페이지 문서에서 클릭 한 번 = 전체 재조판 1회, 마퀴 드래그 = 이동
이벤트마다 재조판. 이것이 딜레이의 본체다. 셰이퍼(022)가 켜지며 조판 비용도 커졌다.

## 목표
문서가 안 바뀌면 조판은 **한 번만**. 클릭→앵커 표시가 체감 즉시(수 ms 지오메트리 조회)가
되도록: wasm `HwpDoc`이 `PlacedDoc`(+사용 폰트 지문)을 캐시하고, 편집/undo/redo/registerFont
시에만 무효화한다. hwp-session의 순수성은 유지하되 **placed를 받아 쓰는 변형**을 추가한다.

## 파일 지도
- `crates/hwp-session/src/lib.rs` — placed-재사용 API 추가(기존 함수 무수정·위임):
  `pub fn place(doc, injected) -> PlacedDoc` + 기존 각 질의의 `*_placed(&PlacedDoc, ...)` 변형
  (내부적으로 기존 `*_with`가 `place()+*_placed()` 위임으로 재구성 — 로직 복제 금지)
- `crates/hwp-wasm/src/lib.rs` — `HwpDoc`에 `placed: Option<PlacedDoc>` 캐시 + 무효화 지점
  (applyIntent 성공/undo/redo/registerFont/open) + 모든 질의·renderPageSvg가 캐시 사용
- `packages/react` — 호출 빈도 절감: pointermove 중 지오메트리 호출 없음 확인(마퀴는 로컬
  사각형만, blocksInRect는 pointerup 1회), 필요 시 rAF 스로틀. 렌더된 페이지 SVG 캐시(페이지별,
  세대 카운터로 무효화)로 편집 후 미변경 페이지 재렌더 회피.
- 벤치: `packages/engine` node 스크립트로 before/after 수치(open 후 연속 hitTest 100회 시간,
  renderPageSvg 재호출 시간) — 보고서에 수치 필수.

## 구현 단계
1. **hwp-session placed API**: `PlacedDoc`(hwp-typeset 공개 타입) 재사용 표면 추가. 기존
   `*_with`는 위임으로 재구성 — **네이티브 골든**: own-render/export-pdf/layout-check 바이트·수치
   불변(020/022 규율, 해시 비교).
2. **wasm 캐시**: `fn placed(&mut self) -> &PlacedDoc` (없으면 place 후 저장; 폰트 지문
   (family,len) 벡터가 바뀌면 재생성). 무효화: applyIntent가 Outcome=edited일 때만(조회성
   intent는 유지), undo/redo true일 때, registerFont, open. renderPageSvg도 캐시 placed에서.
3. **react 빈도 절감**: 코드 실측 후 pointermove 경로에 어댑터 호출이 있으면 제거/이동.
   페이지 SVG 메모(세대 기반). 과설계 금지 — 측정으로 정당화되는 것만.
4. **벤치 실측**: benchmark1(18p)에서 (a) 연속 hitTest 100회 (b) 편집 1회 후 renderPageSvg
   1페이지 — before/after ms. 목표: (a) 100배급 개선(재조판 제거), (b) 편집 페이지만 비용.
5. **동작 불변 증명**: 캐시 on/off 결과 동일성 테스트(같은 좌표 질의 결과·같은 SVG 바이트),
   기존 e2e(Playwright 2종 + 셀 마킹) 그대로 통과.

## 수용 기준
- [ ] 문서 불변 시 place_doc 호출 1회(캐시 히트 — 카운터/로그로 증명)
- [ ] node 벤치 before/after 수치 보고 (100회 hitTest, 편집 후 재렌더)
- [ ] 캐시 결과 == 비캐시 결과 (동일성 테스트) + 무효화 5지점(edit/undo/redo/font/open) 테스트
- [ ] 네이티브 골든 바이트 불변 + 게이트 v2 유지 + 기존 테스트/e2e 전부 그린
- [ ] hwp-session 기존 함수 시그니처 무변경(추가·위임만)

## 함정
- PlacedDoc이 Clone/보관 가능한지 실측 — 수명 문제로 어렵다면 wasm 쪽에서 `Box<PlacedDoc>`
  소유 구조로. 절대 unsafe/자기참조 꼼수 금지.
- 조회성 intent(HitTest/CaretRect/PageCount 등)로 캐시를 무효화하지 마라 — Outcome 종류로 분기.
- registerFont는 **메트릭이 바뀌므로 반드시 무효화**(022 재조판 계약과 정합).
- react 페이지 SVG 메모는 편집된 페이지 식별이 필요 — v1은 "편집 발생 시 전 페이지 무효화 +
  wasm 캐시 덕에 재렌더 저렴"으로 충분하면 그걸로(과설계 금지, 수치로 판단).
