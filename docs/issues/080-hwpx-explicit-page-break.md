# 080 — HWPX 명시적 쪽 나누기(`pageBreak`) 보존

- 상태: **구현 완료 · 실측 그린** (2026-07-30) — 아래 “구현 결과” 절 참조
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

- [x] 일반 문단과 table-host 문단 fixture가 각각 break 위치를 잠근다.
      (`parse.rs`: `paragraph_page_break_attribute_is_captured` / `table_host_anchor_carries_its_page_break`)
- [x] `NaiveLayout`·`place_doc`·`block_pages`의 페이지/시작 페이지가 동일하다.
      (`place.rs`: `anchor_page_break_hoists_to_its_table_in_all_three_paginators` — 한 테스트가 3경로를 함께 잠근다)
- [x] 무편집 HWPX section XML과 table/paragraph source span이 byte-verbatim으로 보존된다.
      (파서는 IR 플래그만 세우고 스팬/순서를 안 건드린다 — 기존 verbatim 골든 + `equation_enrichment_keeps_the_noedit_roundtrip_verbatim`)
- [x] `bizinfo-mss__붙임1` 24→25로 한컴과 일치한다. (**단, 아래 “두 번째 축” 없이는 26** — 실측 근거 포함)
- [x] benchmark 8==8 / 18==18 / 24==24 / modu 6==6, benchmark1.hwpx 22·줄수 바닥, 셀 lineseg 5/5·9/9 전부 불변.

## 구현 결과 (2026-07-30 실측)

### ① 쪽 나누기 축 (확정 설계 그대로)

- `hwp-hwpx/src/parse.rs` — `ParaAccum.page_break` 로 `<hp:p pageBreak>` 를 per-instance 캡처해
  **모든** 문단(표 호스트 앵커 포함)의 `Paragraph::page_break_before` 에 싣는다. 블록 순서·소스 스팬은
  손대지 않는다.
- `hwp-typeset/src/lib.rs` — `pub fn section_page_breaks(sec, doc) -> Vec<bool>` **하나**가 블록별
  강제 개쪽을 판정하고, `NaiveLayout`·`place_doc`·`block_pages` 셋이 그것만 읽는다(LOCKSTEP을 구조로
  고정 — 세 곳에 같은 조건식을 적는 형태를 제거했다). 표 호스트 앵커의 break 는
  **소스 스팬 포함 관계**(`<hp:tbl>` 스팬 ⊂ 호스트 `<hp:p>` 스팬)로 자기 표를 찾아 그 표 앞으로
  끌어올리고, 앵커 자리에서는 다시 실행하지 않는다. 스팬이 없는 `.hwp` lift 순서(`[앵커, Table]`)는
  판정이 자연히 false 라 종전 동작 그대로다.

### ② 드러난 두 번째 축 — `noAdjust="1"` 표의 행 높이 (같이 고침)

쪽나누기만 켜면 `bizinfo-mss__붙임1` 은 24 → **26**(한컴 25)이 된다. 한컴 linesegarray 로 복원한
쪽 시작 문단과 대조하면 **8개 break 는 전부 한컴과 같은 자리**에 서고, 초과 1쪽은 1쪽에 있는
표지 표(19×7, `noAdjust="1"`) 하나를 **68,040 vs 한컴 65,356 HWPUNIT(+4.5%)** 로 과다 예약해서
생기는 흐름 break 였다. 즉 기존 “24 vs 25”는 **누락 break(−) 와 과다 예약(+) 이 상쇄된 값**이었다.

→ `noAdjust="1"`(자동 맞춤 안 함)의 저장 행 높이를 **바닥이 아니라 정확값**으로 쓴다.
`Table::fixed_row_heights`(RENDER-IR 전용, HWPX 파서만 세움) + `apply_row_overrides` 분기.
`.hwp` lift/synth 는 이 플래그를 세우지 않으므로 8/18/24/6 게이트는 구조적으로 무영향.

### 실측 표 (우리 쪽수 / 한컴)

| 표본 | 기존 | ①만 | ①+② | 한컴 |
|---|---|---|---|---|
| bizinfo-mss__붙임1 | 24 | 26 | **25** | 25 |
| 독스헌터_예창패 | 13 | 14 | **14** | 14 |
| 2026_딥테크창업사관학교 | 19 | 25 | 22 | 23 |
| 독스헌터_창도패(딥테크) | 15 | **19** | 18 | 19 |
| 독스헌터_창도패(일반형) | 16 | **17** | 16 | 17 |
| 창도패_원본_2026 | 10 | 13 | 12 | 11 |
| 초창패_원본_2026 | 24 | 27 | 26 | 25 |
| footnote-01 | 3 | 5 | 5 | 7 |
| benchmark1.hwpx | 22 | 22 | 22 | 25 |

코퍼스 전수 집계(2026-07-30 통합 verify가 최종 상태에서 재실측 — 구현 워커의 최초 집계
"29→29→26·정확 1→3→2"는 파일 집합이 재현되지 않아 폐기): 실 충실도 HWPX **35건**(bench-local-2026
12 + bench-public 17 + corpus/hwpx 5 + benchmark1) 기준 최종 |오차| 합 **29 · 정확 일치 19**,
bench-local-2026 12건만 보면 |오차| 15 · 정확 2. 단계별 델타의 정본은 위 9행 표(전수 재검증 9/9 일치).
②로 나빠진 2건은 둘 다 **독스헌터 변환본**(3rd-party lossy 변환 — 저장 높이가 내용과 어긋난다).

## 남은 것 (이 이슈 밖)

`.hwpx` 쪽수의 잔여 오차는 **줄/행 높이 참값 축**이다(예: `bizinfo-mss__2026-144호` 는 흐름 break 가
한컴 3 vs 우리 7). 쪽나누기 축은 여기서 닫히고, 나머지는 075(HWPX 참값 오라클) 몫이다.
