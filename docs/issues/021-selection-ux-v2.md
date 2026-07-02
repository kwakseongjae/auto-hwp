# 021 — QA-3·4: 선택 UX v2 — OS 스타일 (⌘/Ctrl 누적 + 러버밴드 드래그)

- 상태: **open**
- 우선순위: P1 (QA 라운드 1)
- 영역: packages/react (SelectionOverlay/HwpWorkspace) + hwp-session/hwp-wasm (지오메트리 질의 1개 추가)
- 선행: 016, 019 (done). 병렬 가능: 020 (파일 disjoint — 020은 hwp-typeset/CLI만)

## 사용자 QA 관찰 (2026-07-02, 스크린샷)
1. 지금은 문서를 클릭할 때마다 앵커 칩이 **무조건 누적**된다(스크린샷: 칩 십수 개가 쌓임).
   원하는 것: **일반 클릭 = 선택 교체(1개)**, **⌘클릭(맥)/Ctrl클릭(윈도) = 선택에 추가/토글** —
   OS 파일 선택과 동일한 멘탈 모델.
2. 표/텍스트가 **아닌 빈 영역에서 드래그 = 러버밴드(마퀴) 선택** — Finder/탐색기처럼 사각형에
   걸리는 블록들이 한꺼번에 선택되게.

## 목표
선택 모델을 OS 관례로 재정의한다:
- 클릭: 그 블록 **하나로 교체**. ⌘/Ctrl+클릭: **추가**, 이미 선택된 블록이면 **해제(토글)**.
- 빈 영역 드래그: 마퀴 사각형 표시 → 놓으면 **사각형과 교차하는 블록들이 선택**(⌘/Ctrl 유지 시
  기존 선택에 합집합).
- Esc 또는 문서 밖 클릭: 전체 해제. 칩 ✕ 개별 해제 + "모두 지우기" 버튼.
- 선택(=앵커 칩)은 채팅 전송 시 그대로 anchors 배열로 나간다(기존 계약 유지).

**UI 문구는 전부 한글** (툴팁 포함: "⌘+클릭: 선택 추가", "드래그: 영역 선택" 등 — 플랫폼 감지해
⌘/Ctrl 표기 자동 전환).

## 파일 지도
- `crates/hwp-session/src/lib.rs` — 신규 질의 `blocks_in_rect(doc, page, x0, y0, x1, y1) -> Vec<BlockHitDto>`
  (px, 페이지-로컬; 기존 own_hit_test가 쓰는 PlacedBlock 밴드를 사각형 교차로 확장 — **기존 함수
  수정 금지, 추가만**)
- `crates/hwp-wasm/src/lib.rs` — 바인딩 `blocksInRect(page, x0, y0, x1, y1): string /*JSON 배열*/`
  (미적중 = 빈 배열 — null 아님)
- `packages/engine/index.js` / `index.d.ts` — 래퍼+타입 (BlockHit[])
- `packages/react/src/EngineAdapter.ts` — `blocksInRect?` (옵셔널 — TauriAdapter는 미구현 문서화)
- `packages/react/src/components/SelectionOverlay.tsx`, `HwpWorkspace.tsx` — 선택 상태 모델 교체,
  마퀴 렌더(점선 사각형), 포인터 핸들링
- `packages/react/src/__tests__/` — 선택 모델 단위 테스트
- `apps/hwp-lab/e2e/smoke.spec.ts` — **기존 스모크가 "클릭 누적"을 전제하면 새 모델로 갱신**
  (그리드 스캔이 클릭을 여러 번 하므로 교체 모델에서도 마지막 표 앵커 1개면 통과하게)

## 구현 단계
1. **엔진 질의**: hwp-session `blocks_in_rect` — place_doc 결과의 페이지 내 블록 밴드(bbox)와
   사각형 교차 판정. 단위는 px(=HWPUNIT/75), 페이지-로컬(§4.1-5). 네이티브 단위 테스트 1개
   (benchmark.hwp 1페이지에서 전체 사각형 → 블록 n개, 좁은 사각형 → 부분집합).
2. **wasm 바인딩 + 패키지 표면**: blocksInRect(JSON 배열). d.ts/래퍼 정합.
3. **선택 상태 모델 (react)**: `selection: Anchor[]`를 단일 소스로.
   - `pointerdown`(블록 위): modifier 없으면 `[block]`으로 교체, ⌘/Ctrl(`e.metaKey||e.ctrlKey`)이면
     토글. 더블클릭/기존 편집 진입 동작은 불변.
   - `pointerdown`(빈 영역) + 이동 임계값(4px) 초과: 마퀴 시작 — 점선 사각형 오버레이(페이지별
     클리핑), `pointerup`에서 각 교차 페이지에 blocksInRect 호출 → Anchor[]로 변환(중복 제거,
     라벨은 기존 규칙), modifier에 따라 교체/합집합.
   - 페이지 경계를 넘는 마퀴: v1은 **시작한 페이지 내로 클리핑**(멀티 페이지 마퀴는 스코프 밖 —
     문서화).
   - Esc/바깥 클릭 해제, "모두 지우기" 버튼(칩 행 우측).
4. **칩 UX**: 교체 모델에 맞춰 칩 = 현재 선택의 뷰. 중복 없음. 채팅 전송 후 비우는 기존 동작 유지.
5. **테스트**: (a) vitest — mock adapter로 클릭 교체/⌘토글/마퀴 합집합/Esc 해제 4시나리오,
   (b) 기존 sanitize·mock 플로우 테스트 무회귀, (c) hwp-lab Playwright 스모크 갱신 후 통과,
   (d) 네이티브: hwp-session 단위 테스트 + 게이트 8==8(레이아웃 무변경 확인용).

## 수용 기준
- [ ] 클릭=교체 / ⌘·Ctrl+클릭=토글 / 빈 영역 드래그=마퀴 선택(교차 블록) / Esc·바깥=해제
- [ ] blocksInRect 엔진 질의 + 단위 테스트 (px·페이지-로컬 준수)
- [ ] 칩=선택 뷰 일관성(중복 0), "모두 지우기", 한글 툴팁(⌘/Ctrl 자동 표기)
- [ ] vitest 신규 4시나리오 + 기존 테스트 전부 그린, Playwright 스모크 갱신·통과
- [ ] 게이트 8==8, 기존 크레이트는 hwp-session/hwp-wasm **추가**만(수정 0)

## 함정
- SelectionOverlay의 포인터 이벤트가 페이지 SVG 위 오버레이와 경합한다 — 마퀴 시작 판정은
  "블록 히트 실패한 지점의 pointerdown"으로. 클릭(이동<임계값)과 드래그를 명확히 분기.
- blocksInRect 결과에 편집 불가 블록(이미지 등)이 섞일 수 있다 — Anchor 변환 시 기존
  kind 규칙(cell/table/paragraph)을 따르고 미지원 kind는 제외+개수 표시.
- e.metaKey는 맥, e.ctrlKey는 윈도/리눅스 — 둘 다 허용하되 툴팁 표기는 navigator 플랫폼 감지.
- wasm 재번들 필요(바인딩 추가) — 015 레시피, pkg/는 스테이지 금지.
