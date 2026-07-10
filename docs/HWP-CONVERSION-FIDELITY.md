# HWP5 → HWPX 변환 충실도 (Track A)

`.hwp`(HW5)를 열고 **편집하면** 렌더가 rhwp 네이티브(.hwp) → 우리 변환본(serialized HWPX)으로
바뀌면서 레이아웃이 무너지는 문제를 닫는 작업. 파이프라인:

```
.hwp → rhwp parse → hwp-rhwp/src/lift.rs (→ SemanticDoc) → hwp-hwpx/src/{serialize,synth}.rs → HWPX
```

핵심 구조적 한계: native-HWPX는 `provenance.raw` + paragraph `source.span` 으로 **바이트 보존**
round-trip이지만, **.hwp lift는 passthrough가 전혀 없어** 모든 걸 AST에서 재합성해야 함 →
lift에서 안 담거나 serialize에서 버린 정보는 영구 손실.

## 랭킹된 갭 (Explore 진단, 2026-06-22)

### 🔴 Tier 1 (문서가 눈에 띄게 틀림)
1. **표 열 너비 무시** — lift는 `col_widths` 캡처(lift.rs:354)하는데 serialize가 무시하고 균등(W/cols) 하드코딩. → ✅ **F1 완료** (serialize.rs emit_table가 col_widths 사용; 복학원서.hwp 검증, 오라클 OPEN).
2. **표 행 높이 하드코딩** — → ✅ **F2 완료** (054): 020이 lift한 stored 행높이(`Table::row_heights`)를 `<hp:cellSz>`로 실값 재방출. row-span 셀은 `span×min(행높이)`로 방출해 재lift(균등분배 floor)가 **멱등** — 왕복 후 floor 동일(테스트 잠금).
3. **셀 패딩 하드코딩** — → ✅ **F2 완료**: `Cell::padding`(셀 고유, `apply_inner_margin` 반영 → `hasMargin`+`cellMargin`) + `Table::padding`(표 기본 → `inMargin`) 실값 lift+재방출.
4. **셀 테두리 = 음영만** — → ✅ **F2 완료**: 렌더용으로 lift돼 있던 `Cell::borders`(스타일/색/두께)를 borderFill로 충실 합성(`synthesize_border_fill_full` — 4변 type/width/color patch + fill, #003 dedup 재사용).
5. **표 외곽 테두리 드롭** — → ✅ **F2 완료**: `Table::borders`(표 borderFill 4변) lift + `<hp:tbl borderFillIDRef>` 합성 참조. 표 바깥 여백 L/R(`outer_margin_left/right`)도 캡처·재방출(`outMargin` 실값).
6. **다단(multi-column) 미지원** — `PageSetup.columns` 1로 하드코딩. (F3)

**F2 보류/근사 (정직 기록)**: ① 테두리 두께는 모델이 렌더 지향 px(0.5px hairline floor)로 보관해
0.1mm↔0.12mm가 재방출 시 0.12mm로 수렴(시각 동일 hairline; rhwp의 HWPX 두께 파싱 자체도 coarse).
② 대각선(slash/backSlash)은 렌더는 되지만 HWPX 재방출은 아직 안 함. ③ `cellSpacing`은 rhwp가 주지만
관행상 0이라 미캡처. ④ 표 바깥 여백 4방향 all-zero인 표는 "미캡처"와 구분 불가 → 레거시 283 방출(근사).
⑤ 이색 선 스타일(wave/3D/dash-dot 계열)은 lift에서 이미 Solid로 수렴 — 재방출도 SOLID(렌더와 동일 정직성).

### 🟠 Tier 2 (서식/간격 저하)
7. 밑줄 타입(이중/물결) → 항상 BOTTOM(synth.rs). 8/9. 장평/자간 — → ✅ **emit 완료** (054가 선반영:
lift는 이미 캡처, `synthesize_char_pr`가 `<hh:ratio>/<hh:spacing>` per-script 실값 patch — 무편집 왕복
페이지 수 보존의 필요조건이었음). 10. 문단 page-break-before — → ✅ **emit 완료** (054 선반영: `hp:p
pageBreak` + 앵커 생략 시 표 래퍼로 이관 — 강제 쪽나누기 8개 중 7개가 드롭되던 왕복 증상의 주원인).
11. 번호/글머리표 deferred. 12/13. 밑줄/취소선 색 미emit(검정 고정).

### 🟡 Tier 3 (기능 저하)
14. 외부(링크) 이미지 드롭. 15. 이미지 crop/rotation. 16. 도형(textbox/line/rect) 미캡처.
17. HYPERLINK 외 필드 타입 스킵(텍스트는 보존). 18. 북마크 미캡처.

## 진행
- **F1 ✅** 표 열 너비 (commit be949de).
- **F2 ✅** (054) 표 행 높이 + 셀 패딩 + 셀/표 테두리 실값 lift+재방출 (Tier 1 #2~#5) + 왕복 안정화
  일괄: 셀 문단 paraPr 실참조(기존엔 base ref 하드코딩 → 표 내용 높이 왜곡), 표 앵커 빈 문단 방출
  생략(왕복마다 표당 빈 줄 증식), Skeleton 스텁에 첫 블록 병합(구역당 빈 첫 줄 + 선두 쪽나누기 오발),
  Tier-2 #8/#9/#10 emit 절반 선반영. **무편집 .hwp 왕복 재열기 페이지 수 보존 달성**: benchmark 8→8,
  benchmark1 18→18, benchmark2 25→25 (Rust 골든: `crates/hwp-rhwp/tests/roundtrip_pages.rs` — 저장
  행높이 floor 왕복 멱등성 포함). 020 stored floor와의 관계 = **보완**(같은 `Table::row_heights` 단일
  소스를 재방출; `apply_row_overrides`/조판 무접촉 — 게이트 8==8·18==18 불변).
- **F3** 다단/밑줄타입/번호/밑줄·취소선 색/대각선 재방출 (Tier 2 잔여 + F2 보류 항목).
