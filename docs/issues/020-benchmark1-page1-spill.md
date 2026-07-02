# 020 — QA-1: benchmark1 1페이지 스필 정밀 수정 (per-row 실측 기반, 19→18)

- 상태: **open**
- 우선순위: **P0 (QA 라운드 1 최우선)** — 사용자 QA에서 실패 판정된 유일한 렌더 충실도 항목
- 영역: hwp-typeset (place.rs + NaiveLayout **양쪽**, LOCKSTEP) + tf-hwp-cli 진단
- 선행: 없음. 병렬 가능: 021 (파일 disjoint — 021은 hwp-session/hwp-wasm/packages만)

## 사용자 QA 관찰 (2026-07-02)
benchmark1.hwp 업로드 시 **원본 benchmark1.pdf에서는 1페이지에 들어가는 내용이 1페이지를
벗어나 렌더링**된다. (사용자 추정: 폰트/여백 과대평가.)

## 아키텍트 진단 (실측 완료 — 이 위에서 시작하라)
- **웹 회귀 아님**: wasm(Approx)·네이티브(shaper)·네이티브(no-shaper) 모두 benchmark1 = 19쪽
  동일. 이것은 기존에 진단된 **"우리 19 vs 한컴 18" 잔차**다.
- 2026-06-27 R13e 진단 요약 (재사용하라):
  - 문서 내 빈 공간/쪽 전환 다수는 **진짜 쪽나누기**(column_type page_break, blocks 7/13/128/
    185/205/218/227) — 건드리지 마라, 원본과 동일하다.
  - +1쪽의 원인: **1페이지의 거의-전면 체크리스트 표(block 6, 17행)가 행당 세로 과다 예약**
    (누적 수만 HWPUNIT)으로 1→2페이지로 흘러넘침. 이후 전체가 한 페이지씩 밀린다.
  - 이미 배제된 레버: CELL_PAD_X(수평) 무효; **전역 줄간격 스케일은 1.0→19, 0.9→17로 18을
    건너뜀** + 다른 문서 망침 → 전역 스케일 금지.
- 결론: **국소·기전(mechanism) 기반 수정**만 허용된다. "어느 항이 얼마나 과대한가"를 한컴
  실측과 행 단위로 대조해 정확한 항을 고쳐라.

## 목표
benchmark1 = **18쪽** (최소 목표: 1페이지 체크리스트 표가 원본처럼 1페이지에 수납).
동시에 게이트 불변: benchmark.hwp **8==8 + 줄정확도 ≥98.9%**, benchmark1 줄정확도(현 99.2%대)
저하 금지, LOCKSTEP(place_doc==NaiveLayout) 유지.

## 파일 지도
- `crates/hwp-typeset/src/place.rs` — place_table/row_heights/place_cell_content, CELL_PAD(세로 280),
  DEFAULT_LINESPACE(1.6), line_spacing_ratio
- `crates/hwp-typeset/src/lib.rs` — NaiveLayout::table_row_heights/block_height (LOCKSTEP 짝)
- `crates/tf-hwp-cli/src/main.rs` — layout-check (rhwp 한컴 linesegs를 이미 읽는다 — 확장 지점)
- `crates/hwp-rhwp` — 한컴 lineseg 데이터 접근 어댑터 (rhwp 원본 수정 금지)
- 산출 문서(신규): `docs/BENCHMARK1-ROW-AUDIT.md`

## 구현 단계 (반드시 이 순서 — 측정 없이 수정 금지)
1. **진단 도구**: `layout-check`에 `--rows <section>/<block>` 류 플래그(또는 신규 서브커맨드)를
   추가해, 지정 표에 대해 **행별 대조표**를 출력하라: [행번호 | 우리 예약높이 | 우리 줄수·줄높이
   내역(ascent/descent/linespace/CELL_PAD 분해) | 한컴 lineseg 기반 실제 높이 | 델타].
   한컴쪽 근거는 rhwp가 파싱하는 lineseg(문단별 줄 세그먼트의 수직 위치/높이)에서 뽑는다 —
   layout-check가 이미 문단별 줄수를 대조하므로 그 경로를 확장. **이 도구는 tracked로 남긴다**
   (향후 충실도 작업의 상비 도구).
2. **실측**: benchmark1의 스필 표(block 6)와 대조군(benchmark.hwp의 표 2~3개)에 대해 대조표를
   뽑아 `docs/BENCHMARK1-ROW-AUDIT.md`에 기록. **체계적 델타의 기전을 특정**하라. 우선 가설
   (하나씩 검증하고 기각/채택을 문서에 남겨라):
   (a) 셀 내 줄높이의 linespace 적용 방식 — 한컴은 셀 문단의 para_shape 줄간격(%)을 쓰는데
       우리는 DEFAULT_LINESPACE로 덮거나 그 반대인 경우
   (b) 마지막 줄 처리 — 한컴이 셀 마지막 줄에 linespace 여분(leading)을 더하지 않는데 우리는
       모든 줄에 균일 적용하는 경우 (행당 상수 과대 ≈ 이 패턴)
   (c) CELL_PAD(세로 280×2)이 한컴 실측 셀 패딩과 다른 경우
   (d) ascent/descent 소스(폰트 메트릭) 차이 — 행당 비례 과대라면 이쪽
3. **국소 수정**: 특정된 기전만 고친다. **place.rs와 NaiveLayout 양쪽에 동일하게**(LOCKSTEP §4.1-2).
   전역 상수 스케일/매직넘버 보정 금지 — 기전이 설명하는 수정만.
4. **검증 스위트**: 게이트 8==8+98.9% / benchmark1 쪽수·줄정확도 / `cargo test -p hwp-typeset`
   (기존 39+) / 오라클 코퍼스 무회귀(있는 스모크 전부). own-render SVG가 바뀌므로(의도된 diff)
   scripts/golden.sh 기준 해시를 재고정하고 커밋 노트에 명시.
5. **정직 종료 조건**: 만약 실측 결과 "18로 만드는 유일한 방법이 게이트를 깨는 것"으로 판명되면
   — 수정을 강행하지 말고 대조표+기전 분석을 `docs/BENCHMARK1-ROW-AUDIT.md`에 완성하고
   status=partial로 보고하라. 측정 문서 자체가 이 이슈의 절반이다.

## 수용 기준
- [ ] 행별 대조 진단 도구가 tracked로 존재하고 재현 가능
- [ ] `docs/BENCHMARK1-ROW-AUDIT.md`: 스필 표 행별 실측 + 기전 특정(가설 채택/기각 기록)
- [ ] benchmark1 = 18쪽 (또는 §5의 정직 종료: 기전 문서화 + 18 불가 사유)
- [ ] 게이트 8==8 + ≥98.9%, benchmark1 줄정확도 무저하, LOCKSTEP 유지, typeset 테스트 그린
- [ ] golden 재고정(의도된 SVG 변화 명시)

## 함정
- 오라클은 NaiveLayout을 쓴다 — place.rs만 고치면 페이지 수가 갈라진다(LOCKSTEP).
- rhwp lineseg는 **파싱 데이터**다 — rhwp 원본 수정 금지, 어댑터에서 읽기만.
- 쪽나누기 빈 공간을 "고치려" 들지 마라 — 원본과 동일한 충실 동작이다.
- 셀 병합/분할표(first_row) 표에서 행 인덱스 주의 — 진단 도구는 모델 전역 행 기준으로 출력.
