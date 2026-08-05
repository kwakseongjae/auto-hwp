# rhwp 지형 리서치 (2026-08) — 그들의 현재 고민 · 우리와의 교차 · breakthrough 후보

- 조사일: 2026-08-05 · 조사 범위: rhwp upstream(`edwardkim/rhwp`) 공개 이슈·디스커션·커밋,
  2026-07-26 ~ 08-05 를 중심으로 소급.
- 조사 방법: `gh api`/`gh search` 로 이슈·디스커션 본문 직접 열람(요약본 아님) + 웹 검색.
  본문 인용은 원문 그대로다. **추측은 "추측:" 으로 표기했다.**
- 우리 쪽 수치는 이 레포에서 **오늘 실제로 돌린 것**이다(`scripts/bench-local.sh`,
  `scripts/verify-local.sh` 게이트 상수). 인용한 rhwp 수치는 그들이 공표한 값이다.
- 관계 규율: `external/rhwp` 는 **vendored 수정 금지 + 파싱 전용**(AGENTS.md 불변식 3).
  이 문서는 "그들을 따라잡자"가 아니라 **"둘 다 막힌 지점에서 우리 구조가 유리한 곳"**을 찾는다.

---

## 0. 30초 요약

1. rhwp 는 조판 축에서 **"국소 수정으로는 더 안 오른다"**는 구조적 결론에 도달했다
   (PI 일치율 93.75%, 남은 국소 레버 전부 성공해도 상한 +1.8pp). 다음 도약은
   **세로 공간 계산 재설계**뿐이라고 메인테이너가 공표했다.
2. 그들의 정답지는 **실제 한/글(Windows·COM 자동화)** 이다. 강력하지만 회당 7~17시간이고,
   측정 불가 65건이 고정 갭이며, **"문단이 몇 쪽에서 시작하는가"만 본다.**
3. 그 결과 **줄 단위 어긋남이 침묵하는 사각**이 생겼고, 그들은 그것을 이슈 본문에 명시했다 —
   *"줄 단위 어긋남을 보려면 저장 줄 좌표와 렌더 좌표를 직접 대조해야 한다"* (#4054).
4. **우리 오라클이 정확히 그것이다.** `layout-check` 는 문단별·셀 문단별 줄 수를 파일에 저장된
   한/글 lineseg 와 대조한다. 한/글 설치본 없이, 오프라인으로, 초 단위에.
5. 그래서 breakthrough 후보 5개는 전부 **"우리 오라클이 보는데 그들 오라클이 못 보는 축"** 위에 있다.

---

## 1. 그들의 현재 고민 (출처 URL)

### 1.1 메인테이너가 직접 정리한 현재 위치

**[10k 한글 오라클 서베이 시리즈(r5~r26) 에 대한 메인터이너의 정리](https://github.com/edwardkim/rhwp/discussions/3582)**
(2026-07-30, Show and tell) — 이번 조사에서 가장 중요한 단일 문서다.

- 정답지 = **실제 한컴 한글**. 공공기관 실물 수십만 건 코퍼스에서 **무작위 1만 건**을 뽑아
  한/글 결과와 문서 단위 자동 대조. 회당 7~17시간.
- 두 축: **PI 일치율**(문단이 몇 쪽에서 시작하는가, 전수) + **픽셀 일치율**(쪽 이미지 겹침).
- 현재 수치: PI **93.75~93.76%**, 픽셀 **94.10~94.45%**(회차별).
  ⚠️ 그들 스스로 §3.6 에서 **"회차 간 헤드라인 % 비교는 무의미"** 라고 못 박았다 —
  판정 정의와 하니스가 세 번 바뀌었다. 인용할 때 이 단서를 떼면 오독이다.
- 핵심 결론(§3.1, §4.1): **"조판(쪽수) 축은 국소 수정으로 더 오르지 않는다."**
  잔여 실패는 국소 오차들이 서로 **상쇄되는 잔차**이고(80쪽+ 문서 집중, 첫 어긋남의 67%가
  문서 앞 20%), 남은 국소 수정을 전부 성공해도 **상한 +1.8pp**.
  → *"다음 유의미한 향상은 세로 공간 계산 재설계이고, 착수 시 3중 게이트(92셋 + 10k +
  한컴 시각 판정)가 전제 조건이다."*
- 측정 갭(§4.3): **ERR 52(오염 31·보호 15·미지원 5) + STALL 13 = 65건을 고정 갭으로 취급**
  (재시도 무익 실증).
- 픽셀 잔여(§4.2): flagged 343 · sub-80 16 · BIG 204.
- 거버넌스: 시리즈 17회차 전부를 **외부 기여자 1인(@planet6897)** 이 설계·실행·집필.

### 1.2 "오라클이 침묵하는 축" — 그들이 자기 사각을 문서화하고 있다

이번 조사의 가장 값진 발견이다. 최근 열린 조판 이슈 둘이 **같은 구조적 한계**를 지목한다.

**[#4054 각주 예약 과대 + 40px 안전마진이 1.0px 차이로 문단을 3줄 이르게 끊는다 — 쪽수 지표가
상쇄로 침묵](https://github.com/edwardkim/rhwp/issues/4054)** (2026-08-05)

> **PI 오라클이 침묵하는 이유** — per-PI 쪽 위치 오라클은 문단 **시작** 쪽만 비교한다.
> 문단 중간의 줄 3개가 다른 쪽에 있어도 시작 쪽이 같으면 MATCH 다. (…)
> **줄 단위 어긋남을 보려면 저장 줄 좌표와 렌더 좌표를 직접 대조해야 한다.**

- 실측: 각주 예약 76.5px + 안전마진 40px = 약 59px 과대 → 줄 3개(86.4px) 손실.
  정답지(저장 줄 좌표)는 한/글이 line 4 까지 놓았다고 말한다.
- 상쇄 구조: p259 에서 3줄을 잃고 → p260 에서 `saved_tail_vpos_fit` 이 초과를 흡수해
  쪽수를 정답으로 되돌린다. **두 오차가 반대 부호로 상쇄돼 쪽수 지표가 침묵.**
- *"#4024 의 상한을 올리는 것은 해법이 아니다 — 같은 레버의 양끝이다."*

**[#3798 쪽 끝 문단이 말미 줄간격만큼 본문을 넘겨 얹힌다 — 트림에 한도가
없어서](https://github.com/edwardkim/rhwp/issues/3798)** (2026-08-02)

> **왜 여태 안 보였나** — 넘치는 것이 글리프 없는 말미 간격이다. 그래서 쪽수·텍스트 추출·
> IR diff·쪽 밖 글자 — 기존 판별자 **어느 것으로도 침묵**한다. 한글 per-PI 오라클만 잡는다.

- r29 서베이 `PI_MISMATCH` 227건 분해 → n=1(문단 하나만 어긋남) 151건, 방향은 −1 로 쏠림.
- 후보 수정: 스필 한도 6.0px. **평탄 구간이 있다**(5.5 이상 안전)는 근거까지 제시.
- 그리고: *"저장 사다리는 판별자가 못 된다 — 수혜 문서의 40%가 `결재문서본문.hwpx`
  기계생성 문서라 사다리가 한글 실제 배치를 담고 있지 않다."*
  → **그들도 저장 lineseg 를 쓰려 했고, 코퍼스 편향 때문에 접었다.** (§3 에서 다시 다룬다.)

**[#3556 [방법론 v2] 여정보다 '판정'이 먼저다 — 판정 함정 4종 + 오라클 사각
게이트화](https://github.com/edwardkim/rhwp/issues/3556)** (2026-07-29)

> 각 오라클은 **자기가 보는 축에서만** 참이다. `--verify` 는 IR 을 대조하므로 IR 에 없는 것
> (원본 XML 구조·ZIP 엔트리·한컴이 쓴 `<hp:switch>` 래퍼)은 영원히 통과한다.

판정 함정 4종: ① 오라클 통과 ≠ 무손실 ② 상신 전 devel 확인(열린 이슈 53건 중 17건이
이미 고쳐져 있었다) ③ 표본 1건을 전체로 일반화 금지 ④ 가설은 구현해서 기각(음성 결과도 결과).

### 1.3 조판/충실도 — 열려 있는 축 지도

| 축 | 대표 이슈 | 상태 |
|---|---|---|
| 각주 밴드 per-page 정합 | [#2668](https://github.com/edwardkim/rhwp/issues/2668) · [#4054](https://github.com/edwardkim/rhwp/issues/4054) | 문서-레벨 근사(`footer_band_reclaim`)가 knife-edge 8건 회귀. **6종 IR 신호 + 재저장 2종 모두 판별 실패** |
| 다쪽 표 누적 높이 | [#3929](https://github.com/edwardkim/rhwp/issues/3929)(85% 빈 쪽 +1) · [#3386](https://github.com/edwardkim/rhwp/issues/3386)(누적 수직 드리프트 381건) | 열림 |
| 중첩 표 · valign=Center | [#4042](https://github.com/edwardkim/rhwp/issues/4042) · [#4069](https://github.com/edwardkim/rhwp/issues/4069) · [#4068](https://github.com/edwardkim/rhwp/issues/4068) | 2026-08-04~05 신규. 조문대비표 큰 행이 쪽 경계에서 안 잘림 |
| 쪽 밖 소실 (꼬리 줄만 적합 검사) | [#4024](https://github.com/edwardkim/rhwp/issues/4024) | 106.4px 넘침. 고치니 #4054 가 드러남 |
| 선언 셀높이 신뢰 조건 | [#2148](https://github.com/edwardkim/rhwp/issues/2148) · [#3931](https://github.com/edwardkim/rhwp/issues/3931) | "무증거 입력의 분할 진입" — 기계생성 문서 +1쪽 계열 |
| HWPX 왕복 IR/쪽수 발산 | [#4056](https://github.com/edwardkim/rhwp/issues/4056) · [#4049](https://github.com/edwardkim/rhwp/issues/4049) · [#3893](https://github.com/edwardkim/rhwp/issues/3893) · [#3531](https://github.com/edwardkim/rhwp/issues/3531) | 열림. `--verify` 통과인데 `--verify-pages` 4쪽→1쪽 |
| HWPX lineseg 소실/재계산 | [#2527](https://github.com/edwardkim/rhwp/issues/2527) · [#2319](https://github.com/edwardkim/rhwp/issues/2319) · [#2158](https://github.com/edwardkim/rhwp/issues/2158) | 부분 해소. "빈 lineseg 자동 보정 시 글자 대량 겹침" |
| native↔WASM 렌더 발산 | [#4046](https://github.com/edwardkim/rhwp/issues/4046) | 2026-08-05 신규. 측정기 폴백 사다리 비대칭 → 전 페이지 좌표 이동. **한 줄 수정 + byte-diff 하네스** |
| 이미지 변환기 부재 | [#4062](https://github.com/edwardkim/rhwp/issues/4062)(EPS) · [#4063](https://github.com/edwardkim/rhwp/issues/4063)(WMF) · [#4064](https://github.com/edwardkim/rhwp/issues/4064)(TIFF/BMP) · [#4065](https://github.com/edwardkim/rhwp/issues/4065)(PCX) | 10k 스윕에서 신규 발굴. 변환 실패 시 원본 방출 → 빈 그림 |
| 차트 렌더 정합 | [#3939](https://github.com/edwardkim/rhwp/issues/3939) · [#3940](https://github.com/edwardkim/rhwp/issues/3940) · [#3683](https://github.com/edwardkim/rhwp/issues/3683) | 밴드 드리프트 8~180px |

### 1.4 새로 등장한 축 — "에이전트-네이티브"

우리가 알던 조판 축 바깥에서, 2026-08 rhwp 의 **로드맵 무게중심이 옮겨 갔다.**

- **[#3907 에이전트-네이티브 로드맵 R1~R100](https://github.com/edwardkim/rhwp/issues/3907)** (2026-08-03)
  목표 문장: *"새로 온 에이전트가 매뉴얼 없이 30분 안에 첫 유효 기여를 만들고, 도구의 일상
  정비를 에이전트가 맡는 문서 엔진."* 완료 35 / 추적 15 / **가설 50**.
  운영 규칙 1번이 인상적이다 — **"착수는 단계가 아니라 근거가 결정한다."**
- **[#3880 열린 로드맵 7개의 층과 순서](https://github.com/edwardkim/rhwp/issues/3880)** —
  L1 표면(명령·봉투·계약) → L2 신뢰(보안·퍼징) → L3 도달(설치 없는 실행·유입 다리) → L4 표준.
  *"L1 봉투 구멍 4건이 L3 도달을 막는다."*
- **[#3905 다중 에이전트 협업 — 두 에이전트의 exit 0 이 편집 하나를 조용히
  지운다](https://github.com/edwardkim/rhwp/issues/3905)** — 경합 유실 실측 + CAS
  (`preconditions.inputSha256`) 설계.
- **[#3869 설치 없는 실행 — 에이전트 동사 WASM 표면](https://github.com/edwardkim/rhwp/issues/3869)**.

### 1.5 우리 제품 축과 정면으로 겹치는 것

**[Discussion #3498 — 반복 양식 문서 채우기용 document_core 연산 9종, upstream 수용
의향](https://github.com/edwardkim/rhwp/discussions/3498)** (2026-07-28, @yuyu04)

연구노트 12개월치를 HWP 양식에 일괄 채우는 파이프라인에서 나온 요청이다.
**auto-hwp 의 벌크 퍼널과 같은 문제를 푼다.**

- *"표 구조를 LLM 에 맡기면 원본 6×3 표가 6×2로 어긋나서, 앱이 기존 양식 표를
  `copyControl`/`pasteControl` 로 **결정적 복제**하고 내용만 채우는 방식으로 갑니다."*
- 실측된 함정 3건(우리도 같은 지뢰밭에 있다):
  1. `set_table_properties` 의 `treatAsChar` 가 저장에서 유실 — serializer 가 무손실 왕복을
     위해 `raw_ctrl_data` 원본 바이트를 재사용하기 때문. **메인테이너가 devel 에서도 실버그로 확인.**
  2. 다문단 셀 reflow 시 문단 시작 vpos 가 0 으로 보존돼 셀 상단에 겹쳐 그려짐.
  3. `delete_text_at` 가 char_shape ref 를 중복 제거하지 않아 이후 삽입에서 보조 글자모양이 덮음.
- **메인테이너 답변**: *"방향이 rhwp 범위에 맞고, 환영합니다. (…) rhwp 의 초기 설계 목표 중
  하나가 공공기관 웹 기안 워크플로의 오픈소스 대안이었습니다."* — 양식 자동 채우기가
  rhwp 의 직계 로드맵으로 편입됐다.

> 함의: **양식 자동 채우기는 이제 우리만의 트랙이 아니다.** 우리 차별점은 기능 목록이 아니라
> "브라우저에서 업로드→바이브 편집→PDF" 라는 셸과 UX 쪽으로 더 좁혀진다.

### 1.6 프로젝트 온도 (2026-08-05 실측)

| 지표 | 값 |
|---|---|
| stars / open issues | 3,636 / 122 |
| 최근 push | 2026-08-05 (조사 당일) |
| 최근 릴리스 | v0.8.2 (07-26) ← v0.8.1 (07-26) ← v0.8.0 (07-25, "저장 왕복 보존 대공사") |
| 이슈 번호대 | #4069 까지 (7월 말 #3300 대 → 열흘 만에 700+) |
| 공개 채널 | GitHub Discussions(주차별 Chrome 확장 지표 공개), Chrome Web Store, Open VSX, [HWPad(iPad)](https://github.com/edwardkim/rhwp/discussions/1415) |

**⚠️ 우리 vendored rhwp 는 `v0.7.19`(f137b4c9, 2026-07-17) 다.** 그 뒤 v0.8.0/0.8.1/0.8.2 가
나왔고, v0.8.0 이 하필 **"저장 왕복 보존 대공사"** 다. 우리는 파싱 부트스트랩으로만 쓰지만
(불변식 3), lineseg/오라클을 그 파서로 들어올리므로 **오라클 품질에 직접 영향**이 있다.
→ 후속 작업: 서브모듈 승급 전후로 게이트 v2 before==after 를 재고 차이를 기록한다.

---

## 2. 우리 게이트/구현과의 교차

### 2.1 오라클 구조가 다르다 — 이게 모든 차이의 뿌리

| | rhwp | auto-hwp |
|---|---|---|
| 정답지 | **한/글 실행 결과**(Windows + COM + PDF) | **파일 안에 저장된 한/글 lineseg** |
| 입수 비용 | 회당 7~17시간, Windows·라이선스 필요 | 0초, 오프라인, 어느 OS에서나 |
| 해상도 | 문단 **시작 쪽**(PI) + 쪽 픽셀 | 문단별 **줄 수** + 셀 문단별 줄 수 + 쪽수 |
| 규모 | 1만 건 (모집단 수십만) | 게이트 4건 + 로컬 실물 49건 |
| 사각 | 문단 **중간** 줄 어긋남(#4054), 글리프 없는 간격(#3798) | lineseg 캐시가 없는 파일(HWPX 다수), 시각 충실도 |
| 재현성 | 측정 불가 65건 고정 갭 | 캐시 없으면 채점 자체를 skip(점수 위조 금지) |

**요약: 그들은 넓고 얕게, 우리는 좁고 깊게 본다.** 그리고 그들이 "깊이가 필요하다"고
적어 놓은 지점(#4054)이 정확히 우리 축이다.

### 2.2 우리가 이미 푼 것 (오늘 실측)

```
$ cargo run -p auto-hwp-cli --features "shaper rhwp" -- layout-check benchmarks/benchmark.hwp
  쪽수      우리    8  ·  한컴(rhwp)    8  (일치)
  문단       91 개 대조
    줄수 정확 일치      90 (98.9%)
  셀 문단    261 개 대조 (재귀 표 32 · oracle 없음 0 · 구조 불일치 0)
    셀 줄수 정확 일치   261 (100.0%) · ±1 이내   261 (100.0%)
```

- **게이트 v2**: benchmark 8==8 · benchmark1 18==18 · benchmark2 24==24 · modu-startup 6==6.
- **셀 lineseg 축이 살아 있다** — .hwp 경로에서 셀 문단 261건 100% 일치.
  rhwp 가 #2148·#2319 에서 씨름하는 "선언 셀높이 신뢰 조건"을, 우리는 저장 셀 lineseg 를
  1급 정답지로 써서 우회했다.
- **표 행 단위 페이지 분할**(한글식) 구현 완료 — rhwp #4069/#3929 가 지금 여는 축이다.
  (다만 우리 것도 중첩 표 과대 셀에서는 클립된다 — MEMORY: table-pagination-split.)

### 2.3 로컬 실물 49건 스윕 (오늘, `scripts/bench-local.sh`)

`corpus/private/bench-public` 25건 + `bench-local-2026` 24건. **실패 0건**(파싱·조판 크래시 없음).

| 세트 | 총 | 일치 | 줄격차 | 쪽격차 |
|---|---:|---:|---:|---:|
| bench-public (정부 공개 양식/보도자료) | 25 | 9 | 8 | 8 |
| bench-local-2026 (창업지원 양식) | 24 | 6 | 6 | 12 |

**포맷별로 갈라 보면 축이 드러난다** (bench-local-2026, 같은 문서의 .hwp/.hwpx 쌍 포함):

| 확장자 | 총 | 쪽격차 | 셀 오라클 없음 |
|---|---:|---:|---:|
| `.hwp` | 12 | **2** | **1** |
| `.hwpx` | 12 | **10** | **9** |

→ **HWPX 경로가 우리 최대 구멍이고, 동시에 오라클도 거기서 사라진다.**
(위 §1.3 rhwp #2527/#2319/#2158 과 같은 벽이다.)

### 2.4 둘 다 못 푼 것

1. **HWPX 왕복 쪽수 발산.** rhwp #4056(4쪽→1쪽) / #4049 / #3893 / #3531.
   우리도 같다 — `benchmark1.hwp` 18쪽인데 `benchmark1.hwpx` 는 한/글 오라클 25쪽·우리 22쪽.
   `corpus/private/bench-local-2026/README.md` 에도 기록돼 있다: 딥테크 신청서 동일 문서쌍이
   `.hwp` 25p vs `.hwpx` 18p.
   우리 HWPX 게이트는 그래서 **"참값이 아니라 잠금값"** 이라고 `verify-local.sh` 주석에 명시돼 있다.
2. **각주 세로 공간.** rhwp 는 3년치 knife-edge 보정이 얽혀 한 곳을 고치면 다른 문서가 흔들린다.
   우리는 — 실측하면 — **`crates/hwp-typeset` 에 각주 처리가 0줄이다**
   (`grep -rn "footnote\|각주" crates/hwp-typeset/src/` → 0건. 파싱 쪽 hwp-model/hwp-hwpx 에는 있다).
   즉 우리는 이 축에서 **아직 틀리지만 빚도 없다.**
3. **중첩 표 · valign 정렬.** rhwp #4042/#4068/#4069(2026-08-04~05 신규).
   우리도 중첩 셀은 편집 대상이 아니고 과대 시 클립된다(MEMORY: table-pagination-split).
4. **native↔wasm 렌더 동일성.** rhwp #4046 은 측정기 폴백 사다리 비대칭을 잡아
   **byte-diff 하네스**(`scripts/svg_native_wasm_diff.mjs`)까지 붙였다.
   우리 `verify-local.sh` 에는 **wasm↔native SVG 바이트 동일 게이트가 없다** —
   `cargo check -p hwp-wasm` 위생 + `body-caret-crosscheck.mjs`(캐럿 축)뿐이다. 구멍이다.
5. **시각(픽셀) 축.** rhwp 는 픽셀 일치율을 상시 측정한다. 우리는 육안 QA 트랙뿐
   (`bench-corpus.sh` 주석: *"시각 충실도는 검증하지 않는다"*).

### 2.5 그들이 명백히 앞서 있는 것 (정직하게)

10k 규모 상시 서베이 · 픽셀 축 · bisect 귀속 제도 · 이미지 포맷 변환기(EPS/WMF/TIFF/PCX/BMP) ·
차트 렌더 · native↔wasm byte 하네스 · 에이전트 자기서술 표면(`capabilities --search`,
`export-agent-manifest`, `explain`) · Chrome/VSCode 확장 배포 · 3,400+ Rust 테스트 · 기여자 생태계.

---

## 3. breakthrough 후보 5개

선정 기준: **(a) 양쪽 다 막혀 있고 (b) 우리 아키텍처(저장 lineseg 오라클 · 게이트 체계)가
구조적으로 유리하며 (c) 우리 제품(브라우저 업로드→편집→PDF)에 직접 값이 되는 것.**

---

### B1. 줄 단위 오라클 — 그들이 "필요하다"고 적어 둔 도구를 우리는 이미 갖고 있다 ★가장 유망

**둘 다 막힌 지점.** rhwp #4054 원문: *"per-PI 쪽 위치 오라클은 문단 시작 쪽만 비교한다.
문단 중간의 줄 3개가 다른 쪽에 있어도 시작 쪽이 같으면 MATCH 다. (…) 줄 단위 어긋남을 보려면
저장 줄 좌표와 렌더 좌표를 직접 대조해야 한다."*
#3798 원문: *"쪽수·텍스트 추출·IR diff·쪽 밖 글자 — 어느 것으로도 침묵한다."*
그들의 잔여 실패는 **부호가 반대인 두 오차의 상쇄**인데, 쪽수 지표로는 상쇄가 곧 침묵이다.

**우리가 유리한 이유.** `hwp_core::layout_fidelity` 는 이미 **문단별 줄 수**를 저장 lineseg 와
대조한다(오늘 benchmark.hwp 91문단 98.9% / 셀 261문단 100%). 오라클이 파일 안에 있어서
Windows도 한/글 라이선스도 필요 없고, 기여자 노트북과 CI에서 **같은 값**이 나온다.

**접근 스케치**
1. 채점 해상도를 **줄 수 → 줄 vpos** 로 올린다. `LayoutFidelity` 에 문단별
   `our_line_vpos[] vs oracle_line_vpos[]` 를 싣고 **줄별 델타(px)** 를 낸다.
2. 그 델타의 **부호 있는 히스토그램**을 뽑는다. 상쇄 구조는 "합은 0인데 봉우리가 둘"로
   즉시 보인다 — 쪽수 지표가 침묵하는 바로 그 신호가 그림이 된다.
3. 게이트를 `쪽수 == ` 에서 `쪽수 == && Σ|줄 델타| ≤ 상한` 으로 승격. 상쇄 회귀가 막힌다.
4. `scripts/bench-local.sh` 출력에 델타 히스토그램 요약을 추가 → 기여자가 "우리 조판이
   어디서부터 밀리는가"를 파일 없이 제보할 수 있다.

**위험/전제.** 저장 lineseg 는 **한/글이 마지막으로 저장한 시점의 배치**다. 폰트가 없거나
문서가 기계생성이면 정답지가 아닐 수 있다 — rhwp #3798 이 정확히 이 이유로 저장 사다리를
판별자에서 뺐다(*"수혜 문서의 40%가 결재문서본문.hwpx 기계생성"*).
→ **먼저 오라클 신뢰도 등급을 매겨야 한다**(B2 와 한 묶음).

---

### B2. HWPX 오라클 공백 지도 + 파일 쌍으로 참값 합성

**둘 다 막힌 지점.** HWPX 는 lineseg 캐시가 자주 비어 있다(rhwp #2527 "빈 lineseg 자동 보정 시
글자 대량 겹침" · #2319 "lineseg 없는 기계생성 문서" · #2158 "재계산이 저장 쪽-상대 vpos 리셋
신호를 파괴"). 우리 실측도 같다 — **.hwpx 12건 중 9건이 셀 오라클 0건**, 쪽격차 10건.
그래서 우리 HWPX 게이트는 스스로 *"참값이 아니라 오늘 값을 못 박은 회귀 금지선"* 이라고 적는다.

**우리가 유리한 이유.** rhwp 의 정답지는 한/글 실행이므로, **HWPX 저장 열화가 정답지 자체를
오염**시킨다(같은 파일을 한/글이 열어도 다르게 조판하면 무엇이 참값인지 말할 수 없다).
우리는 다르다 — **같은 문서의 `.hwp`/`.hwpx` 쌍**을 갖고 있고(`bench-local-2026` 에 8쌍),
`.hwp` 쪽은 셀 lineseg 가 살아 있다. **한쪽의 오라클로 다른 쪽 경로를 채점할 수 있다.**

**접근 스케치**
1. `layout-check --oracle-audit` (신규): 문단/셀별로 오라클 **유무와 신뢰 등급**을 표로 낸다
   (`캐시있음` / `빈 lineseg` / `합성 흔적` / `vpos 리셋 신호 파손`).
   → 지금 "89.5%" 같은 수치가 **분모의 어느 부분에서 나온 값인지** 드러난다.
2. `layout-check --pair a.hwp b.hwpx`: 두 파일의 문단 시퀀스를 정렬하고,
   `.hwp` 의 lineseg 를 정답지로 `.hwpx` **프로덕션 경로**를 채점.
   → HWPX 게이트가 **잠금값에서 참값으로 승격**된다(이슈 075 가 원했던 것).
3. 승격된 게이트를 `verify-local.sh` HWPX 절에 배선. 8쌍이면 회귀 잠금으로 충분하다.

**추측(검증 필요).** 쌍 문서가 정말 동일 내용인지는 확인해야 한다 —
한/글 "다른 이름으로 저장"이 구역·문단을 재구성했다면 문단 정렬부터 깨진다.
1단계는 **문단 수·텍스트 해시 정렬률** 측정이고, 그게 낮으면 이 후보는 접는다.

---

### B3. 각주 세로 공간을 "빚 없는 상태"에서 per-page 로 처음부터 짓는다

**둘 다 막힌 지점.** rhwp 의 다음 큰 산이 **세로 공간 계산 재설계**(#3582 §4.1)이고,
그 최전선이 각주다. #2668 원문: *"각주가 밴드에 들어가는지 vs 본문을 줄이는지는 문서가 아니라
**페이지/각주 단위의 한글 배치 결정**이다. (…) 6종 IR 신호 + 재저장 기반 2종 모두 회귀/개선군
분리 실패."* 현행은 문서-레벨 상수 근사(`footer_band_reclaim` = 꼬리말 영역 높이 일률).
#4054 는 거기에 **40px 안전마진**까지 얹혀 1.0px 차이로 3줄이 밀린 사례다.

**우리가 유리한 이유(두 개).**
1. **`hwp-typeset` 에 각주 코드가 0줄이다**(오늘 grep 실측). rhwp 는 수십 회차 knife-edge
   보정이 서로 얽혀 *"같은 레버의 양끝"*(#4054) 상태지만, 우리는 **아무것도 안 고쳐도 되는
   백지**에서 시작한다. 처음부터 per-page 모델로 지을 수 있다.
2. rhwp 가 **실패까지 공개**해 놨다 — 어떤 신호가 판별자가 **아닌지**(IR 6종 + 재저장 2종)를
   우리가 다시 실험할 필요가 없다. MIT 라이선스 코드가 아니라 **공개된 측정 결과**를 쓰는 것이므로
   불변식 3(파싱 전용)과 충돌하지 않는다.

**접근 스케치**
1. 먼저 **센다**: 우리 코퍼스(게이트 4 + 로컬 49)에서 각주 보유 문서가 몇 건인지.
   0에 가까우면 이 후보는 우선순위를 내린다. *(현재 미측정 — 착수 전 필수)*
2. 각주 예약을 **페이지 확정 시점**에 계산한다(누적 참조값이 아니라).
   페이지별 실제 각주 높이 vs 꼬리말 밴드 상한을 per-page 비교.
3. 판별자를 **저장 lineseg 로 역산**한다 — 각주가 있는 쪽의 마지막 본문 줄 vpos 가
   "밴드를 내준 높이"를 직접 말해 준다. rhwp 가 IR 신호로 못 찾은 것을 우리는
   **정답지에서 직접 읽는다.** ← 이게 이 후보의 핵심이고, 그들 구조로는 못 하는 일이다.
4. 게이트: 게이트 v2 before==after + B1 의 줄 델타 상한.

**추측.** 3번이 성립하려면 각주 페이지의 저장 lineseg 가 살아 있어야 한다. B2 의
오라클 감사(`--oracle-audit`)가 선행 조건이다.

---

### B4. 3-way 판정 — `.hwp` / `.hwpx` / 저장 lineseg 로 "누구 잘못인가"를 가른다

**둘 다 막힌 지점.** HWPX 왕복 쪽수 발산은 rhwp 에서 열린 이슈만 4건 이상이고
(#4056/#4049/#3893/#3531), 우리도 같은 자리에 있다. 문제의 본질은 **책임 소재를 못 가르는 것**이다 —
쪽수가 달라졌을 때 ⓐ 한/글의 HWPX 저장이 정보를 흘린 건지 ⓑ 우리 HWPX 파서/조판이 틀린 건지
2-way 비교로는 분리되지 않는다.

**우리가 유리한 이유.** 우리는 **세 값**을 동시에 갖는다:
`.hwp` 자체 조판 / `.hwpx` 자체 조판 / 각 파일에 저장된 한/글 lineseg.
rhwp 는 자기 렌더 vs 한/글 두 값뿐이다.

**접근 스케치**
1. 진리표를 정의한다.

   | .hwp 우리↔오라클 | .hwpx 우리↔오라클 | .hwp↔.hwpx 오라클끼리 | 판정 |
   |---|---|---|---|
   | 일치 | 일치 | **불일치** | **한/글 저장 열화** — 우리 버그 아님. 계약으로 기록 |
   | 일치 | 불일치 | 일치 | **우리 HWPX 경로 버그** |
   | 불일치 | 불일치 | 일치 | **공통 조판 버그** |

2. `bench-local.sh` 가 이름이 비슷한 `.hwp`/`.hwpx` 쌍을 자동으로 묶어 이 판정을 낸다.
3. "한/글 저장 열화"로 판정된 것은 **고치지 않고 계약으로 문서화**한다 —
   *"이 문서는 .hwpx 로 저장하면 한/글 자신도 쪽수가 달라진다"* 를 사용자에게 보여 준다.
   벌크 퍼널의 신뢰도에 직결된다.

**값어치.** 지금 우리 HWPX 게이트가 "잠금값"인 이유가 바로 이 미분리다.
분리되면 게이트 상수 하나하나에 **왜 이 값인가**가 붙는다.
그리고 rhwp 에 그대로 제보할 수 있다 — 그들이 못 가르는 축을 갈라 주는 것이므로.

---

### B5. 문서 없이 격차를 유통하는 포맷 — "격차 지문"

**둘 다 막힌 지점.** 조판 결함의 병목은 코드가 아니라 **재현 문서 접근**이다.
rhwp 는 그걸 코퍼스 수십만 건 + Windows 오라클로 푼다 — 개인 기여자가 복제할 수 없는 규모다.
공문서·양식은 재배포 규율이 걸리고, 작성 완료본에는 개인정보가 있다.

**우리가 유리한 이유.** 오라클이 파일 안에 있으므로 **채점이 로컬에서 끝난다.**
`scripts/bench-local.sh`(오늘 추가)는 문서를 한 바이트도 옮기지 않고
"쪽수 Δ + 줄 일치율 + 구조 특징"만 뽑는다.

**접근 스케치**
1. 지문을 스키마로 고정한다(v0):
   `{쪽수 Δ, 문단 수, 줄 exact/±1, 셀 exact, 줄 델타 히스토그램(B1), 구조 플래그(다쪽 표·
   중첩 표·각주·어울림 그림·머리말·구역 수), 첫 어긋남 문단 인덱스}`.
   **텍스트·파일명·바이너리는 절대 넣지 않는다.**
2. `.github/ISSUE_TEMPLATE/layout-gap.md`(오늘 추가)가 그 지문을 받는다.
3. 지문만으로 **재현 문서를 합성**해 본다 — 구조 플래그로 최소 재현 .hwpx 를 생성하는
   `hwp-hwpx::synth` 확장. 되면 코퍼스 없이도 회귀 테스트가 는다.
4. (추측) 지문 포맷이 안정되면 rhwp 쪽에도 그대로 제보 가능한 **공용 격차 리포트**가 된다.
   다만 상호 운용하려면 문단 인덱싱 기준을 맞춰야 한다 — 그들의 PI 와 우리 문단 순번이
   같은 채번인지 **미확인**이다.

---

## 4. 우선순위 제안

| 순위 | 후보 | 근거 | 선행 조건 |
|---|---|---|---|
| 1 | **B2** 오라클 공백 지도 | 다른 전부의 분모다. 지금 우리 HWPX 점수가 무엇의 89.5%인지 모른다 | 없음 |
| 2 | **B1** 줄 델타 오라클 | rhwp 가 필요하다고 명시한 도구 · 우리는 8할 완성 | B2 (신뢰 등급) |
| 3 | **B4** 3-way 판정 | HWPX 게이트를 잠금값→참값으로 올린다 | B2 |
| 4 | **B5** 격차 지문 | 기여 퍼널의 화폐 — 오늘 1단계 배선 완료 | B1 (히스토그램) |
| 5 | **B3** 각주 per-page | 값은 크나 우리 코퍼스에 각주 문서가 몇 건인지 미측정 | 각주 문서 카운트 |

**즉시 할 수 있는 위생 2건** (breakthrough 아님, 그냥 구멍):
- `external/rhwp` v0.7.19 → v0.8.x 승급 검토 (v0.8.0 = "저장 왕복 보존 대공사").
  승급 전후 게이트 v2 before==after 를 반드시 기록.
- native↔wasm SVG 바이트 동일 게이트 신설 (rhwp #4046 이 그 하네스를 공개했다).
  우리는 지금 캐럿 축만 교차검증한다.

---

## 5. 출처

**디스커션**
- [#3582 10k 한글 오라클 서베이 시리즈(r5~r26) 메인테이너 정리](https://github.com/edwardkim/rhwp/discussions/3582) — 2026-07-30
- [#3498 반복 양식 문서 채우기용 document_core 연산 9종](https://github.com/edwardkim/rhwp/discussions/3498) — 2026-07-28
- [#3572 Chrome 확장 16주차 지표](https://github.com/edwardkim/rhwp/discussions/3572)
- [#183 HWPX 포맷에 대한 관찰 — 설계 결정의 잔재로 읽기](https://github.com/edwardkim/rhwp/discussions/183)

**조판/충실도 이슈**
- [#4054](https://github.com/edwardkim/rhwp/issues/4054) 각주 예약 과대 — 쪽수 지표가 상쇄로 침묵
- [#3798](https://github.com/edwardkim/rhwp/issues/3798) 쪽 끝 문단 트림 한도 부재
- [#4024](https://github.com/edwardkim/rhwp/issues/4024) 꼬리 줄만 적합 검사 → 쪽 밖 소실
- [#4042](https://github.com/edwardkim/rhwp/issues/4042) · [#4068](https://github.com/edwardkim/rhwp/issues/4068) · [#4069](https://github.com/edwardkim/rhwp/issues/4069) 중첩 표 · valign=Center
- [#3929](https://github.com/edwardkim/rhwp/issues/3929) · [#3928](https://github.com/edwardkim/rhwp/issues/3928) · [#3931](https://github.com/edwardkim/rhwp/issues/3931) 편람 축 A/C/E
- [#3386](https://github.com/edwardkim/rhwp/issues/3386) 표 높이 팽창 누적 수직 드리프트
- [#2668](https://github.com/edwardkim/rhwp/issues/2668) 각주 예약 높이 물리 정합
- [#2559](https://github.com/edwardkim/rhwp/issues/2559) 장문 보고서 +N 과다분할
- [#2148](https://github.com/edwardkim/rhwp/issues/2148) 선언 셀높이 신뢰 조건 부재
- [#3674](https://github.com/edwardkim/rhwp/issues/3674) 행정업무운영 편람 쪽수 편차

**HWPX / lineseg**
- [#4056](https://github.com/edwardkim/rhwp/issues/4056) · [#4049](https://github.com/edwardkim/rhwp/issues/4049) · [#3893](https://github.com/edwardkim/rhwp/issues/3893) · [#3531](https://github.com/edwardkim/rhwp/issues/3531) HWPX 왕복 발산
- [#2527](https://github.com/edwardkim/rhwp/issues/2527) · [#2319](https://github.com/edwardkim/rhwp/issues/2319) · [#2158](https://github.com/edwardkim/rhwp/issues/2158) lineseg 소실·재계산

**렌더/인프라**
- [#4046](https://github.com/edwardkim/rhwp/issues/4046) native↔WASM SVG 발산
- [#4062](https://github.com/edwardkim/rhwp/issues/4062) · [#4063](https://github.com/edwardkim/rhwp/issues/4063) · [#4064](https://github.com/edwardkim/rhwp/issues/4064) · [#4065](https://github.com/edwardkim/rhwp/issues/4065) 이미지 변환기
- [#3939](https://github.com/edwardkim/rhwp/issues/3939) · [#3940](https://github.com/edwardkim/rhwp/issues/3940) 차트 렌더

**방법론/로드맵**
- [#3556](https://github.com/edwardkim/rhwp/issues/3556) 방법론 v2 — 판정 함정 4종
- [#3907](https://github.com/edwardkim/rhwp/issues/3907) 에이전트-네이티브 로드맵 R1~R100
- [#3880](https://github.com/edwardkim/rhwp/issues/3880) 열린 로드맵 7개의 층과 순서
- [#3905](https://github.com/edwardkim/rhwp/issues/3905) 다중 에이전트 협업 — 경합 유실
- [#3869](https://github.com/edwardkim/rhwp/issues/3869) 설치 없는 실행 — 에이전트 동사 WASM 표면

**프로젝트**
- [edwardkim/rhwp](https://github.com/edwardkim/rhwp) (MIT) · [Releases](https://github.com/edwardkim/rhwp/releases)
- [Chrome Web Store — rhwp](https://chromewebstore.google.com/detail/rhwp-hwp-%EB%AC%B8%EC%84%9C-%EB%B7%B0%EC%96%B4-%EC%97%90%EB%94%94%ED%84%B0/pgakpjflombjmehnebnbpnalhegaanag)
- [Open VSX — HWP Viewer](https://open-vsx.org/extension/edwardkim/rhwp-vscode/)

**찾지 못한 것 (정직하게).** 제작자(edwardkim)의 개인 블로그·X·Threads 계정은 이번 조사에서
확인하지 못했다. 검색에 잡힌 Threads 글은 제3자의 소개 글이다. **공개 채널은 사실상 GitHub
Discussions 하나로 수렴**해 있고, 그래서 §1.1 의 디스커션 #3582 가 "요즘 무엇을 고민하는가"에
대한 1차 사료다.
