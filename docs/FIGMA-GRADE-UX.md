# FIGMA-GRADE-UX — 피그마급 UX 격차 리서치 → 빌더블 백로그 (issue 033)

> 북극성: "성능적으로나 경험적으로나 — 수동 선택·편집 포함 — **피그마 수준**."
> 이 문서는 **현 코드 실측**만으로 격차를 특정하고, 이후 workflow(034+)가 바로 집을 수 있는
> 백로그로 정리한다. 모든 격차 주장에는 **측정치 또는 코드 인용**이 달려 있다("될 것이다" 금지).
> 측정 하네스: `scripts/figma-grade/` (tracked, 재현 가능). 030·031·032 가 고치는 항목은
> **"진행 중"** 으로만 표기하고 중복 조사하지 않는다.

측정 환경: Apple Silicon macOS, headless chromium (playwright 1228), 엔진 = `@tf-hwp/engine`
(wasm, `--features shaper`, NanumGothic(OFL) 등록 — lab 이 열기 직후 자동 등록하는 대표 상태).
픽스처: `benchmark.hwp`(8p) · `benchmark1.hwp`(18p, 자가진단 표 중심) · `benchmark2.hwp`(**25p, 표 75개/265행 — 최대 픽스처**).

---

## 0. 한 줄 진단 (실측 요약)

**엔진은 이미 빠르다. 병목은 전부 React/DOM 계층이다.** benchmark2(25p) 기준:
- 엔진 open(파싱→IR) **2.1ms**, 전 25페이지 SVG 생성 **~15.6ms**, hitTest(캐시) **0.001ms** — 전부 예산 이하.
- 그런데 **편집 1회 → 화면 반영 ≈ 125ms**(예산 100ms 초과): 엔진 렌더 18ms + **브라우저가 25페이지 전부를
  다시 sanitize+주입하는 107ms**. 편집된 페이지는 1개인데 25개를 다 재처리한다.
- **줌 1스텝 = 50.5ms 리플로우**(16ms 예산의 ~3프레임): 19,612개 SVG 요소가 한 DOM 에 다 얹혀 있어서.
- **패시브 스크롤은 부드럽다**(0% jank, 평균 8.3ms) — 정적 SVG 는 컴포지터 스크롤. 사용자가 느끼는 "버벅임"은
  스크롤이 아니라 **드래그(030 진행 중)·줌·편집반영**이다.

즉 피그마급으로 가는 길은 "엔진 최적화"가 아니라 **부분 갱신 + 페이지 가상화 + 드래그 경로 분리**다.

---

## 1. 레이턴시 예산표 (목표 vs 현재 실측치)

| 상호작용 | 목표 | **현재 실측치** | 격차 | 근거 |
|---|---|---|---|---|
| 클릭 → 선택 | <16ms | 엔진 hitTest **0.001ms/call**(025 캐시 후) + React setState/오버레이 | 엔진 ✓ · React 계층은 030 소관 | `measure-engine.mjs`; 025; 030 |
| 드래그 프레임 | <16ms | **진행 중(030)** — pointermove→setState→워크스페이스 전체 리렌더(030이 BEFORE/AFTER 측정 소유) | YES → 030 | issue 030 §진단 |
| 편집 진입(더블클릭) | <100ms | **진행 중(032)** — 팝오버 크롬 제거·제자리 편집; 엔진 blockRuns 조회 ~0ms | 대부분 UI → 032 | issue 032 |
| 문서 열기 | <1s/10p (→25p면 <2.5s) | benchmark2 25p **446ms**(파일선택→25시트 렌더 완료, wasm+폰트 fetch 포함) | **NO (예산 이하)** | `measure-browser.mjs` |
| **편집 적용 → 화면** | **<100ms** | benchmark2 **≈122ms** = DOM세 106.9ms(sanitize 28.6 + 재주입 78.3) + 엔진 렌더 ~15.6ms | **YES (초과)** | `measure-browser.mjs` + `measure-engine.mjs` |
| 스크롤 프레임 | 60fps(<16.7ms) | benchmark2 **avg 8.3ms · p95 9.0ms · max 9.4ms · jank 0%** | **NO (부드러움)** | `measure-browser.mjs` |
| 줌 프레임 | 60fps(<16.7ms) | benchmark2 줌 1스텝 **50.5ms 리플로우**(25 시트 width 변경) | **YES (초과)** | `measure-browser.mjs` |

엔진측 상세(`node scripts/figma-grade/measure-engine.mjs`, verbatim):

```
benchmark.hwp  (8p)
  open (parse→IR):        1.0ms   (min of 3)
  registerFont re-layout: 0.3ms
  SVG-DOM nodes:          total 4082  ·  max/page 698 (p7)  ·  avg/page 510
  full-doc render (ALL 8 pages, cold): 7.8ms   ← HwpPageView pays this on every refreshToken
  single-page re-render:  0.0ms
  hitTest (cached):       0.0ms/call
benchmark1.hwp  (18p)
  open (parse→IR):        2.4ms
  SVG-DOM nodes:          total 19943  ·  max/page 2625 (p16)  ·  avg/page 1108
  full-doc render (ALL 18 pages, cold): 16.3ms
benchmark2.hwp  (25p)
  open (parse→IR):        2.1ms
  SVG-DOM nodes:          total 19612  ·  max/page 2002 (p19)  ·  avg/page 784
  full-doc render (ALL 25 pages, cold): ~15.6ms
  single-page re-render:  0.1ms
  hitTest (cached):       0.0ms/call
```

브라우저측(`node scripts/figma-grade/measure-browser.mjs`, benchmark2, verbatim):

```
Open wall time (file-select → 25 sheets rendered): 446ms
DOM (all 25 pages mounted, no virtualization):
  total elements: 19825  ·  svg elements: 19612 (text 16014, line 3380)  ·  .hw-sheet: 25
Scroll (60 wheel ticks top→bottom): avg 8.3ms · p95 9.0ms · max 9.4ms · jank 0/176 (0%)
Zoom step (force width +20% on all sheets → sync reflow): 50.5ms (25 sheets)
Edit re-fetch DOM tax (browser half of HwpPageView refreshToken, all 25 pages):
  sanitizeSvg (DOMParser+serialize ×25): 28.6ms · re-inject innerHTML ×25 + reflow: 78.3ms · total 106.9ms
```

> **격차 있는 항목만 백로그로 넘긴다**: 편집반영(§6 FG-02), 줌(FG-03), (가상화가 이 둘을 함께 개선 → FG-01).
> 드래그/클릭/편집진입은 030·031·032가 이미 소유 → 백로그에 중복 신설하지 않고 의존으로만 표기.

---

## 2. 렌더링 아키텍처 격차 — 현재(페이지=거대 인라인 SVG DOM) vs 피그마(캔버스/GPU)

### (a) SVG DOM 한계 — 실측
- **구조**: 페이지당 하나의 인라인 `<svg>`, 그 안에 **평면(flat) 요소만** — `<g>`·`<tspan>`·`<clipPath>` 없음.
  benchmark2 전체 히스토그램: `text 16014 · line 3380 · rect 193 · svg 25` = **19,612 SVG 요소**
  (`scripts/figma-grade/nodes.sh` = wasm 과 동일 엔진 경로로 교차검증, 동일 수치).
  텍스트 런 1개 = `<text>` 1개(전 문서 16,014개), 셀 테두리 1개 = `<line>` 1개.
- **전 페이지 동시 마운트, 가상화 없음**: `HwpPageView.tsx:154` 의 `Array.from({ length: pageCount })` 가
  모든 페이지 시트를 렌더 → 브라우저 실측 **총 19,825 DOM 요소 · .hw-sheet 25개**(measure-browser).
- **어디까지 버티나(외삽)**: 페이지당 평균 784노드(표-중심 문서). 줌 리플로우가 노드 수에 선형(25p=50ms)이므로
  **~50p면 ~100ms, ~100p면 ~200ms** 줌 히치. 브라우저는 대략 30~60k DOM 노드부터 상호작용이 느려지는데,
  784노드/p × ~40p ≈ 31k → **40페이지대부터 DOM 노드 천장**에 근접. 텍스트-헤비 문서(benchmark1 = 1108노드/p,
  max 2625/p)는 더 빨리 도달. 패시브 스크롤은 컴포지터가 처리해 25p에서 0% jank지만, **줌/편집처럼 레이아웃을
  무효화하는 순간 전 노드 리플로우 비용**이 그대로 나온다.

### (b) 부분 갱신 — "편집 페이지만 재주입" — **실측: 아니오, 전 페이지 재조회 중**
- `packages/react/src/components/HwpPageView.tsx:61-80`: `refreshToken` 이 바뀌면 `for (let p = 0; p < pageCount; p++)`
  로 **모든 페이지**의 SVG 를 `adapter.pageSvg(p)` 재조회 → `sanitizeSvg` → `dangerouslySetInnerHTML` 재주입.
- `refreshToken` 은 `useHwpEditor.ts:40` 의 `onLayoutInvalidated(() => setRefreshToken(t => t+1))` — **편집/undo/폰트
  등록마다 무조건 +1**. 편집이 1페이지만 바꿔도 25페이지가 전부 재주입된다.
- 실측 비용: 브라우저 DOM세 **106.9ms**(sanitize 28.6 + 재주입 78.3) + 엔진 렌더 18ms ≈ **125ms/편집** → 예산 100ms 초과.
- → **FG-02**(페이지-선택적 재주입): 변경 페이지 집합만 재조회. 엔진은 이미 페이지별 SVG 캐시(025) 보유이므로 UI 쪽 배선만.

### (c) 페이지 가상화 (뷰포트 밖 언마운트) — **부재**
- measure-browser 가 `.hw-sheet = 25`(전부 마운트) 확인. 뷰포트 밖 페이지를 언마운트/플레이스홀더화하는 로직 없음.
- → **FG-01**(가상화): IntersectionObserver 로 화면 근처 페이지만 SVG 유지, 나머지는 높이만 보존한 빈 시트.
  이게 (a)의 DOM 천장·(c)의 메모리·(FG-03)줌 리플로우를 동시에 완화하는 **최우선 인프라**.

### (d) 장기 옵션 — 캔버스 렌더러 (엔진이 이미 PaintOp IR 보유)
- `crates/hwp-render/src/lib.rs`: **`PaintOp`**(`Rect`/`Line`/`Glyph`/`Image`) IR + **`PaintSink` trait**.
  `SvgSink` 는 그 sink 의 **한 구현일 뿐**이고 `CountingSink` 도 있다 — lib.rs:6 주석 "Both replay the SAME IR,
  so screen == export". 즉 렌더 표면은 이미 sink-무관.
- 타당성: **`CanvasSink`(네이티브 PDF/PNG 용)** 또는 **wasm→JS 로 PaintOp 리스트를 내보내 브라우저 `<canvas>` 페인트**
  경로가 구조적으로 자연스럽다. 히트테스트는 지금의 지오메트리 질의(px)를 그대로 유지(캔버스엔 DOM 노드가 없으므로).
- 난이도 XL·효과 High(대형 문서 확장성의 근본 해법) → **FG-16**. 단 **FG-01 가상화로 대부분의 체감이 해결되면
  캔버스는 실측으로 필요성이 확인된 뒤** 착수(과설계 방지).

---

## 3. 인터랙션 격차 카탈로그 (피그마 기준 · 우리 엔진 부품으로 가능한가 · 규모)

grep 기반 실측(부재 = 코드에 핸들러/로직 0). "있음"은 파일 인용.

| 인터랙션 | 현 상태(실측) | 엔진 부품 매핑 | 규모 | 백로그 |
|---|---|---|---|---|
| 스페이스+드래그 팬 | **부재**(팬 로직 grep 0; 빈공간 드래그는 marquee 전용, `selection.ts:276`) | 스크롤 컨테이너 scrollBy | S | FG-05 |
| 핀치 / ⌘+휠 줌(커서 중심) | **부재**(`onWheel`/`deltaY` grep 0; 줌은 컨트롤 버튼만) | 기존 zoom state + 커서 보정 | M | FG-04 |
| 더블클릭 심도 진입(표→셀→텍스트) | 셀 진입 있음(더블클릭→편집, 032 개선 중); 표→셀→텍스트 단계 커서/커밋은 032 | `tableCellAt`/`blockRuns` | — | 진행 중(032) |
| 방향키 셀 이동 | **부재**(키다운 Escape/Enter 만; Arrow grep 0) | 표 그리드 인덱스(CellHit rows/cols) | M | FG-08 |
| 다중 선택 | **있음** — marquee·⌘토글·⌘marquee union(`selection.ts:95 mergeSelection`) | — | — | (완료) |
| 다중 선택 **일괄 이동** | **부재**(선택만, 블록 이동 드래그 없음; 일괄 서식은 R13-4 완료) | 이동 intent + 고스트 프리뷰 | M | FG-15 |
| 호버 프리하이라이트 | **부재**(`onMouseEnter`/hover grep 0) | pointermove(스로틀)→hitTest | S | FG-09 |
| 컨텍스트 메뉴 | **부재**(`onContextMenu` grep 0) | core.edit 커맨드 위임 | S | FG-07 |
| 스마트 가이드/스냅 | **부재**(snap/guide grep 0) | 열/행 경계·마진 지오메트리 | L | FG-10 |
| 커서 상태 체계 | **부분** — `crosshair`(030이 default 로 교체 중)·`col-resize`(열/마진 그립)만. **text I-beam·row-resize·grab 부재**(`styles.css`) | hitTest kind→커서 매핑 | S | FG-06 |

---

## 4. 파싱 / 열기 격차

- **대형 문서 열기 시간(실측)**: benchmark2(25p, 360KB) 엔진 open(파싱→IR) **2.1ms**, 브라우저 open wall(파일선택→
  25시트 렌더 완료) **446ms**. 예산(<2.5s/25p) 대비 여유. — `measure-*.mjs`. (더 큰 실물은 레포에 없음 — 25p 가 최대
  픽스처. 노드 수는 텍스트-헤비 문서가 더 무거움: benchmark1 = 19,943 노드 > benchmark2 = 19,612.)
- **메인스레드 블로킹(코드 인용)**: `WasmAdapter.ts:75` `HwpDoc.open(...)` 및 모든 질의(`guard((d)=>fn(d))`,
  47-58행)는 **동기 메인스레드 호출**이다. 워커 없음 — 엔진은 `import { HwpDoc } from "@tf-hwp/engine"` 로
  메인 번들에 직접 로드(`WasmAdapter.ts:1`). 25p 는 2ms 라 무해하지만, **수 MB+ 실물 문서·악성 깊은중첩(R4)**
  파싱은 그 시간만큼 UI 스레드를 멈춘다. → **FG-14**(엔진 Web Worker 화 + async 브리지) — R4(입력 하드닝)와 정합.
- **폰트 로딩**: `LabWorkspace.tsx:65-78` 이 기본 NanumGothic 을 open 전 1회 fetch 후 registerFont(재조판 0.04~0.3ms).
  현재 병렬화 이슈 없음(단일 기본 폰트) — 카탈로그 다중 폰트 병렬 프리페치는 필요성 미확인, 백로그 제외.

---

## 5. 텍스트 편집 심화 로드맵 (제자리 편집 032 다음 단계)

현재: 032가 셀 **제자리 편집(plaintext textarea)** 을 도입 중. 그 위에 쌓을 단계 —

1. **런 단위(부분) 서식 편집** — 셀/문단 안에서 일부만 선택→볼드/색. 실측 격차: 032의 인플레이스 에디터는
   textarea/plaintext(032 §함정 "리치 서식 편집은 스코프 밖")라 부분 볼드 불가. 엔진은 **`SetTableCellRuns`/
   `SetParagraphRuns`**(run 보존 커밋 경로) 이미 보유. 데스크톱 richedit 이 contentEditable 로 이 UX 를 이미 구현
   (memory `char-format-editing.md`). → **FG-11**. ⚠️ 데스크톱 gotcha 재사용 필수: 에디터는 순수 `#000` 렌더
   (§4.1-7 스냅샷 no-op 전제), 커밋은 runs variant 로만(평문 variant 는 run 붕괴), strike 렌더+비교 포함.
2. **글리프 단위 캐럿/선택 렌더** — 실측 재사용 가능성: 엔진에 **`PlacedGlyph`**(글리프별 x/ch, `place.rs:21`)와
   **`Intent::CaretRect`**(`hwp-mcp/src/lib.rs:792,1023` + `caret_rect_current` + `hit_test_current`)가 있고
   **데스크톱 WYSIWYG 캐럿이 이미 소비**한다(`hwp-typeset/src/lib.rs:6`). 그러나 웹 `EngineAdapter`/`WasmAdapter`
   의 지오메트리 표면은 **블록/셀 레벨(`hitTest`→`BlockHit`, `tableCellAt`→`CellHit`)** 뿐 — glyph/caret 미노출.
   → **FG-12**: WasmAdapter 에 `caretRect`/glyph-hit 노출 + 오버레이 캐럿·선택 하이라이트(엔진 무변경, 표면만).
3. **IME 인라인 조합 표시** — 현재 셀 에디터는 IME 가드(composition 중 커밋 금지)만, SVG 위 인라인 조합 미표시.
   → **FG-13**: compositionupdate 를 캐럿 위치에 오버레이(FG-12 캐럿 위에 얹음).

데스크톱 richedit 교훈(memory `char-format-editing.md`, 웹 이식 시 그대로 적용): 에디터 순수 #000 렌더 /
멀티-para 셀은 "\n" 분할로 각 para_shape 보존 / strike 렌더+읽기+비교 / 명시 스타일 런은 exotic sub-attr 소실(v1) /
폰트는 표시 전용(oracle-safe) / 커밋은 `SetTableCellRuns`·`SetParagraphRuns` 로만.

---

## 6. 백로그 표 (각 행 = 034+ 이슈로 바로 승격 가능)

효과/난이도: S/M/L/XL. 우선순위 제안은 마지막 열. **030/031/032 는 이미 활성 → 신설 안 함**(의존으로만 표기).

| ID | 제목 | 근거(실측/코드) | 효과 | 난이도 | 의존 | 승격 스코프(한 줄) | 우선 |
|---|---|---|---|---|---|---|---|
| FG-01 | 페이지 가상화(뷰포트 윈도잉) | 25p 전부 마운트, 19,825 DOM 요소, `.hw-sheet=25`(measure-browser); 가상화 로직 0 | High | M | 030 | HwpPageView 에 IntersectionObserver — 화면 근처 페이지만 SVG 유지, 밖은 높이만 보존한 빈 시트 | **P0** |
| FG-02 | 편집 후 페이지-선택적 재주입 | `HwpPageView.tsx:61-80` refreshToken 마다 전 페이지 재조회; DOM세 106.9ms(measure-browser) | High | M | 025,030 | onLayoutInvalidated 에 변경 페이지 집합 전달 → 그 페이지만 pageSvg 재조회+재주입 | **P0** |
| FG-03 | 줌 리플로우 비용 절감 | 25p 줌 1스텝 reflow 50.5ms >16ms(measure-browser) | Med | M | FG-01 | 시트 width 변경 대신 CSS `transform: scale` 로 레이아웃 무효화 회피(+가상화로 보이는 페이지만) | P1 |
| FG-04 | 커서-중심 ⌘/휠 줌 + 핀치 | `onWheel`/`deltaY` 핸들러 0(grep) | High | M | FG-03 | 스크롤 컨테이너 wheel+ctrlKey 리스너, 커서 지점 기준 스케일+스크롤 보정 | P1 |
| FG-05 | 스페이스+드래그 팬 + grab 커서 | 팬 로직 0; 커서 crosshair/col-resize 만(styles.css) | Med | S | 030 | Space 다운→pan 모드, pointer 드래그→scrollBy, 커서 grab/grabbing | P2 |
| FG-06 | 커서 상태 체계(I-beam/row-resize/grab) | styles.css 커서 5종 중 text/row-resize/grab 부재 | Med | S | 031,032 | hover 지오메트리(hitTest kind)→동적 커서 매핑 | P2 |
| FG-07 | 컨텍스트 메뉴(우클릭) | `onContextMenu` 0(grep) | Med | S | 026 | 우클릭→앵커 기반 액션(복사/삭제/서식/행열 삽입) core.edit 위임 | P2 |
| FG-08 | 방향키 셀 이동(Arrow/Tab) | 키다운 Escape/Enter 만; Arrow 0(grep) | Med | M | 032 | 표 편집/선택 중 Arrow 로 인접 셀 이동(그리드 인덱스), Tab/Shift+Tab | P2 |
| FG-09 | 호버 프리하이라이트 | `onMouseEnter`/hover 0(grep) | Med | S | 030 | pointermove(스로틀)→hitTest→hover 오버레이 ref 갱신(리렌더 없이, 030 rAF 패턴) | P2 |
| FG-10 | 스마트 가이드/스냅 | snap/guide 0(grep) | Low | L | 031 | 열/행 경계·이미지 이동 시 인접 경계·마진 스냅 라인 | P3 |
| FG-11 | 런 단위 부분 서식(web) | 032 인플레이스 = plaintext(부분 볼드 불가); 엔진 Set*Runs 보유 | High | L | 032 | 선택 범위→run split intent(리치 에디터), 데스크톱 richedit gotcha(#000 렌더 등) 재사용 | P1 |
| FG-12 | 글리프 캐럿/선택 렌더(web) | 엔진 `PlacedGlyph`+`Intent::CaretRect` 존재(desktop 소비), 웹 어댑터는 block/cell 만 | High | L | FG-11 | WasmAdapter 에 caretRect/glyphHit 노출 + 오버레이 캐럿·선택 하이라이트(엔진 무변경) | P1 |
| FG-13 | IME 인라인 조합 표시 | 셀 에디터 IME 가드만, SVG 인라인 조합 미표시 | Med | M | FG-12 | compositionupdate 를 캐럿 위치에 조합 문자열 오버레이 | P2 |
| FG-14 | wasm 워커화(메인스레드 언블로킹) | `WasmAdapter.ts:75` open/질의 전부 동기 메인스레드; 워커 0 | Med | L | 015 | 엔진을 Web Worker 로, async 브리지, open/render off-main-thread(R4 정합) | P2 |
| FG-15 | 다중 선택 일괄 이동 | 다중선택 있음(selection.ts) but 블록 이동 드래그 0 | Med | M | 030 | 선택 블록 드래그→이동 intent + 고스트 프리뷰 | P3 |
| FG-16 | 캔버스 렌더러(장기) | hwp-render `PaintOp` IR + `PaintSink` trait(SvgSink 1구현, lib.rs:6) | High | XL | FG-01 실측 후 | CanvasSink or wasm→JS PaintOp 스트림→`<canvas>` 페인트, 히트영역은 지오메트리 질의 유지 | P3 |

**권장 착수 순서**: FG-01(가상화) → FG-02(선택적 재주입) 가 레이턴시 예산의 두 초과 항목(편집반영·줌)을 한 번에
내리는 **인프라 P0**. 그 위에 FG-03/04(줌 UX), FG-11/12(리치 텍스트 편집)를 P1 으로. 나머지 인터랙션(FG-05~10,13,15)은
소규모라 병렬 착수 가능. FG-16(캔버스)은 FG-01 이후에도 대형 문서에서 병목이 실측되면 착수.

---

## 부록 — 재현

모든 수치: `scripts/figma-grade/README.md` 의 절차(엔진 pkg 빌드 → `measure-engine.mjs` / dev 서버+`measure-browser.mjs`
/ `nodes.sh`). 게이트 무영향(docs+scripts 추가만): `cargo run -q -p tf-hwp-cli --features "shaper rhwp" -- layout-check
benchmarks/benchmark.hwp` → 8==8 유지.
