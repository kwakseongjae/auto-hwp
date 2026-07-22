# Tauri 셸 수렴 감사표 (issue 043)

> 목표: 데스크톱 셸(`crates/hwp-viewer/ui`)을 **`@auto-hwp/react`의 `HwpWorkspace` 소비**로 수렴시키기
> 위한 **전제조건 감사**. 이 문서는 두 방향을 전수 실측한다 — ① SDK가 요구하는 `EngineAdapter`
> 표면을 `TauriAdapter`가 얼마나 채우는가, ② 데스크톱이 이미 가진 기능을 어디로 보내는가(처분).
> **실행(수렴)은 044** — 이 문서 말미의 실행 계획을 그대로 따른다. **여기서 UI는 만들지 않았다.**
>
> 층 경계: `docs/PRODUCT-DIRECTION.md §4` + `docs/SDK-LAYERS.md`. `EngineAdapter`는 L1↔L2 seam이며
> `WasmAdapter`(웹)와 `TauriAdapter`(앱)가 **같은 계약**을 만족해야 editor-core/HwpWorkspace가 양쪽에서 돈다.

---

## 0. 좌표·단위 규약 실측 (§4.5 — 슬립은 클릭선택을 침묵사한다)

`own-엔진 지오메트리 커맨드는 px(=HWPUNIT/75), ops 커밋은 HWPUNIT`. 실측 결과 **어댑터에서 변환이 필요 없다**:

| 표면 | 단위(IN/OUT) | 근거 |
|---|---|---|
| `own_hit_test`/`table_at`/`table_cell_at`/`blocks_in_rect`/`table_col_boundaries`/`table_row_boundaries`/`page_geometry`/`caret_rect` | 페이지-로컬 **px** (own-render px) | `hwp-viewer` 커맨드가 `hwp_session`의 px↔HWPUNIT 경계를 **그대로** 통과(예: `own_hit_test` 테스트 `own_hit_test_resolves_a_px_click_to_the_pointed_block` — px→HWPUNIT→`block_at`, px로 반환). wasm 백엔드(`@auto-hwp/engine` `hitTest`/`tableAt`/…)도 **동일 px** 공간 → 어댑터는 px를 그대로 전달. |
| 편집 Intent(`SetTableColWidths`/`SetTableRowHeights`/`SetImageSize` 등) | **HWPUNIT / 모델 인덱스** | op-bus(`hwp_mcp::apply_intent`)가 HWPUNIT을 받는다. px→HWPUNIT/px→ratio 변환은 **editor-core `units.ts`**(단일 지점)에서 하고 어댑터는 완성된 값을 전달. |

⇒ `TauriAdapter`의 지오메트리 메서드는 **입력 px를 그대로 invoke 인자로, 반환 px를 그대로** 넘긴다
(vitest `tauriAdapter.test.ts`가 "invoke가 동일 x/y로 호출됨 + 반환 박스 그대로"를 잠근다). wasm과 px 공간이
동일하므로 클릭선택/이동/리사이즈가 두 백엔드에서 동일하게 동작한다.

---

## 1. SDK-요구 매핑표 — `EngineAdapter` 전수 × [043 전 `TauriAdapter` | 데스크톱 커맨드 | 043에서 한 것]

`HwpWorkspace`/`useHwpEditor`가 소비하는 표면은 editor-core(`session`/`selection`/`edit`/`caret`)를 통해
`EngineAdapter`로 내려간다. 아래는 grep 전수(`adapter.*(` in editor-core + react)로 확정한 **22개 메서드**.

범례: ✅ 완전 · ⚠️ 부분 · ❌ 없음/throw · `req`=필수, `opt`=선택(백엔드가 생략 가능)

| # | `EngineAdapter` 메서드 | req/opt | 소비처(HwpWorkspace 경유) | 043 전 `TauriAdapter` | 데스크톱 커맨드(043 전) | **043에서 한 것** |
|---|---|---|---|---|---|---|
| 1 | `open(bytes,name)` | req | `session.open` (문서 열기) | ✅ path 브릿지 | `open_doc` ✅ | — (host-chrome 브릿지 문서화) |
| 2 | `pageCount()` | req | `session.refreshPages` | ✅ | `own_page_count` ✅ | — |
| 3 | `pageSvg(n)` | req | `HwpPageView` | ✅ | `render_own_page` ✅ | — |
| 4 | `hitTest(p,x,y)` | req | 선택/컨텍스트메뉴/editor 열기 | ✅ | `own_hit_test` ✅ | — |
| 5 | `tableAt(p,x,y)` | req | 선택/editTarget/컨텍스트 | ✅ | `table_at` ✅ | — |
| 6 | `tableCellAt(p,x,y)` | opt | 셀 마킹·moveCell·editor·메뉴 | ❌ 생략 | `table_cell_at` ✅ | **✅ 배선(TS만)** |
| 7 | `blocksInRect(p,…)` | opt | 마퀴 선택(021) | ❌ 생략 | ❌ 없음 | **✅ 신규 커맨드 `blocks_in_rect` + 배선** |
| 8 | `tableColBoundaries(p,s,b)` | opt | 열너비 핸들(027) | ❌ 생략 | `table_col_boundaries` ✅ | **✅ 배선(TS만)** |
| 9 | `tableRowBoundaries(p,s,b)` | opt | 행높이 핸들(031)·moveCell↕ | ❌ 생략 | `table_row_boundaries` ✅ | **✅ 배선(TS만)** |
| 10 | `pageGeometry(p)` | opt | 룰러(027) | ❌ 생략 | `page_geometry` ✅ | **✅ 배선(TS만)** |
| 11 | `blockRuns(s,b,r,c)` | opt | 런 서식 보존(027 §함정) | ❌ 생략 | `get_block_runs` ✅ | **✅ 배선(TS만)** |
| 12 | `hitTestText(p,x,y)` | opt | 글자 캐럿(엔진 절반, 041) | ✅ (041) | `hit_test` ✅ | — |
| 13 | `caretRect(p,n,o)` | opt | 글자 캐럿(지오 절반, 041) | ✅ (041) | `caret_rect` ✅ | — |
| 14 | `applyIntent(intent)` | req | `session.applyBatch`(모든 편집·AI) | ⚠️ **5개만** 매핑, 나머지 throw | per-op 커맨드만 | **✅ 신규 커맨드 `apply_intent_json`(전 스키마) + 재배선** |
| 15 | `undo()` | req | `session.undo` | ✅ | `undo` ✅ | — |
| 16 | `redo()` | req | `session.redo` | ✅ | `redo` ✅ | — |
| 17 | `registerFont(f,b)` | req | `session.registerFont`(폰트픽커) | ✅ no-op | (없음) | — (데스크톱-네이티브 폰트 no-op 문서화) |
| 18 | `hasFont()` | req | PDF 버튼 가드 | ✅ true | (없음) | — |
| 19 | `exportPdf()` | req | PDF 다운로드 버튼 | ❌ throw | `export_doc_pdf`(경로) | **✅ 신규 커맨드 `export_pdf_bytes` + 배선** |
| 20 | `exportHtml()` | req | HTML 다운로드 버튼 | ✅ | `render_doc_html` ✅ | — |
| 21 | `toHwpx()` | req | (계약; HwpWorkspace 미소비) | ❌ throw | `export_hwpx`(경로) | **✅ 신규 커맨드 `export_hwpx_bytes` + 배선** |
| 22 | `dispose()` | req | 어댑터 교체 | ✅ no-op | (없음) | — |

### 매핑표 요약
- **총 22 메서드** (필수 14 + 선택 8).
- **043 전 완전 구현: 13** (open·pageCount·pageSvg·hitTest·tableAt·hitTestText·caretRect·undo·redo·
  registerFont·hasFont·exportHtml·dispose) **+ 부분 1**(applyIntent). **미구현 8**.
- **043 신규 완전화: 9** — `tableCellAt`·`blocksInRect`·`tableColBoundaries`·`tableRowBoundaries`·
  `pageGeometry`·`blockRuns`·`applyIntent`(전 스키마)·`exportPdf`·`toHwpx`.
- **결과: 22/22 구현됨(빈 칸 0)** — 매핑표 증빙 완료.
- **신규 additive Tauri 커맨드 4개**: `apply_intent_json`, `blocks_in_rect`, `export_hwpx_bytes`,
  `export_pdf_bytes`(모두 `hwp-session`/`hwp-mcp` 파사드 경유, 엔진 crate 로직 무접촉).
- **TS-만 배선(기존 커맨드 재사용) 5개**: `tableCellAt`·`tableColBoundaries`·`tableRowBoundaries`·
  `pageGeometry`·`blockRuns` — 데스크톱에 커맨드가 이미 있어 어댑터 메서드만 채웠다.
- **host-chrome/데스크톱-네이티브로 남긴 것 2**: `open`(네이티브 파일 다이얼로그 + bytes 브릿지),
  `registerFont`/`hasFont`(네이티브 폰트 스택 — 아래 §3 근거).

---

## 2. 데스크톱 기능 인벤토리 × [데스크톱 유 | SDK 유 | 처분 | 규모]

`crates/hwp-viewer/ui/src`(App.tsx 등) 정독 + 등록 커맨드 58종 전수. 처분 = **SDK 승격**(웹도 이득) /
**host chrome**(OS 표면) / **보류**(근거).

| 기능 | 데스크톱 | SDK | 처분 | 규모 |
|---|---|---|---|---|
| 찾기/바꾸기(Ctrl+F, `find_text`/`replace_text`) | 유 | 무 | **SDK 승격**(op-bus `Find`/`Replace` 이미 존재 → L2 커맨드 + L3 바) | M |
| 이미지 드래그드롭 삽입(`propose_insert_image`/`apply_insert_image`, onDragDrop) | 유 | 무 | **SDK 승격**(엔진 `InsertImageAt` 존재; 드롭 이벤트 자체는 host) | L |
| 이미지 이동/리사이즈 핸들(`image_at`/`image_bbox`/`set_image_size`/`move_image`) | 유 | 무 | **SDK 승격**(지오 커맨드 존재 → L3 오버레이) | M |
| 문서 아웃라인 패널(`doc_outline`, ⌘\\) | 유 | 무 | **SDK 승격**(읽기 커맨드 존재 → L3 패널) | S |
| 상단 리본(서식/글꼴/크기/색)(`set_*`/`char_fmt`) | 유 | 부분(FloatingToolbar·FontPicker) | **SDK 승격**(리본은 L3 조립; 액션은 027 core) | M |
| 상태바(page X/N·zoom) | 유 | 부분(toolbar meta+zoom) | **SDK 승격**(L3) | S |
| 캐럿 렌더/IME 인플레이스(`hit_test`/`caret_rect`/`insert_text`/`delete_back`) | 유 | 엔진 절반(041: `hitTestText`/`caretRect`) | **SDK 승격**(대화형 캐럿 UI = 042 후속; 엔진 seam은 완비) | L |
| 파일 열기(네이티브 다이얼로그, `open_doc`) | 유 | `open(bytes)` | **host chrome**(네이티브 다이얼로그) + 어댑터 bytes 브릿지(`resolveOpenPath`) | S |
| 파일 저장 atomic(`export_hwpx` 경로, `hwp_core::atomic_write` temp+fsync+rename) | 유 | `toHwpx()` bytes | **host chrome**(네이티브 저장 다이얼로그 + atomic 쓰기); 바이트 표면은 SDK(`export_hwpx_bytes`) | S |
| 내보내기 HTML/PDF(`export_doc_html`/`export_doc_pdf`) | 유 | `exportHtml`/`exportPdf` | **SDK 유**(바이트 export) + **host chrome**(경로 저장 다이얼로그) | S |
| 파일연결(.hwp/.hwpx associations, macOS .icns) | 유 | 무 | **host chrome**(OS 등록) | S |
| 배포용 문서(crypto/복호화) | **무**(현 viewer 미노출; rhwp-studio에만 존재) | 무 | **보류**(근거: 현재 어느 셸에도 없음 — 배포용 복호화는 엔진 하위 과제, 수렴과 무관) | L |
| 타이틀바(오버레이, `data-tauri-drag-region`) | 유 | 무 | **host chrome** — ⚠️ **재작업 금지**(아래 §함정) | S |
| 셀 음영/열너비 mm 정밀(`set_cell_range_shade`/`set_table_col_widths`, mm 입력·균등분배) | 유 | 부분(`shadeCellRange`/`setColumnWidths` ratio) | **SDK 승격**(mm 입력 UI는 L3 opt-in; ratio 변환은 units.ts) | M |
| 클립보드(`clipboard_read`/`clipboard_write`) | 유 | 무 | **host chrome**(OS 클립보드; 브라우저는 native clipboard API) | S |
| 표 추가·행 삽입·행높이(`table_add_rows`/`table_append_row`/`set_table_row_heights`) | 유 | **유**(`insertTable`/`insertRows`/`setRowHeights`) | (격차 아님 — 이미 양쪽 병렬) | — |
| 팬/줌·호버·마퀴·키내비·우클릭 메뉴 | 부분 | **유**(035/038/021/036/039) | (격차 아님 — SDK가 더 앞섬; 수렴의 동기) | — |

### 인벤토리 요약 (처분별)
- **SDK 승격 8**: 찾기/바꾸기 · 이미지 삽입 · 이미지 이동/리사이즈 · 아웃라인 · 리본 · 상태바 · 캐럿 · 셀음영/열너비mm.
- **host chrome 6**: 파일 열기 · 파일 저장(atomic) · 내보내기(경로 다이얼로그) · 파일연결 · 타이틀바 · 클립보드.
- **보류 1**: 배포용 crypto (근거: 현재 어느 셸에도 없음).
- **격차 아님(이미 병렬) 2군**: 표 편집 계열 · SDK가 앞서는 UX(팬줌/호버/마퀴/키내비/메뉴).

### SDK 승격 후보 우선순위 (044가 이식할 순서)
1. **찾기/바꾸기(M)** — op-bus `Find`/`Replace` 이미 존재, L2 커맨드 + L3 바만 추가하면 웹도 즉시 이득.
2. **아웃라인(S)·상태바(S)** — 읽기 커맨드/메타만으로 되는 quick win.
3. **셀음영/열너비 mm(M)·리본(M)** — 027 core 재사용.
4. **이미지 이동/리사이즈(M) → 이미지 삽입(L) → 대화형 캐럿(L)** — 오버레이/드롭/IME는 규모 큼(042 계열).

---

## 3. `registerFont` 데스크톱-네이티브 no-op 근거

wasm(브라우저)은 폰트가 **없어서** `registerFont(bytes)`로 메트릭+PDF 폰트를 주입해야 하지만, 데스크톱은
**네이티브/번들 폰트 스택**으로 렌더하고 PDF export(`hwp-export/pdf`)가 발견한 한글 face를 자체 subset한다.
따라서 `TauriAdapter.registerFont`는 **문서화된 no-op**, `hasFont()`는 **항상 true**(PDF 버튼 진행 가능).
바이트-주입 own-render 메트릭을 데스크톱에 넣는 것은 렌더 경로(모든 지오/`render_svg`)를 건드려야 해
**additive가 아니므로 044+ 범위**로 남긴다. HwpWorkspace 소비에는 영향 없다(문서는 실폰트로 이미 렌더).

---

## 4. 044 실행 계획 — 플래그 뒤 신 셸 → 검증 → 기본 전환 (기능 회귀 0 원칙)

**원칙**: 이 감사표의 **'데스크톱 유' 기능이 신 셸에서 하나라도 사라지면 전환 불가**. host chrome 6개는
신 셸에서도 Tauri 표면으로 감싸 유지하고, SDK 승격 8개는 HwpWorkspace(`enableEditing`) + 신규 L3로 채운다.

1. **플래그 뒤 신 엔트리(비파괴)**: `crates/hwp-viewer/ui`에 대체 진입점(예: `AppWorkspace.tsx`)을 추가하고
   env/빌드 플래그(예: `VITE_SHELL=workspace` 또는 `--mode workspace`)로 기존 `App.tsx`와 분기.
   **기존 App은 무변경** — 플래그 off면 현 앱 그대로.
2. **어댑터 배선**: 신 엔트리에서 `new TauriAdapter({ invoke, resolveOpenPath })`로 `HwpWorkspace` 마운트.
   `resolveOpenPath`는 네이티브 파일 다이얼로그 → 임시경로(또는 신규 `open_bytes` 커맨드) 브릿지.
   (043에서 어댑터 표면 100%가 이미 준비됨 — 이 단계는 순수 조립.)
3. **host chrome 6 재부착**: 파일 열기/저장(네이티브 다이얼로그 + atomic), 내보내기 경로 저장, 파일연결,
   **타이틀바(§함정 규율 그대로)**, 클립보드 — 신 셸 셸크롬으로 그대로 감싼다.
4. **SDK 승격 이식(우선순위순, §2)**: 찾기/바꾸기 → 아웃라인/상태바 → 셀음영·mm/리본 → 이미지/캐럿.
   각 이식은 L2 커맨드(이미 존재하면 재사용) + L3 opt-in UI, **웹에도 동시 반영**.
5. **회귀 체크리스트 그린 → 기본 전환**: 감사표 '데스크톱 유' 전 항목을 신 셸에서 수동 확인(0 회귀) 후
   플래그 기본값을 신 셸로. **롤백 경로(플래그 off) 유지**.

### 044 함정 (이 감사표가 못 박는 것)
- **트래픽 라이트 재작업 금지**: macOS 신호등 중앙정렬은 **"CSS 타이틀바 `h-9`(36px)"** 가 확정 해법(8라운드
  삽질 끝 `ccb9d5a`). `App.tsx`의 `<header className="… h-9 … pl-24 …">`가 그 규율이다. 044는
  `trafficLightPosition`/objc/decorum/config-y 재시도를 **하지 마라** — 신호등은 고정, CSS 바 높이로 맞춘다.
- **registerFont**: 데스크톱은 네이티브 폰트 no-op(§3) — 신 셸을 `fontCatalog` 없이 시작(폰트픽커 숨김),
  화면=PDF는 네이티브 스택으로 이미 성립.
- **배포용 crypto 보류**: 신 셸 전환의 게이트가 아니다(어느 셸에도 없음).
- **데스크톱 자체 UI는 044에서 수렴** — 043은 어댑터/커맨드 전제조건만(현 앱 무변경).

### 4.6 044 실행 결과 (플래그 뒤 신 셸 — 구현 완료)

`crates/hwp-viewer/ui`에 **비파괴 엔트리 분기**를 넣었다. 기존 `App.tsx`와 그 의존은 **한 줄도 안 건드렸다**.

- **엔트리 분기 (`src/main.tsx`)**: 빌드타임 상수 `__WORKSPACE_SHELL__`(vite `define`, `VITE_SHELL=workspace`일
  때만 `true`)로 분기. off면 esbuild/rollup이 `if` 블록(동적 `import("./WorkspaceShell")` 포함)을 통째로
  **DCE**하고 `else`만 남는다 — `else`를 레거시 부트스트랩과 **한 글자도 같게**(createRoot를 각 분기 안에서 호출,
  hoist 금지) 써서 **off 번들 = pre-044 번들 sha256 동일**(아래 검증). 롤백 = 플래그 제거.
- **신 셸 (`src/WorkspaceShell.tsx`)**: `new TauriAdapter({ invoke, resolveOpenPath })`로 `HwpWorkspace`를
  마운트(043에서 어댑터 22/22 완비 → 순수 조립). `resolveOpenPath`는 네이티브 경로를 `document.bytes`에 인코딩→
  디코딩하는 무비용 브릿지(임시파일/신규 커맨드 없음 — Rust `open_doc`가 실제 파일을 제자리에서 연다).
- **host chrome 4종 배선**:
  1. **타이틀바** — `h-9`(36px) + `data-tauri-drag-region` + `pl-24`. ccb9d5a 규율 그대로(신호등 고정, 재작업 0).
  2. **파일 열기** — `@tauri-apps/plugin-dialog` `open` → 경로 → `adapter.open`(resolveOpenPath 경유).
  3. **저장/내보내기** — HWPX 저장은 기존 **atomic `export_hwpx`**(P0-1: temp+fsync+rename) 경로 재사용;
     HTML/PDF는 `HwpWorkspace`의 신규 opt-in **`onExport`** prop이 브라우저 다운로드를 가로채 네이티브 저장
     다이얼로그 + 기존 `export_doc_html`/`export_doc_pdf`(같은 라이브 세션 재직렬화)로 보낸다.
  4. **드래그드롭 열기** — `getCurrentWebviewWindow().onDragDropEvent`(OS 경로) → `.hwp/.hwpx`면 open.
  나머지 2종(클립보드 심화·파일연결)은 §2대로 기존 앱 소유로 유지(신 셸 게이트 아님).
- **registerFont**: `fontCatalog` 미주입(폰트픽커 숨김) — 네이티브 폰트 no-op(§3) 그대로.
- **채팅(바이브 편집) — v1 비활성 (감사표 갱신)**: `HwpWorkspace.onAiRequest` 계약은
  `(instruction, anchors, ctx) => Intent[]`를 워크스페이스가 **미리보기→`adapter.applyIntent`로 커밋**하는 구조다.
  데스크톱 AI 경로는 **상태를 가진 dry-run/commit 게이트**(`ai_edit_propose`가 세션에 요약 제안을 스테이징 →
  `commit_proposal`이 적용)로, schema-v0 `Intent[]`를 절대 노출하지 않고 커밋도 `applyIntent`가 아니다.
  둘을 잇자면 **엔진 인접 신규 Rust 커맨드**가 필요 → 044 스코프의 "억지 개조 금지"에 걸린다. 그래서 v1은
  가짜 제안을 만들지 않고 **정직한 사유로 reject**(`WorkspaceShell.tsx`의 `disabledAi`). 수동 편집(`enableEditing`:
  더블클릭 제자리 편집·서식 툴바·열/행 크기·우클릭 메뉴)은 **완전 배선**되어 무영향. → 채팅 연결은 044+ 후속(신규
  커맨드가 `Intent[]`를 반환하도록 op-bus를 확장하는 별도 이슈).

**`HwpWorkspace`에 추가한 opt-in prop = `onExport?` 하나뿐**(웹 기본 동작 불변): 생략 시 기존 브라우저
`<a download>` 경로를 그대로 탄다. 웹 vitest(`workspaceShell.tauri.test.tsx`)가 "onExport 있으면 가로채고
`<a>.click` 미발생 / onExport 없으면 `<a>.click` 1회"를 **양방향으로 잠근다**(웹 불변 증명).

### 4.7 044 검증 결과 (자동)

- **ui vite build 플래그 off/on 둘 다 exit 0.** off 번들 = **pre-044 baseline과 `diff -rq` 동일(트리 전체)** +
  JS/CSS/index.html **sha256 3종 모두 일치**(App.tsx 등 기존 경로 파일 git diff 0). on 번들은 별도
  `WorkspaceShell-*.js` 청크(HwpWorkspace/onDragDropEvent/export_hwpx 배선)로 App은 트리셰이크됨.
- **`cargo check --workspace` = 0 · `cargo check -p hwp-viewer --features pdf` = 0** (엔진/커맨드 Rust 무접촉 —
  이번 044는 TS/설정/문서만 변경; `crates/hwp-viewer/src/*.rs` diff 0 → 게이트 v2(8==8·18==18)는 N/A).
- **`packages/react` vitest 180 그린**(기존 177 + 신규 `workspaceShell.tauri.test.tsx` 3: 마운트 스모크
  open→pageSvg→셀클릭 · onExport 가로채기 · 웹 불변).
- **웹 e2e**(`apps/hwp-lab`, `.next` 삭제 후 전 스펙): onExport는 opt-in이라 웹 앱은 미사용 → 무회귀.

### 4.8 수동 QA 체크리스트 — `VITE_SHELL=workspace cargo tauri dev`

GUI는 헤드리스 불가라 아래는 **사람이 도는 큐**(빌드·마운트 스모크까지가 자동, 나머지 수동):

```
# 워크트리/레포 루트에서 (빌드 순서: editor-core → ai-protocol → react → ui)
pnpm -C packages/editor-core build && pnpm -C packages/react build
VITE_SHELL=workspace cargo tauri dev   # (또는 tauri.conf의 beforeDevCommand에 VITE_SHELL 주입)
```

- [ ] **타이틀바**: macOS 신호등이 h-9 바 **세로 중앙**에 온다(재핀 금지 규율 유지). `열기`/`저장` 버튼 + 드래그 영역.
- [ ] **열기**: `열기` → 네이티브 다이얼로그 → .hwp/.hwpx 선택 → 렌더. 같은 파일 재선택도 재오픈.
- [ ] **드래그드롭**: Finder에서 .hwpx 드롭 → 열림. 비문서 파일 드롭 → "hwp/hwpx만" 안내.
- [ ] **렌더/상호작용**: 팬/줌 · 호버 프리하이라이트 · 키보드 셀 내비 · 우클릭 컨텍스트 메뉴 · 셀 더블클릭
      **리치 인플레이스 편집**(굵게/기울임/크기/색) → 커밋 후 반영.
- [ ] **저장(HWPX)**: `저장` → 저장 다이얼로그 → **atomic write**(temp+fsync+rename)로 기록, 토스트 확인.
- [ ] **내보내기(HTML/PDF)**: 내보내기 버튼 → 네이티브 저장 다이얼로그 → 파일 생성(브라우저 다운로드 아님).
- [ ] **채팅**: v1 비활성 — AI 전달 시 정직한 사유 노출(크래시 아님). 수동 편집은 정상.
- [ ] **회귀 0**: 플래그 off로 재빌드 시 기존 앱과 **동일**(위 자동 sha256 동일이 근거).

기본값 전환(플래그 default→workspace)은 **이 QA 전 항목 0 회귀 확인 후**의 후속 이슈다(044는 default 안 바꿈).

---

## 5. 검증(043)
- `cargo test -p hwp-viewer`(신규 커맨드 로직 4테스트 포함) · `cargo check --workspace` · 게이트 v2(8==8·18==18) ·
  네이티브 골든 바이트동일 · `cargo check -p hwp-wasm --target wasm32-unknown-unknown`(무영향).
- `packages/react` vitest(기존 160 + 신규 `tauriAdapter.test.ts`) 전부 그린 · 웹 e2e 무회귀.
- `crates/hwp-viewer` diff = **additive만**(신규 함수 4 + `generate_handler` 등록 4; 기존 커맨드/서명 무변경).
