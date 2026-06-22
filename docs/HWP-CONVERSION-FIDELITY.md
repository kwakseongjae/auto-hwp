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
2. **표 행 높이 하드코딩** — `RH*rows` 고정, 행 높이 미캡처. (lift 미캡처 + model 필드 없음)
3. **셀 패딩 하드코딩** — `cellMargin 510/141` 고정, 원본 셀 여백 미캡처.
4. **셀 테두리 = 음영만** — border 스타일/색/굵기 미캡처(solid fill만).
5. **표 외곽 테두리 드롭** — table-level border_fill 미캡처.
6. **다단(multi-column) 미지원** — `PageSetup.columns` 1로 하드코딩.

### 🟠 Tier 2 (서식/간격 저하)
7. 밑줄 타입(이중/물결) → 항상 BOTTOM(synth.rs:269). 8. 장평(char width) 미캡처.
9. 자간(char spacing) 미캡처. 10. 문단 page-break-before 캡처되지만 미emit.
11. 번호/글머리표 deferred. 12/13. 밑줄/취소선 색 미emit(검정 고정).

### 🟡 Tier 3 (기능 저하)
14. 외부(링크) 이미지 드롭. 15. 이미지 crop/rotation. 16. 도형(textbox/line/rect) 미캡처.
17. HYPERLINK 외 필드 타입 스킵(텍스트는 보존). 18. 북마크 미캡처.

## 진행
- **F1 ✅** 표 열 너비 (commit be949de).
- **F2 (다음)** 표 행 높이 + 셀 패딩 + 셀/표 테두리 — lift.rs가 rhwp Cell.padding/row heights/
  border_fill style을 캡처하도록 + SemanticDoc 모델 필드 추가 + serialize 반영. (Tier 1 #2~#5)
- **F3** 장평/자간/밑줄타입/page-break-before/번호 (Tier 2).
