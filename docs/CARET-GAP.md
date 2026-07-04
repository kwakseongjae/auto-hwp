# CARET-GAP — 셀 캐럿 갭 실측 보고서 (issue 041 / FG-12 前半)

> 상태: **측정 완료 · 042 승격 준비됨**. 이 문서는 글리프 캐럿을 실제 벤치마크 문서에 얹으려 할 때
> 어디서 끊기는지(원인 체인)와 얼마나 끊기는지(클릭 분포 실측)를 고정하고, FG-12 後半(캐럿 UI, 042)이
> 무엇을 엔진 경계에 추가해야 하는지를 난이도/리스크와 함께 승격안으로 남긴다.
>
> 근거는 전부 코드 라인 인용 + `scripts/caret-geometry-smoke.mjs`의 실측 수치다(재현법 §6).

---

## 0. TL;DR

- **엔진 표면은 이미 있다.** `Intent::HitTest`(글자 단위 오프셋) + `Intent::CaretRect`(page px 캐럿
  사각형)가 존재하고, **wasm applyIntent JSON 경유로 런타임에서 실제로 동작한다**(rhwp 글리프 렌더가
  wasm에서 트랩 없이 도는 것을 실측). crates 무접촉으로 041 어댑터를 구현할 수 있었던 이유.
- **갭은 결정적이다.** 우리 벤치마크 3종에서 클릭이 **편집 가능한 NodeId로 해소되는 비율**:
  - `benchmark.hwp`(바이너리 .hwp): **0.0%** (전부 셀 아니면 미앵커 문단)
  - `benchmark1.hwp`(바이너리 .hwp): **0.0%**
  - `benchmark1.hwpx`(HWPX): 48.2% 앵커되지만 **여전히 51.8%가 셀 안** → node=None
- 즉 **NodeId 기반 CaretRect만으로는 우리 문서 본문에 캐럿을 못 준다.** 본문 대부분이 표 셀이기 때문.
  FG-12 後半은 **셀 주소형 캐럿(cell-addressed CaretRect)** 없이는 성립하지 않는다(§5 승격안).

---

## 1. 지금 존재하는 것 — 그리고 wasm에서 실제로 도는가

두 인텐트는 스키마 v0에 이미 있다(`crates/hwp-mcp/src/lib.rs`):

- `Intent::HitTest { page, x, y }` (lib.rs:789) → `Outcome::Hit(Option<HitResult>)` (dispatch lib.rs:1022)
  - `HitResult { node?, block?, offset, section, para_ord, in_cell, para_len }` (lib.rs:50–62)
- `Intent::CaretRect { page, node, offset }` (lib.rs:792) → `Outcome::Caret(Option<CaretRect>)` (lib.rs:1023–1024)
  - `CaretRect { x, top, height }` (lib.rs:66–71), page(unscaled) px = HWPUNIT/75.

wasm 배선은 `crates/hwp-wasm/src/lib.rs`의 `applyIntent`(:338–345)가 `hwp_mcp::apply_intent_json`에
그대로 흘려보내며, `Outcome`을 `outcome_to_json`(:427–456)이 `{kind:"hit", hit}` / `{kind:"caret", caret}`로
직렬화한다. `HitResult`/`CaretRect`는 `Serialize`라 그대로 나온다.

**함정 검증(실측):** CaretRect/HitTest는 `rhwp` 피처 게이트 뒤에 있다(lib.rs:322/386, 비-rhwp는 :377/405에서
`"needs a build with --features rhwp"` 에러). **wasm 기본 빌드가 이 피처를 켜는가?** →
`crates/hwp-wasm/Cargo.toml`의 `default = ["hwp5"]`, `hwp5 = ["hwp-mcp/rhwp"]`(:21–22)로 **켠다**.
그래서 `HitTest`/`CaretRect`가 기본 wasm 번들에서 동작한다.

> 컴파일 통과 ≠ 런타임 동작(`scripts/wasm-smoke.sh` 주석: std::fs 폰트는 wasm에서 트랩). 그래서
> **런타임을 직접 돌려 확인**했다: `applyIntent({intent:"HitTest",…})`가 `benchmark1.hwp`에서
> `{in_cell:true, node:null, offset:23, para_len:0, …}`를 반환하고, `benchmark1.hwpx`에서
> `{node:16, offset:92, para_len:158}` → `CaretRect` 왕복이 `{x,top,height}`를 돌려준다. **rhwp 글리프
> 렌더는 wasm 런타임에서 트랩 없이 돈다**(글리프 박스는 문서에서 추출 — 시스템 폰트 std::fs가 아님).

`--no-default-features`(HWPX-only, hwp5 off → rhwp off) 빌드에서는 두 인텐트가 `needs_rhwp` 에러를
던진다. 어댑터는 이 **한 가지 코드**만 `null`로 정규화한다(018 정책):
- `WasmAdapter.caretMiss`(packages/react/src/WasmAdapter.ts) — `code === "needs_rhwp"` → `null`, 나머지 전파.

---

## 2. 갭 원인 체인 (HitResult.node = None → CaretRect 사용 불가)

### 2.1 HitResult.node가 None이 되는 두 조건 — `hit_test_current` (lib.rs:335)

```rust
// crates/hwp-mcp/src/lib.rs:335
let (node, block, offset, para_len) = if hit.in_cell || hit.stable_key.is_none() {
    (None, None, hit.char_offset, 0)            // ← 캐럿 지오메트리는 있으나 편집 타깃은 None
} else {
    // resolve_key_to_node(doc, hit.section, hit.para_ord) → NodeId  (lib.rs:339)
};
```

두 원인이 **둘 다** 우리 코퍼스에 존재한다(§3 실측):

1. **`hit.in_cell`** — 글리프가 **표 셀 런** 안. 셀 문단은 모델(SemanticDoc)에는 존재하고
   `SetTableCellRuns`로 편집도 되지만, hit-test→NodeId 해석기 `resolve_key_to_node`는 **본문 문단의
   `(section, para_ord)` 키**로만 주소를 매긴다. 셀 문단은 그 키 공간에 없어서 v1은 의도적으로
   `node:None`으로 게이트한다(lib.rs:332–334 주석: "click never mis-targets the first body paragraph").
2. **`hit.stable_key.is_none()`** — 런에 안정 키가 없음. **바이너리 .hwp**를 파싱한 문단은 `para_index=None`
   이라 stable_key가 없다(HWPX 파생 문단은 있음). → node:None.

### 2.2 CaretRect도 NodeId에 의존 — `caret_rect_current` (lib.rs:386–403)

```rust
// crates/hwp-mcp/src/lib.rs:390
match hwp_core::node_to_section_para_ord(doc, NodeId(node)) {
    Some(sp) => sp,
    None => return Ok(None),          // 해소 불가 NodeId → null (throw 아님)
}
// … page_glyph_boxes → caret_rect_in_page(&boxes, section, para_ord, offset)  (lib.rs:401)
```

CaretRect는 **NodeId를 입력으로 요구**하고, 그것을 `node_to_section_para_ord`로 `(section, para_ord)`로
되돌린 뒤 글리프 박스를 보간한다. §2.1에서 node가 None이면 애초에 CaretRect를 호출할 인자가 없다 →
**셀 텍스트/미앵커 문단에는 캐럿 사각형을 못 만든다.** 이것이 갭의 핵심 체인:

```
표 셀 런  ─┐
           ├─→ HitResult.node = None ─→ CaretRect 호출 불가 ─→ 셀 텍스트에 캐럿 없음
미앵커 .hwp 문단 ─┘        (lib.rs:335)          (NodeId 인자 부재)
```

### 2.3 para_len 클램프 규약 (null로 문단끝 추론 금지)

node가 있는 경우, `HitResult.para_len`은 모델 편집 텍스트 길이로 클램프된다(lib.rs:344–345,
0-width 인라인 제외). 그리고 `caret_rect_in_page`는 **past-end 오프셋을 문단 끝으로 클램프**해 사각형을
돌려준다(**null이 아님**). 실측: `CaretRect(node=16, offset=para_len+50)` → `null` 아님(사각형).
→ UI는 **null 캐럿을 "문단 끝"으로 해석하면 안 된다**. 이 규약을 041에서 계약으로 고정:
- `HitResult.para_len` 주석(editor-core `types.ts`) + `clampOffset`(editor-core `caret.ts`) +
  `caret.test.ts`(past-end→paraLen, non-finite/음수→0) + 스모크의 past-end-non-null assert.

---

## 3. 벤치마크 클릭 분포 실측 (`scripts/caret-geometry-smoke.mjs`, 20px 격자)

각 문서의 **모든 페이지**를 20px 격자로 HitTest 스캔해, 글리프에 맞은 클릭을 세 버킷으로 분류했다:
- **in_cell** = 표 셀 런 (`in_cell:true`, node=None)
- **bodyAnchored** = 편집 가능 본문 문단 (`node != null`) — **캐럿을 줄 수 있는 유일한 버킷**
- **bodyUnanchored** = 셀 아님이지만 stable_key 없음 (바이너리 .hwp 문단, node=None)

| 문서 | 페이지 | 글리프 히트 | in_cell | **bodyAnchored** | bodyUnanchored |
|------|-------|-----------|---------|------------------|----------------|
| `benchmark.hwp` (바이너리) | 8 | 11,120 | 7,200 (64.7%) | **0 (0.0%)** | 3,920 (35.3%) |
| `benchmark1.hwp` (바이너리) | 18 | 32,240 | 19,400 (60.2%) | **0 (0.0%)** | 12,840 (39.8%) |
| `benchmark1.hwpx` (HWPX) | 25† | 25,040 | 12,960 (51.8%) | **12,080 (48.2%)** | 0 (0.0%) |

읽는 법:

- **바이너리 .hwp 2종: 앵커 0.0%.** 클릭할 수 있는 본문 텍스트 전부가 셀(≈60–65%) 아니면 미앵커
  문단(≈35–40%). NodeId 캐럿을 **한 글자도 못 준다.** 우리 벤치마크가 전부 .hwp 업로드임을 감안하면
  이것이 실사용 시나리오의 기본값이다.
- **HWPX 1종: 앵커 48.2%.** HWPX는 문단에 안정 키가 있어 본문에는 캐럿을 줄 수 있으나, **본문의 절반이
  여전히 셀**이라 셀 텍스트는 여전히 node=None. 우리 문서 본문 대부분이 표 안이라는 041 전제를 확증.
- **왕복 검증(HWPX):** bodyAnchored 히트 `node=16, offset=92, para_len=158`에서 `CaretRect` →
  클릭 라인 밴드에 들어오는 사각형, past-end 클램프 non-null, 미해소 node(9,000,000) → null(018).

† **부수 발견 — 페이지네이션 불일치:** `benchmark1.hwpx`는 own-render `pageCount()=25`인데 HitTest가
쓰는 **rhwp 글리프 렌더는 p14에서 끊긴다**(p15 조회 시 "페이지 15을 찾을 수 없습니다"). 즉 HitTest 스캔은
15p까지만 유효. 이는 own-render↔rhwp **페이지 수 불일치**(LOCKSTEP은 own-render 내부 place_doc↔NaiveLayout
계약이고, rhwp는 별도 렌더러)로, 041 스코프 밖이지만 042 캐럿 UI가 rhwp 좌표를 own-render SVG 위에 얹을 때
좌표계 정합을 깰 수 있는 리스크다. 스모크는 이 경우 우아하게 스캔을 멈추고 `⚠`로 보고한다.

---

## 4. 041에서 노출/고정한 것 (엔진 무접촉)

- **editor-core 모델**: `HitResult`/`CaretRect`/`TextAnchor` 타입(`types.ts`) + 순수 헬퍼
  `hitResultToTextAnchor`/`clampOffset`/`isCaretGap`(`caret.ts`). `TextAnchor.cell`은 042용 예약 필드.
- **EngineAdapter 시그니처**: `hitTestText(page,x,y)`(HitResult 전체) + `caretRect(page,node,offset)`
  (둘 다 optional, 018 null 정책).
- **두 어댑터 구현**: `WasmAdapter`(applyIntent JSON 경유, `needs_rhwp`→null 정규화),
  `TauriAdapter`(기존 `hit_test`/`caret_rect` 커맨드 경유, camelCase DTO → snake_case `HitResult` 리맵).
- **테스트**: editor-core `caret.test.ts`(모델+null+클램프), react `caretAdapter.test.ts`(Tauri 리맵),
  `scripts/caret-geometry-smoke.mjs`(실문서 왕복+분포).

---

## 5. 042 승격안 — 셀 문단에 캐럿을 주려면 엔진 경계에 무엇이 필요한가

FG-12 後半(캐럿 UI)이 성립하려면 §2의 두 원인을 각각 닫아야 한다. 우선순위는 실측이 정한다:
**셀이 본문의 절반 이상**이므로 셀 캐럿이 1순위.

### P1 — 셀 주소형 캐럿 (cell-addressed CaretRect) · **가장 임팩트 큼**
- **필요한 엔진 추가:**
  1. `HitResult`가 in_cell 히트에 대해 셀 주소를 실어야 한다: `table_block`, `row`, `col`,
     `para_in_cell`, `offset`. 현재는 `in_cell:true`만 있고 (row,col)이 없다(`table_cell_at`은 마킹용
     별도 표면). → `hit_test_current`의 in_cell 분기(lib.rs:335)를 "셀 주소 채우기"로 확장.
  2. **셀 주소형 CaretRect variant**: `Intent::CaretRectCell { page, section, block, row, col, para, offset }`
     → 셀 문단의 글리프 박스 보간. NodeId 우회(셀 문단은 `node_to_section_para_ord` 키 공간 밖).
- **난이도: 중.** 편집 경로(`SetTableCellRuns`)는 이미 셀을 주소로 다루므로 모델 측 주소는 존재한다.
  글리프 박스 측에서 (row,col,para) → 박스를 찾는 매핑이 새 작업. rhwp 글리프 박스가 셀 좌표를 들고
  있는지부터 확인해야 한다(들고 있으면 소).
- **리스크: 중.** ① 병합 셀/분할표 fragment에서 (row,col) 전역/지역 좌표 규칙(023 §좌표계) 재확인 필요.
  ② rhwp 글리프 렌더의 셀 para 순서와 모델 para 순서 정합. ③ §3†의 own-render↔rhwp 페이지 불일치가
  셀 캐럿에서도 재현될 수 있음(좌표계 통일 필요).

### P2 — 바이너리 .hwp 문단에 안정 키/NodeId 부여
- **필요한 엔진 추가:** .hwp 파싱 문단이 `stable_key`(para_index)를 얻어야 `resolve_key_to_node`가
  성공한다(현재 `stable_key.is_none()`으로 전부 탈락, lib.rs:335). 파서/모델에서 문단 인덱스를 채우거나
  대체 주소 체계 도입.
- **난이도: 중~상.** rhwp 무편집 원칙(§4 계약) 하에서 어댑터(crates/hwp-rhwp) 측에서 문단 인덱스를
  부여해야 하며, HWPX 경로와의 키 일관성/골든 회귀를 봐야 한다.
- **리스크: 상.** 문단 키가 HWPX↔.hwp 간 달라지면 편집 앵커/undo가 어긋난다. 골든 바이트동일 + 8==8·18==18
  게이트로 감싸야 함.

### P0 (042 착수 전 결정할 좌표계 문제) — own-render vs rhwp 렌더 정합
- §3†의 페이지 불일치는 **캐럿을 어느 렌더의 좌표에 얹을지**를 강제한다. 화면 SVG는 own-render인데
  HitTest/CaretRect는 rhwp 글리프 박스다. 042는 (a) own-render에 글리프 캐럿 표면을 추가하거나
  (b) rhwp 좌표↔own-render 좌표 변환을 넣거나 (c) 한쪽으로 통일해야 한다. **난이도: 상, 리스크: 상.**
  이 결정이 P1/P2보다 선행한다.

**요약 권고:** 042는 **P0(좌표계 결정) → P1(셀 캐럿) → P2(.hwp 키)** 순서. P1만으로도 HWPX 문서의 셀
텍스트(본문 절반)에 캐럿이 켜지고, P2까지 가면 바이너리 .hwp 업로드도 커버된다.

---

## 6. 재현

```bash
# wasm 엔진 빌드 (packages/engine/pkg 생성 — measure-engine.mjs와 동일 전제)
cargo build -p hwp-wasm --release --target wasm32-unknown-unknown
wasm-bindgen --target web --out-dir packages/engine/pkg \
  target/wasm32-unknown-unknown/release/hwp_wasm.wasm

# 실측 스모크 (오프셋/para_len 왕복 + 갭 분포 + past-end 클램프 + null 정책)
node scripts/caret-geometry-smoke.mjs
# → CARET_GAP_JSON 라인이 위 §3 표의 원수치. 실패 시 non-zero exit.
```

editor-core 모델/계약 테스트: `cd packages/editor-core && npm test` (`caret.test.ts` 포함).
