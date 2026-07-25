# 074 — HWPX 입력에서 쪽수 20~25% 과소 계산

- 상태: **open** (원인 미규명 — 실측만 확보) · 우선순위: P1(충실도 축의 남은 최대 갭) · 영역: `crates/hwp-typeset` (+ 가능성: `crates/hwp-hwpx` 파서)
- 발단: 073·HWPX 파서 수정(`8142b83`/`59f784e`) 과정에서 **가려져 있던 갭이 드러났다**. 표 앵커의
  초과 빈 줄(표당 1줄)이 이 과소 계산을 우연히 메우고 있었고, 앵커를 바로잡자 노출됐다.

## 실측 (독립 오라클 = LibreOffice + H2Orestart, 실제 HWP 리더)

| 입력 | 오라클 | 우리 조판 | 판정 |
|---|---|---|---|
| `benchmarks/benchmark1.hwp` (원본 바이너리) | **18쪽** | **18쪽** | ✅ 일치 (게이트) |
| `benchmarks/benchmark1.hwpx` (같은 문서) | **25쪽** | **20쪽** | ❌ **-5쪽 (-20%)** |
| `corpus/…/pps__우수제품_지정신청서_작성_요령.hwpx` (한컴 저작) | **4쪽** | **3쪽** | ❌ -1쪽 (-25%) |

- **`.hwp` 경로는 정확하다** — 같은 조판기·같은 문서인데 입력 포맷만 바꾸면 어긋난다.
- **우리 conversion 산출물만의 문제가 아니다** — 한컴이 직접 저장한 hwpx에서도 재현된다.
- rhwp 도 이 문서를 25쪽으로 조판한다(= 오라클과 일치). 우리만 20쪽이다.

## 이미 배제된 것

- **파서 IR 은 아니다.** `crates/hwp-core/tests/hwpx_rhwp_parity.rs` 가 우리 HWPX 파서의 IR 이
  rhwp lift 와 조판 결과까지 일치함을 잠근다(18쪽/301줄, 행높이 바닥고정 시 20쪽/301줄 —
  rhwp lift 20쪽/301줄과 동일). 즉 **같은 IR 을 받아도 우리 조판기가 rhwp 보다 조밀하게 짠다.**
- 표 앵커 빈 줄(초과 +67줄 = 표 개수)은 이미 해소됐다(`59f784e`).
- 장평·자간·스크립트별 글꼴·줄간격 종류 미독해도 해소됐다(`8142b83`).

## 유력 가설 (미검증 — 다음 사람이 여기서 시작하라)

1. **행 높이 바닥(floor)**: `.hwp` lift 는 항상 `stored_row_heights` 를 바닥으로 쓰지만, HWPX
   파서는 `noAdjust=1` 일 때만 쓴다(auto-fit 표는 렌더 전용). benchmark1 은 74/74 가 auto-fit.
   바닥을 걸면 18→20쪽이 되지만 여전히 25에 못 미친다 — **필요조건이되 충분조건은 아니다.**
   과거 #196 에서 "바닥 걸면 +2페이지"를 회귀로 판단해 껐는데, 오라클 기준으로는 그 +2 가
   **옳은 방향**이었다. 판단 기준이 틀렸던 셈.
2. `<hp:margin header/footer/gutter>` 미독해 → 본문 높이 과대평가(양쪽 경로 공통 갭이지만
   hwpx 에서 더 크게 작용할 수 있다).
3. 셀 안쪽 여백(`CELL_PAD` 상수 280) 이 실제 `<hp:inMargin>` 을 무시한다 — 표가 많은 문서에서
   누적되면 쪽수 차이로 이어진다.
4. `normalize.rs:1-23` 은 "변환 hwpx 가 ~1.6× 느슨하게 렌더되는 것은 한컴도 그러므로 충실하게
   읽는 게 기본"이라 적어 두었다. 이 관측 자체는 오라클과 부합한다(18 → 25 = 1.39×). 그렇다면
   **우리 조판이 그 느슨함을 재현하지 못하는 것**이 문제다.

## 재현 방법

```bash
cargo build --release -p auto-hwp-cli --features rhwp,shaper,pdf
# 오라클(정답지)
./target/release/auto-hwp oracle benchmarks/benchmark1.hwpx --out /tmp/o
# → /tmp/o/benchmark1.pdf 의 쪽수 = 25
# 우리
./target/release/auto-hwp own-render benchmarks/benchmark1.hwpx --out /tmp/ours.svg
ls /tmp/ours*.svg | wc -l   # = 20
```

⚠️ **`layout-check <파일>.hwpx` 로는 측정할 수 없다** — `hwp_rhwp::layout_fidelity` 가 양쪽 모두
rhwp lift 로 읽어서 우리 HWPX 파서를 타지 않는다. 이 축의 지표는 **오라클 PDF 쪽수**이거나
`hwpx_rhwp_parity.rs` 의 조판 파리티다.

## 수용 기준 (안)

- [ ] benchmark1.hwpx 오라클 25 == 우리 25 (또는 ±1)
- [ ] 한컴 저작 hwpx 표본 5종 이상에서 오라클 대비 ±1쪽
- [ ] `.hwp` 게이트 불변: benchmark 8==8 · benchmark1 18==18 · 줄바꿈 98.9%+
- [ ] LOCKSTEP(`place_doc` ↔ `NaiveLayout`) 유지
