# 충실도 벤치마크 — 방법론과 재현 절차

> 이 문서가 **충실도 수치의 정본**이다. 공개 요약 페이지(`/bench`, `apps/hwp-lab/src/app/bench/page.tsx`)는
> 여기 적힌 것 중 사용자에게 보여 줄 부분만 옮긴 것이며, 두 곳의 수치는 항상 같아야 한다.
>
> **수치 규율**: 여기 적는 모든 숫자는 아래 재현 커맨드를 실제로 실행해 얻은 출력이거나 테스트에
> baseline 으로 박혀 있는 값이다. 추정치·인상치는 싣지 않는다. 근거를 못 대는 수치는 지운다.

기준 커밋 `3cb5a7a` · 측정 2026-07-30 (macOS, `--features "shaper rhwp"`).

## 1. 무엇을 오라클로 쓰는가

충실도 주장에서 가장 흔한 속임수는 "원본과 비슷해 보인다"는 육안 비교다. 눈은 표 하나가 반 줄
밀린 것을 놓치고, 놓쳤다는 사실도 남기지 않는다. 우리는 사람 눈을 오라클에서 빼기 위해 세 개의
기계 판독 가능한 정답지를 쓴다.

### ① 한글이 파일에 저장한 lineseg — 주 오라클

HWP/HWPX 는 문서를 저장할 때 **한글 자신이 계산한 조판 결과를 파일 안에 함께 적어 둔다**
(`linesegarray` / `<hp:lineseg>`). 문단마다 몇 줄로 끊겼는지, 각 줄의 세로 위치가 얼마인지가
들어 있다. 즉 정답지를 우리가 만드는 게 아니라 **한글이 만들어서 문서에 넣어 준다**.

- 신뢰 근거: 우리 코드가 관여하지 않은 값이다. 해석의 여지가 없고, 문서를 열 때마다 같다.
- 한계: 한글이 **그 저장 시점에** 계산한 값이다. 문서에 캐시가 없거나(변환·정규화로 제거된 HWPX)
  다른 버전에서 재조판되면 비어 있을 수 있다 — 그럴 때 도구는 점수를 꾸며내지 않고
  `oracle 없음 N` / `missing-oracle` 로 명시한다.

### ② rhwp 파싱 — 보조 오라클

`external/rhwp`(MIT)는 바이너리 `.hwp`(HWP5)를 읽는 상류 파서다. 우리는 이것을 **파싱 전용**으로만
쓴다(불변식 3) — 렌더는 항상 우리 IR 에서 나온다. 쪽수 대조의 "한컴(rhwp)" 열과 HWPX 파서 파리티
테스트의 기준선이 여기서 나온다.

### ③ 서로 다른 두 경로의 상호 대조

같은 문서를 서로 다른 코드 경로로 읽거나 조판해서 결과가 갈리는지 본다. 절대 참값은 아니지만
**한쪽이 조용히 망가지는 것을 잡는 데는 참값보다 예민하다**.

- `.hwpx` 를 우리 HWPX 파서 vs rhwp lift 로 각각 읽고, 엔진을 고정한 채 조판 결과를 비교
  (`crates/hwp-core/tests/hwpx_rhwp_parity.rs`)
- 캐럿 API vs 렌더된 SVG 글리프 좌표 (`packages/engine/bench/body-caret-crosscheck.mjs`)
- **LOCKSTEP**: `place_doc`(`crates/hwp-typeset/src/place.rs`)과 `NaiveLayout`(`lib.rs`)의 쪽수는
  항상 일치해야 한다. 한쪽만 고치면 게이트가 아니라 코드 리뷰 규율이 막는다(불변식 2).

## 2. 지표별 정의와 실측치

### 2.1 쪽수 게이트 (하드 게이트)

우리 조판기가 낸 쪽수 == 한컴 쪽수. ±1 완충 없음.

| 문서 | 우리 | 한컴(rhwp) | 판정 |
|---|---|---|---|
| `benchmarks/benchmark.hwp` | 8 | 8 | 일치 |
| `benchmarks/benchmark1.hwp` | 18 | 18 | 일치 |
| `benchmarks/benchmark2.hwp` | 24 | 24 | 일치 |
| `corpus/private/modu-startup/modu-startup.hwp` | 6 | 6 | 일치 (로컬 전용) |

`modu-startup` 은 실사용자 양식 실물이라 공개 재배포가 불가능하다. `corpus/private/`(gitignore)에만
두고, `scripts/verify-local.sh` 는 파일이 있으면 SHA 검증 + 6==6 을 강제하고 없으면
`⚠️ modu-startup 게이트 skipped` 를 출력한다(068 규율 — 점수를 꾸며내지 않는다).

### 2.2 본문 문단 줄바꿈 정확 일치율

문단별로 `ours = 우리 조판이 낸 줄 수`, `oracle = 저장된 lineseg 줄 수` 를 비교한다.
"정확 일치" = `ours == oracle` 인 문단 비율, "±1 이내" = `|ours - oracle| <= 1` 인 비율.

| 문서 | 대조 문단 | 정확 일치 | ±1 이내 | 총 줄 수 (우리 / 한컴) |
|---|---|---|---|---|
| `benchmark.hwp` | 91 | 90 (98.9%) | 91 (100.0%) | 92 / 93 |
| `benchmark1.hwp` | 257 | 255 (99.2%) | 257 (100.0%) | 297 / 299 |
| `benchmark2.hwp` | 365 | 364 (99.7%) | 365 (100.0%) | 376 / 377 |

세 문서 모두 ±1 이내 100% — 두 줄 이상 어긋난 문단이 없다. AGENTS.md 불변식 1 이 잠그는 하한은
`benchmark.hwp` 98.9%+ 이다.

**이 지표가 재지 않는 것**: *어느 글자에서* 줄이 끊겼는지, 글자의 x 좌표. 줄 *개수* 충실도다
(`docs/PIVOT-DESIGN.md` §결정). 글자 좌표는 §2.4 캐럿 교차검증이 따로 잰다.

### 2.3 표 셀 안 줄바꿈 (재귀)

양식 문서는 내용 대부분이 표 안에 있는데 §2.2 는 표 밖 문단만 센다 — `benchmark1.hwp` 는 표 밖
문단이 257개인데 표 안 문단은 839개다. 그래서 중첩 표까지 재귀로 내려가 셀 안 문단의 lineseg 를
따로 대조하고, 기대값을 테스트에 정확한 튜플로 박아 둔다
(`crates/hwp-rhwp/src/lib.rs` `cell_lineseg_gate_tests`).

| 문서 | 대조 셀 문단 | 정확 일치 | ±1 이내 | 셀 총 줄 수 (우리 / 한컴) | 구조 불일치 | oracle 없음 |
|---|---|---|---|---|---|---|
| `benchmark.hwp` | 261 | 261 (100.0%) | 261 (100.0%) | 291 / 291 | 0 | 0 |
| `benchmark1.hwp` | 839 | 826 (98.5%) | 839 (100.0%) | 969 / 978 | 0 | 0 |
| `benchmark2.hwp` | 1,059 | 1,042 (98.4%) | 1,059 (100.0%) | 1,185 / 1,190 | 0 | 0 |

- **구조 불일치 0**: 두 쪽이 같은 표·같은 셀·같은 문단을 세고 있다는 뜻. 어긋나면 점수 자체가
  무의미해지므로 별도 카운터로 잠근다.
- **oracle 없음 0**: 한컴 저장값이 빠진 문단을 조용히 건너뛰고 만점을 받는 경로를 막는다.

### 2.4 본문 캐럿 좌표 교차검증

조판이 맞아도 클릭한 자리에 커서가 서지 않으면 편집기로서 실패다. 세 벤치마크 문서(8+18+24쪽,
563 밴드)의 모든 줄 밴드를 훑으며 엔진 캐럿 API 와 히트테스트가 서로 왕복하는지 본다.

| 검사 항목 | 결과 |
|---|---|
| 히트 결과가 질의한 쪽 안에 캐럿을 담는가 (page-local) | 1,825 / 1,825 |
| 캐럿 사각형 → 히트테스트 왕복 (주소·오프셋 복원) | 431 / 431 |
| 글리프 baseline 이 엔진 LineSeg 캐럿 상자 안에 있는가 | 431 / 431 |
| 보이는 글리프의 x 좌표 일치 | 431 / 431 |
| 질의 3,227건 p95 응답 | 0.123 ms |

응답 시간만 기기 의존이다(레포 기록상 같은 스크립트의 p95 는 0.081~0.155ms 범위에서 움직였다 —
`docs/CURRENT_STATE.md`). 위 네 개의 일치 카운트는 결정론적이다.

스크립트가 함께 뽑는 진단 카운터(예: SVG 추정 폭 기반 히트 오프셋 불일치)는 **게이트가 아니라
마이그레이션 진단**이다 — 구 JS 우회 구현과 새 엔진 API 의 차이를 드러내려고 일부러 센다.

### 2.5 HWPX 파서 파리티

`.hwp` 는 rhwp 로, `.hwpx` 는 자체 파서로 읽는다. 두 경로가 같은 문서에서 다른 IR 을 만들면 조판이
조용히 갈라진다. 그래서 같은 `benchmark1.hwpx` 를 두 파서로 읽고 **엔진을 고정한 채** 대조한다.
쪽수 게이트가 *결과*를 잠근다면 이 테스트는 *입력*을 잠근다.

| 항목 | 우리 HWPX 파서 | rhwp 경로 | 판정 |
|---|---|---|---|
| 문단 수 | 325 | 325 | 일치 |
| 표 수 | 67 | 67 | 일치 |
| 조판 쪽수 | 22 | 22 | 일치 |
| 조판 총 줄 수 | 301 | 301 | 일치 |
| 하이퍼링크 필드쌍 회수 | 1 / 1 | — | 보존 |

총 줄 수가 가장 예민한 탐지기다: 표 앵커 문단(`is_table_anchor`)을 안 세우면 표 개수만큼 빈 줄이
초과 예약된다(실측 368 vs 301 = 정확히 표 67개 초과). 장평·스크립트별 글꼴도 함께 잠근다 —
값 기준 dedup(`intern_shape`) 구조상 **안 읽는 속성이 많을수록 서로 다른 charPr 이 하나로 뭉개져**
조기 줄바꿈 → 쪽수 증가로 번지기 때문이다.

## 3. 게이트가 회귀를 잠그는 방식

수치는 보고용이 아니라 **차단선**이다. 세 층으로 잠근다.

1. **스크립트 게이트** — `scripts/verify-local.sh` 가 4개 문서의 `layout-check` 출력에서 `쪽수` 줄을
   grep 해 `일치` 가 없으면 `exit 1`. 쪽수는 사람이 읽고 판단하는 값이 아니라 빌드 실패 조건이다.
2. **테스트 baseline** — 셀 lineseg 기대값이 튜플로 박혀 있어(`(839, 826, 839, 969, 978, 0)`) 한
   문단만 어긋나도 `cargo test` 가 붉어진다. "대충 비슷하면 통과"가 없다.
3. **머지 규율** — `verify-local.sh` 가 그린이 아니면 머지하지 않는다. crates/packages 를 만졌으면
   `--full`(wasm 재빌드 + 캐럿 교차검증 + JS 유닛 + E2E)이 필수다(AGENTS.md).

여기에 구조적 불변식이 겹친다:

- **LOCKSTEP**(불변식 2) — 두 조판 경로의 쪽수가 갈리면 한쪽만 고치는 것 자체가 위반이다.
- **byte-verbatim 왕복** — 편집하지 않은 HWPX 영역은 바이트 그대로 보존되어야 한다는 골든 테스트가
  따로 있다. "조판이 맞다"와 "원본을 안 망가뜨렸다"는 별개의 게이트다.

## 4. 재현 절차 (전문)

### 4.0 준비

```bash
git clone --recurse-submodules https://github.com/kwakseongjae/auto-hwp
cd auto-hwp
```

Rust 툴체인이 필요하다. 아래 커맨드는 전부 `cargo run` 형태라 별도 설치 없이 레포에서 바로 돈다
(설치형 `auto-hwp` 바이너리를 쓰려면 `docs/CLI-GUIDE.md` §설치 참고 — `--features rhwp,shaper,pdf`).

### 4.1 쪽수 게이트

```bash
for b in benchmark benchmark1 benchmark2; do
  cargo run -q -p auto-hwp-cli --features "shaper rhwp" -- \
    layout-check "benchmarks/${b}.hwp" | grep 쪽수
done
```

기대: `쪽수 우리 8 · 한컴(rhwp) 8 (일치)` / `18 · 18 (일치)` / `24 · 24 (일치)`.

### 4.2 본문 줄바꿈 + 셀 lineseg (한 커맨드에 둘 다 나온다)

```bash
cargo run -p auto-hwp-cli --features "shaper rhwp" -- \
  layout-check benchmarks/benchmark1.hwp
```

출력의 `문단 … 줄수 정확 일치` 가 §2.2, `셀 문단 … 셀 줄수 정확 일치` 가 §2.3 이다.

셀 게이트를 테스트로 확인:

```bash
cargo test -p hwp-rhwp --features "rhwp shaper" cell_lineseg
```

어느 셀이 왜 어긋났는지 감사(셀 폭·좌우 패딩·우리 wrap 폭·한컴 seg 폭·텍스트):

```bash
cargo run -p auto-hwp-cli --features "shaper rhwp" -- \
  layout-check benchmarks/benchmark1.hwp --cells all
```

표 행 높이를 보려면 `--rows <섹션>/<블록>`(예: `--rows 0/6`). `--rows` 와 `--cells` 는 함께 못 쓴다.

### 4.3 캐럿 교차검증

wasm 을 먼저 빌드해야 한다(스테일 pkg 는 조용히 옛 결과를 낸다 — AGENTS.md 함정 top 6).

```bash
cargo build -p hwp-wasm --profile wasm-size --target wasm32-unknown-unknown
wasm-bindgen --target web --out-dir packages/engine/pkg \
  target/wasm32-unknown-unknown/wasm-size/hwp_wasm.wasm
node packages/engine/bench/body-caret-crosscheck.mjs
```

`BODY_CARET_CROSSCHECK_JSON` 한 줄이 기계 판독용 전체 결과다.
`hitCaretPageChecks/Matches` = page-local, `engineRoundTripChecks/Matches` = rect→hit 왕복,
`baselineContainment*` = baseline 포함, `rectX*` = 글리프 x 일치, `performance.allQueries.p95Ms` = p95.

### 4.4 HWPX 파서 파리티

```bash
cargo test -p hwp-core --features rhwp --test hwpx_rhwp_parity -- --nocapture
```

`조판 파리티 — 우리 22쪽/301줄 (행높이 바닥고정 시 22쪽/301줄) · rhwp lift 22쪽/301줄` 이 나온다.

### 4.5 전부 한 번에

```bash
scripts/verify-local.sh          # fmt · clippy · 전체 테스트 · 쪽수 게이트 · wasm 위생 · deny
scripts/verify-local.sh --full   # + wasm 재빌드 · 캐럿 교차검증 · JS 빌드/유닛 · E2E
```

## 5. 한계 — 이 수치가 말하지 않는 것

1. **한컴 네이티브 참값 오라클은 미완이다.** 정답지는 "한글이 파일에 저장해 둔 값" + "rhwp 파싱"
   이지, 한글을 실행시켜 얻은 결과가 아니다. Windows COM nightly 레인은 이슈 075 로 열려 있다.
2. **HWPX 입력의 절대 쪽수는 아직 정답이 아니다.** `layout-check benchmarks/benchmark1.hwpx` 는
   우리 22쪽 vs 한컴(rhwp) 25쪽으로 갈린다(같은 커맨드로 직접 확인 가능). §2.5 파리티와 HWPX 관련
   게이트는 **회귀를 잠그는 장치**이지 참값 주장이 아니다. 이슈 074 에서 네 갈래(본문 상자 여백·
   세로 병합 셀 균등분배·ragged 표·`stored_row_heights` 바닥)를 해소했고, 남은 명시적 쪽 나누기
   (`pageBreak`) 누락은 080 으로 추적 중이다.
3. **재현 불가 표본(레포 기록).** 한컴 저작 HWPX 5종을 production 파서로 재측정했을 때 4종은 한컴
   쪽수와 정확히 같았고 `bizinfo-mss__붙임1` 하나만 우리 24 vs 한컴 25 였다(`docs/issues/080-hwpx-explicit-page-break.md`).
   해당 문서들은 공개 코퍼스가 아니라 외부에서 재현할 수 없다 — 그래서 §2 의 표에 섞지 않는다.
4. **modu-startup 6==6 은 로컬 전용이다.** 클론한 레포에서는 skip 으로 표시된다.
5. **줄 개수 충실도다.** 어느 글자에서 끊겼는지·글자 x 좌표는 §2.2 가 아니라 §2.4 가 잰다.
6. **벤치마크 밖 문서의 완전 일치는 보증하지 않는다.** 게이트가 도는 문서는 §2.1 의 4종이 전부다.
   다단·세로쓰기·개체 어울림(float/wrap)은 미구현이고, over-tall 셀은 클리핑된다. 함초롬 등 상용
   서체는 번들하지 않아 OFL 대체(나눔 계열)로 렌더되므로 글리프 메트릭의 미세 차이가 남는다.
7. **PDF 의 수식·차트는 자리표시 상자**로 나간다(화면·HTML 은 실제로 그린다) — `docs/CLI-GUIDE.md`
   §정직 고지와 같은 사실이다.

## 6. 관련 문서

- 공개 요약 페이지: `/bench` (소스 `apps/hwp-lab/src/app/bench/page.tsx`)
- CLI 사용법: [CLI-GUIDE.md](./CLI-GUIDE.md) — `layout-check` 인자 정본
- 검증 스위트: `scripts/verify-local.sh` — 게이트 정본
- 불변식 전문: [PRODUCT-DIRECTION.md](./PRODUCT-DIRECTION.md) §4
- 미해결 이슈: [074](./issues/074-hwpx-page-undercount.md) · [075](./issues/075-hancom-native-oracle.md) · [080](./issues/080-hwpx-explicit-page-break.md)
