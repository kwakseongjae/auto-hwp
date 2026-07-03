# 023 — R2-1: 웹 셀 단위 마킹 (데스크톱 패리티) + 셀 텍스트 스니펫 라벨

- 상태: **open**
- 우선순위: R2-P0 (라운드 2) — 바이브편집 정밀도의 본체
- 영역: hwp-wasm + packages/engine + packages/react + apps/hwp-lab (엔진 로직 신규 없음 — 노출/배선)
- 선행: 021, 022 (done). 병렬 가능: 013 (파일 disjoint — 013은 hwp-mcp/ingest/Docker만)

## 배경
데스크톱은 셀 단위 앵커("1-2. 제품·서비스의 개…" 같은 셀 텍스트 스니펫 칩)로 정밀 마킹이
되는데, **웹은 표 단위**가 한계다(016 v1 기록: wasm이 tableCellAt을 노출하지 않아서).
그런데 022 이후 상황이 바뀌었다: **hwp-session에 이미 다 있다** —
`table_cell_at(doc, page, x, y) -> CellHitDto`(lib.rs:477), `table_cell_box`(:517),
그리고 `*_with(injected fonts)` 메트릭 변형까지. 이 이슈는 노출과 UI 배선이다.

## 목표
웹에서 표 안을 클릭하면 **그 셀이 앵커**가 되고(칩 라벨 = 셀 텍스트 스니펫), ⌘/Ctrl로
셀들을 누적 토글, 마퀴는 기존대로 블록 단위. LLM/mock이 앵커의 rows/cols를 그대로 겨냥.

## 파일 지도
- `crates/hwp-wasm/src/lib.rs` — `tableCellAt(page,x,y)` 바인딩(미적중=null; **주입 메트릭
  `_with` 변형 사용** — 022가 render/hit_test에 한 것과 동일하게 셀 히트도 폰트 주입 페이지네이션과
  일치해야 함), 필요 시 `cellText(section, index, row, col)` (스니펫용 — hwp-session의 기존
  헬퍼(block_runs 또는 model_cell_text 상당)를 실측해 재사용, 새 로직 발명 금지)
- `packages/engine/index.js` / `index.d.ts` — 래퍼(null 정규화)+타입
- `packages/react/src/EngineAdapter.ts` — `tableCellAt?`(옵셔널) (+`cellText?`)
- `packages/react/src/components/HwpPageView.tsx`/`HwpWorkspace.tsx` — 클릭 해석: 표 내부 히트면
  **셀 앵커**(kind:"cell", rows:[r,r], cols:[c,c]) 생성; 021의 교체/⌘토글 모델 그대로 적용
- `apps/hwp-lab/src/app/api/hwp-edit/route.ts` — mockIntents가 cell 앵커의 rows/cols를 겨냥
  (지금은 row:0/col:0 고정 — 앵커 좌표 사용으로 수정; live SYSTEM_PROMPT는 이미 앵커 좌표 지시)
- `apps/hwp-lab/e2e/smoke.spec.ts` — 셀 마킹 시나리오 반영
- 테스트: react vitest(셀 앵커 파생/토글), 필요 시 wasm node 스모크

## 좌표계 계약 (§4.1-5 + 데스크톱 검증된 규칙 — 어기면 실패)
- `tableCellAt` 입력 = **페이지-로컬 px**. 반환 CellHitDto의 row/col은 **모델 전역 좌표**다
  (PlacedCell.row — 분할표에서도 이미 전역; 데스크톱 activeCell과 동일). **first_row를 다시
  더하지 마라**(이중가산 — 009에서 확정한 규칙). 범위(cellRange류)를 만들 때만 fragment-local
  +first_row 보정이 필요하다 — 이 이슈 v1은 단일 셀 앵커라 해당 없음.
- 셀 앵커의 rows/cols는 구조 좌표(0-기반) — 라벨은 1-기반 표기("3행 2열") + 텍스트 스니펫.

## 구현 단계
1. **실측 먼저**: hwp-session의 CellHitDto 필드(전역/로컬 여부 주석 포함)와 셀 텍스트 헬퍼
   존재를 읽고 보고에 기록. 스니펫 헬퍼가 세션에 없으면 block_runs(row,col) 텍스트 join으로
   래핑(엔진 수정 없이 wasm 레이어에서 조합 가능하면 그쪽 우선).
2. **wasm 바인딩**: tableCellAt(+cellText) — 018 null 폴리시(미적중 = None→null), `_with` 메트릭.
   재번들(015 레시피), pkg/ 스테이지 금지.
3. **react 배선**: 클릭 히트 우선순위 = 셀 > 블록. 셀 앵커 칩 라벨 = `"{스니펫…}" (N행 M열)`
   (스니펫 12자 내외 말줄임, 빈 셀이면 "표 N행 M열"). ⌘토글은 셀 동일성(section/block/rows/cols)
   기준. 마퀴는 021 그대로 블록 단위(셀 마퀴는 스코프 밖 — 문서화).
4. **mock/lab**: mockIntents가 `a.rows?.[0] ?? 0`/`a.cols?.[0] ?? 0` 겨냥. Playwright 갱신:
   표 클릭 → 칩 라벨에 "행"이 포함되고, mock 편집이 **클릭한 그 셀**의 텍스트를 바꾸는지
   (before/after SVG의 해당 텍스트로 assert 가능하면 강하게, 아니면 렌더 변화+라벨 검증).
5. **테스트**: vitest — 셀 앵커 파생(전역좌표 보존)/⌘셀 토글/셀·블록 혼합 선택 2~3 시나리오
   추가; 기존 무회귀. 게이트 2종(8==8, 18==18) — 레이아웃 무접촉 확인용.

## 수용 기준
- [ ] 웹에서 표 클릭 = 셀 앵커(전역 좌표, first_row 이중가산 없음 — 분할표 조각에서 검증)
- [ ] 칩 라벨 = 셀 텍스트 스니펫 + N행 M열 (빈 셀 폴백)
- [ ] ⌘/Ctrl 셀 토글 + 셀·블록 혼합 선택 동작, 마퀴는 블록 단위 유지
- [ ] mock/live 편집이 앵커 셀 좌표를 정확히 겨냥 (Playwright로 "클릭한 셀이 바뀜" 검증)
- [ ] tableCellAt이 주입 폰트 메트릭과 일치(_with) + 미적중 null
- [ ] vitest 신규 시나리오 + 기존 전부 그린, Playwright 갱신 통과, 게이트 2종 유지
- [ ] 기존 크레이트는 hwp-wasm 추가만(hwp-session 무수정이 이상적 — 수정 필요 시 추가만+사유)

## 함정
- 분할표(benchmark1의 페이지 걸친 표) 2페이지 조각 클릭 시 row가 전역인지 반드시 수동/e2e로
  확인 — 이 이슈의 1순위 예상 버그(009 데스크톱에서 이미 밟은 지뢰).
- 셀 히트가 실패하는 지점(표 테두리/병합 셀 경계)에서는 블록 앵커로 자연 폴백 — 에러 금지.
- cellText는 표시용이다 — 오라클/직렬화에 영향 주는 경로에 손대지 마라.
