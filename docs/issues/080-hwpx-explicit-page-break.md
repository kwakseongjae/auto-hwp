# 080 — HWPX 명시적 쪽 나누기(`pageBreak`) 보존

- 상태: **root-cause-complete / implementation-open** (2026-07-28)
- 우선순위: P1 (한컴 저작 HWPX 쪽수)
- 영역: `hwp-hwpx` + `hwp-typeset` 3경로(`NaiveLayout`/`place_doc`/`block_pages`)

## 발견

한컴 저작 HWPX 5종을 production parser로 재측정하자 4종은 한컴 쪽수와 정확히 같고,
`bizinfo-mss__붙임1`만 우리 24 vs 한컴 25였다. 해당 section에는 `<hp:p pageBreak="1">`이 8개
있지만 `ParaAccum`이 속성을 읽지 않아 전부 사라진다. 셀 lineseg는 1200/1208 exact(99.3%),
±1 100%이고 총 줄수도 1250==1250이므로 이 1쪽은 줄바꿈 문제가 아니다.

## 단순 필드 복사가 위험한 이유

일반 문단은 `Paragraph.page_break_before`로 바로 매핑할 수 있다. 그러나 8개 중 1개는 표를 품은
호스트 문단이다. HWPX parser의 round-trip moat 때문에 IR 블록 순서는 `[Table, host Paragraph]`이고
호스트는 `is_table_anchor=true`라 높이를 예약하지 않는다. 여기에 flag만 복사하면 break가 표 **앞**이
아니라 표 **뒤**에 걸린다.

## 결정

1. parser는 `pageBreak="1"`을 per-instance 값으로 캡처한다.
2. 일반 문단은 기존 `Paragraph.page_break_before`를 사용한다.
3. `[Table, page-break host anchor]` 쌍은 원본 블록/source-span 순서를 바꾸거나 synthetic 문단을
   직렬화 모델에 넣지 않는다. 조판기가 이 쌍을 하나의 “표 앞 break”로 해석한다.
4. 판정 helper 하나를 세 경로가 공유해 LOCKSTEP을 구조적으로 고정한다. anchor 자체에서는 같은 break를
   다시 실행하지 않는다.

## 수용 기준

- [ ] 일반 문단과 table-host 문단 fixture가 각각 break 위치를 잠근다.
- [ ] `NaiveLayout`·`place_doc`·`block_pages`의 페이지/시작 페이지가 동일하다.
- [ ] 무편집 HWPX section XML과 table/paragraph source span이 byte-verbatim으로 보존된다.
- [ ] `bizinfo-mss__붙임1` 24→25로 한컴과 일치한다.
- [ ] benchmark 8==8 / 18==18 / 24==24, 셀 lineseg, HWPX parity가 불변이다.
