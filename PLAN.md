# tf-hwp — 구현 계획서 (PLAN)

> 자체 엔진으로 **.hwp / .hwpx를 넣고 → 원본 그대로 보여주고 → 수정하고 → .hwpx로 export**하는 데스크톱/웹 애플리케이션.
> 본 문서는 42-에이전트 생태계 조사 + 13-에이전트 집중 조사(타이포 분리 가능성 · rhwp 통합 · HWPX export 계약 · 한글 리본 인벤토리)와 사실검증 결과를 근거로 작성됨. 최종 업데이트: 2026-06-15.

---

## 0. 목표와 범위

### 0.1 한 줄 정의
HWPX를 *진실의 원천(source of truth)*으로 삼는 **포맷 중립 시맨틱 문서 모델(SemanticDoc) 기반 엔진**. 레이아웃/렌더는 rhwp(MIT)를 벤더링하고, **HWPX 직렬화·round-trip 안전·AI op-bus·타이포그래피 분리**만 직접 소유한다.

### 0.2 스코프
| | 포함 (In) | 제외 (Out) |
|---|---|---|
| 입력 | `.hwp`(HWP5 바이너리, OLE/CFB), `.hwpx`(OWPML/KS X 6101), `.hwp`(3.0 legacy read) | 비밀번호/배포용 문서는 후순위(Phase 5+) |
| 출력 | **`.hwpx` (export) only** | **바이너리 `.hwp` 쓰기 (Windows COM / 한컴 라이선스 의존) — 명시적 제외** |
| 동작 | 충실 뷰 · 편집 · AI 컨텐츠 작성 · 한글식 편집 기능 | 실시간 협업(CRDT), PDF/DOCX export → 후순위 |

> ✅ **사용자 확정**: export = **HWPX only** (2026-06-15; 한때 .hwp 다운로드를 검토했으나 철회). Windows COM 사이드카·유료 한컴 의존이 전부 제거되고 순수 크로스플랫폼·퍼미시브(MIT/Apache/BSD) 스택으로 성립. 2026-05-18 온나라 HWPX 의무화와도 정렬. .hwp는 입력(읽기/변환)만, 출력은 HWPX.

### 0.3 라이선스 정책 (하드 룰)
- **제품 링크 코드**: MIT/Apache/BSD만 (rhwp MIT, harfrust/rustybuzz/icu_segmenter, quick-xml/cfb/flate2 …).
- **GPL (LibreOffice + H2Orestart)**: 프로세스 격리 — `soffice` CLI로만 호출, 절대 링크 안 함. *정합성 오라클* 전용.
- **AGPL (pyhwp)**: 임베드 금지. 참조/디버깅만.
- **클린룸 경계**: hwpxlib/python-hwpx의 *샘플 데이터(Apache-2.0)*는 골든 코퍼스로 벤더링 가능, 단 *코드는 참조 전용* — 동작을 Rust로 재구현(소스 복사 금지).

---

## 1. 핵심 아키텍처 결정 (요약)

| 결정 | 선택 | 근거 |
|---|---|---|
| 언어/코어 | **Rust 단일 워크스페이스 → native + wasm32** | 유일한 FOSS 조판 선례(rhwp)가 Rust+WASM, 한 코어로 데스크톱·서버·브라우저, Korean 타이포 생태계(harfrust/rustybuzz/icu) |
| 데스크톱 셸 | **Tauri 2** (Electron ❌) | Rust 코어 in-process 재사용, 바이너리 ~10× 작음 |
| UI | TS/React (크롬·툴바·캔버스만) | 문서 로직은 전부 Rust/WASM |
| 진실의 원천 | **HWPX-canonical SemanticDoc AST** | 포맷은 codec, 렌더는 하위 projection |
| 레이아웃/렌더 | **rhwp 벤더 포크** (모델 경계 뒤) | FOSS 유일 조판 엔진; 자간/장평/금칙/옛한글 이미 구현 |
| HWPX 직렬화 | **자체 구현** (rhwp 직렬화기 ❌) | rhwp 직렬화기는 한컴 호환 미보장(issue #196) |
| round-trip 안전 | provenance + verbatim passthrough + dirty flag + dirty-only 재직렬화 | 생태계 #1 버그(데이터 손실)의 구조적 해결 |
| 편집 표면 | **단일 typed op-bus** (UI와 AI가 동일 사용) | raw XML 금지; hwpctl Action/ParameterSet/Field 모델 차용 |
| 정합성 검증 | LibreOffice+H2Orestart 오라클 + 골든 테스트 | "스펙 통과 ≠ 한컴 수용"; 행동 기반 허용오차 게이트 |

---

## 2. 시스템 구성

### 2.1 크레이트 레이아웃 (자체 소유 = 해자) — Phase 0 스캐폴드 구현됨, `cargo build` green

모든 외부 능력은 `hwp-model`의 **capability trait** 뒤에 둔다(능력=trait, 구현=교체 가능). rhwp 없이도 워크스페이스가 빌드·동작한다. 상세 정책: [docs/DEPENDENCY-STRATEGY.md](./docs/DEPENDENCY-STRATEGY.md).
```
tf-hwp/
├─ crates/
│  ├─ hwp-model/        # ★ SemanticDoc AST + capability traits + provenance/passthrough/dirty (thiserror만, wasm-clean)
│  ├─ hwp-ingest/       # 포맷 탐지 (CFB vs ZIP+OWPML) — 순수, wasm-clean, 동작
│  ├─ hwp-hwpx/         # HWPX 컨테이너 read + hp:t 텍스트 추출(동작) + ★ 자체 HWPX export 계약(4장)
│  ├─ hwp-typeset/      # ★ 분리된 타이포/레이아웃 (3.1) — LayoutEngine + FontMetricsProvider, 점진 자체화
│  ├─ hwp-render/       # PageLayerTree(paint IR, schemaVersion 1) → Canvas/WebGL · Skia(골든)
│  ├─ hwp-ops/          # ★ typed edit-op/command bus (UI+AI 공용) + undo/redo journal
│  ├─ hwp-ai/           # AST↔Markdown projection, op 제안 검증, MCP 서버 (Phase 4)
│  ├─ hwp-crypto/       # 배포용/비밀번호 복호 (Phase 5+; golden-vector)
│  ├─ hwp-rhwp/         # ★ rhwp 부트스트랩 어댑터 (feature `rhwp`; 없으면 inert → 워크스페이스 green)
│  ├─ hwp-oracle/       # LibreOffice+H2Orestart 오라클 (soffice CLI, GPL out-of-process, native)
│  ├─ hwp-core/         # ★ 능력 레지스트리/파사드: 능력별 최선 구현 조립 + open()/detect()
│  └─ tf-hwp-cli/       # CLI(bin `tf-hwp`): detect / info / extract-text / oracle (동작)
├─ external/rhwp/       # 벤더 부트스트랩 자리 (scripts/vendor-rhwp.sh로 submodule 추가, v0.7.15 pin)
├─ corpus/              # 골든 코퍼스 (hwpxlib 47샘플 데이터 + private/)
├─ docs/                # DEPENDENCY-STRATEGY.md, LICENSE-POLICY.md
├─ scripts/vendor-rhwp.sh
└─ .github/workflows/ci.yml   # fmt/clippy/test + wasm32 hygiene + cargo-deny licenses
```
> Tauri 셸(`tf-hwp-app`)과 TS/React UI(`ui/`)는 뷰가 붙는 Phase 1에서 추가.

### 2.2 데이터 흐름
```
파일 → ingest(탐지: CFB=HWP5 / ZIP+OWPML=HWPX / HWP3)
     → [crypto 복호, Phase5+]
     → rhwp 파서 → rhwp Document IR
     → 어댑터: SemanticDoc AST (모든 노드에 provenance 원본바이트/XML + passthrough bag + dirty=false)
       ├─(뷰)→ rhwp typeset → getPageLayerTree(schemaVersion 1) → render/ → Canvas/WebGL
       ├─(편집)→ ops/ 가 AST 변이 (dirty=true) → 증분 재레이아웃 → 재페인트
       └─(AI)→ ai/ 가 동일 ops/ 호출 (raw XML 접근 없음)
     → export: hwpx-export/ = dirty 노드만 재직렬화 + 나머지 verbatim
       → round-trip 안전 커널 검증 → 오라클(soffice) 수용 게이트 → .hwpx 출력
```

### 2.3 모델 경계
rhwp의 단일 `Document` IR(`src/model/document.rs`)가 우리의 **모델 경계 접합점**. 어댑터가 rhwp Document를 SemanticDoc로 들어올리고, UI/AI는 **절대 rhwp 타입을 직접 만지지 않는다**. 렌더 계약은 rhwp의 SVG 문자열이 아니라 **`getPageLayerTree` paint IR(PageLayerTree, schemaVersion 1, px, page-top-left, additive-only)** — 우리 캔버스가 페인트를 소유하고 타이포 서브시스템이 분리 가능하게 유지된다.

---

## 3. 세 가지 핵심 고려사항 설계

### 3.1 [고려사항 1] 원본 충실 렌더링 + 타이포그래피 분리

#### 조사 결론: 타이포그래피는 **분리 가능**하다 (2-레이어 구조)
- **(A) 선언적 스타일** = `CharShape/charPr`(글자모양) + `ParaShape/paraPr`(문단모양). HWP5 ↔ HWPX가 **1:1 대응**이라 포맷 중립 SemanticDoc 노드로 그대로 canonicalize. 엔진 로직 없음. → `model/`에 provenance 노드로 보관.
- **(B) 레이아웃/조판 엔진** = 줄바꿈·정렬·금칙·줄간격·라인박스·페이지네이션·세로쓰기. (text + 해결된 style + **주입된 폰트 메트릭**) → line segments + page layout. → `typeset/` 모듈.
- 경계는 순수 함수로 정의: `layout(runs_with_charshape, parashape, column_geometry, FontMetricsProvider, writing_mode) -> Vec<LineSeg> + PageLayout`. **`FontMetricsProvider`를 명시적 주입 의존성**으로 — 폰트 메트릭이 유일한 강결합(같은 메트릭이라야 같은 줄바꿈 재현). 골든 테스트는 폰트를 pin.

#### ⚠️ 결정적 사실: LineSeg(linesegarray)는 비표준 캐시
한컴 개발자 공식 답변 — `linesegarray`는 레이아웃 위치 메타데이터로 **OWPML 표준이 아니며, 한글은 열 때 재계산**한다(줄바꿈의 진실은 `<hp:lineBreak/>` + 스타일). 따라서:
- 미편집 문단 → 저장된 LineSeg **재생(replay)** = 빠르고 픽셀 충실한 *읽기 전용* 렌더.
- 편집된(dirty) 문단 → 레이아웃 엔진 재실행, export 시 linesegarray 재생성하거나 **stale lineseg는 제거**(python-hwpx도 dirty 섹션 저장 시 strip — 안 하면 한컴이 거부).
- 정합성 게이트는 **바이트 동일성이 아니라 허용오차 기반 행동 비교**.

#### rhwp가 이미 주는 것 (소스 검증으로 정정됨)
초기 조사는 "rhwp가 자간/장평/금칙/옛한글 미구현"이라 했으나 **소스 검증 결과 모두 구현되어 있음**:
- 자간: `style_resolver.rs` `letter_spacing` + 7-언어 `letter_spacings` (주석 "자간")
- 장평: `ratios[0] // 한국어 장평`, SVG `transform="scale(ratio,1)"`
- 금칙처리: `line_breaking.rs` `is_line_start_forbidden`("줄 머리 금칙")/`is_line_end_forbidden`("줄 꼬리 금칙") + CJK 구두점 테이블 (Task #100 Done)
- 옛한글/Hanyang PUA: 전용 5807-line `pua_oldhangul.rs` (`map_pua_old_hangul`, `PUA_OLDHANGUL_MAP`), Source Han Serif K Old Hangul fallback 번들
- 세로쓰기, 다단, 번호/글머리표, 줄간격/들여쓰기/정렬/탭, 셀 병합/테두리/수식/행분할, 이미지 효과 — 모두 렌더

**즉 차트/도표/수식/도형/표/이미지를 포함한 원본 뷰는 rhwp가 거의 다 커버**한다. MVP의 렌더 신규작업은 최소.

#### 그러나 rhwp의 한계 (직접 보강 필요)
- 글자 폭을 **host Canvas `measureText`로 측정**(WASM이 폰트 못 읽음) — GSUB/GPOS 셰이핑 없음, native는 `ttf-parser` 메트릭. → 환경 의존적 메트릭(웹뷰 vs 골든 raster 불일치 위험).
- 미구현(문서 명시): **widow/orphan 제어, kerning/glyph shaping, ligature, hanging punctuation**. HWP ParaShape의 widowOrphan/keepWithNext/keepLines/pageBreakBefore, CharShape의 useKerning을 매핑·보강해야.
- 한컴 전용 HY/한컴 폰트 미번들(fallback 폰트 사용) → 폰트 부재 시 줄바꿈 달라짐.
- 정합성은 pre-parity(로드맵 v1.0 조판 성숙, v3.0 한컴 동등).

#### 장기 타이포 자체화 스택 (rhwp 메트릭 대체 시)
- **셰이퍼: harfrust** (공식 harfbuzz-org, HarfBuzz v13, fontations/read-fonts, 순수 Rust, Hangul 복합 셰이퍼 ljmo/vjmo/tjmo) — parley·cosmic-text가 표준화한 것. **fallback: rustybuzz** (HarfBuzz v10.1, `no_std` + `wasm-shaper` feature). *주의: harfrust wasm32 빌드는 명시 문서 없음 → 벤더 시 실제 빌드 확인.*
- **줄바꿈 기회: icu_segmenter** (완전 UAX#14) → 그 위에 한컴 **금칙 post-filter**(줄머리/줄꼬리 금지 문자집합).
- **옛한글: Hanyang PUA → Unicode 첫가끝** 변환 테이블을 데이터로 보유(어떤 crate도 안 함) → 셰이핑 전 패스. 현대 한글 NFC는 `unicode-normalization`.
- **직접 구현 필수(어떤 crate도 없음)**: 자간(클러스터 advance delta), 장평(glyph advance/outline 비등방 수평 스케일 — 합성 폰트크기 변경 ❌), 배분정렬/나눔(글자 단위 slack 분배, 사이사이 Latin 포함 — parley/cosmic-text의 justify는 부정확), 세로쓰기(vert/vrt2 GPOS + CJK 세로 메트릭). 단위 레이어 1개로 일원화(HWPUNIT 1in=7200 ↔ font units ↔ px@dpi).
- 셰이핑/레이아웃은 공유 Rust에서 → native와 wasm이 동일 줄바꿈/정렬 생성(골든 테스트·한컴 수용 게이트의 전제). swash/skrifa+tiny-skia(native)·Canvas(웹)는 **rasterization 백엔드로만**.
- **참고**: layout 레이어는 **parley**(Linebender, HarfRust 기반, `Alignment::Justify`, wasm-ok)를 reference/차용. CanvasKit은 wasm32 미지원, native-skia는 native 전용.

#### Korean 타이포 핵심 enum (스타일 모델 freeze 기준)
- 정렬: `JUSTIFY(양쪽) / LEFT / RIGHT / CENTER / DISTRIBUTE(배분) / DISTRIBUTE_SPACE(나눔)` — 3개 full-width 모드는 CSS text-align로 환원 불가.
- 줄간격: `PERCENT / FIXED / BETWEEN_LINES / AT_LEAST` (W3C klreq 4모델).
- 줄나눔: Latin `KEEP_WORD/HYPHENATION/BREAK_WORD`, 비Latin `KEEP_WORD(어절)/BREAK_WORD(글자)`.
- CharShape per-script 7배열: hangul/latin/hanja/japanese/other/symbol/user × {faceID, ratio(장평 50~200%), spacing(자간 -50~50), relSz, offset}.

> **정합성 acceptance-gate 최우선 타깃 4종**(가시적 reflow 차이의 대부분): 자간/장평 advance 계산, 3정렬모드, 금칙 문자클래스, 줄간격 4모드. 이것을 LibreOffice 오라클 대비 골든 테스트한다.

---

### 3.2 [고려사항 2] AI 컨텐츠 작성

#### 원칙: AI는 사람과 **동일한 typed op-bus**만 사용 (raw XML/바이트 접근 0)
모든 AI 변이가 사람 편집과 똑같이 검증·undo·round-trip 안전 보장을 받는다.

#### 레이어
1. **읽기(RAG) projection**: SemanticDoc → 구조보존 Markdown/JSON (표=그리드, 수식=문법, 안정 NodeId, 제목/리스트 계층). PDF→텍스트 우회(한컴 측정 15.8× 느림, LangChain 네이티브 HWP 로더 부재)의 대체. LangChain/LlamaIndex 로더로도 배포.
2. **op 스키마 = 도구**: LLM은 `insert_paragraph / fill_table_cells / set_char_pr / apply_style / set_field_value / generate_from_template …` 등 **검증되는 typed op**를 제안. 단일 버전드 스키마(34~140개로 파편화된 MCP 동물원의 해법).
3. **쓰기/채우기 루프**: AI 제안 op → scratch AST에 적용 → 레이아웃 검증(셀에 맞나?) + round-trip 검증 → **diff 미리보기(변경내용추적 스타일)** → 사람 승인 → commit. AI는 자동 저장 금지.
4. **MCP 서버**: 동일 op 스키마를 외부 에이전트에 노출. 서버사이드·동시성 안전(요청마다 격리 AST 트랜잭션) — Windows+COM 단일 프로세스 hwp-mcp와 대조.
5. **근거**: fill-from-source는 검색 span을 NodeId로 인용 → 리뷰어 추적 가능. 모델은 Claude(Anthropic API), 인터페이스 뒤 교체 가능. 문서 outline에 prompt caching.

#### 선례 (검증)
`treesoop/hwp-mcp` (TypeScript, `@rhwp/core` npm 의존, 34 tools 6그룹, **write=HWPX-only**)가 rhwp 자동화 접합 + HWPX-only 쓰기 패턴을 입증. 우리 op-bus 표면의 reference이자 업스트림 파싱 회귀 탐지 canary.

---

### 3.3 [고려사항 3] 한글 상단 컨트롤 박스(리본) 기능

한글 리본 = 9탭(파일/편집/보기/입력/서식/쪽/보안/검토/도구) 중 **편집·입력·서식·쪽·검토** 5개가 문서 편집 표면. op-bus는 (a) HWPX로 표현 가능하고 (b) rhwp가 렌더하는 것만 op로 가지면 된다 → **렌더는 거의 다 커버, 작업은 EDIT/WRITE side**.

#### 설계 원칙
- **서식은 property-set op** (인라인 속성 ❌): OWPML은 글자모양/문단모양/스타일을 `header.xml` dedup 풀에 두고 `charPrIDRef/paraPrIDRef/styleIDRef`로 참조. `set_char_pr`/`set_para_pr`/`apply_style`은 property map을 싣고 직렬화기가 **intern(있으면 재사용, 없으면 생성)** → "스타일 1개 고치면 전체 reflow" + 풀 비대 방지.
- **section/구역 op가 먼저**: 쪽 탭의 모든 것(용지/여백/단/쪽번호/테두리/머리·꼬리말/바탕쪽)이 **section-scoped**. `insert_section_break` + section-addressed op가 개별 쪽 op보다 선행.
- **무거운 객체는 passthrough 우선**: 차트/수식/도형/OLE/누름틀/변경추적은 편집 op 전에 verbatim passthrough로 round-trip 보존(rhwp가 이미 렌더). 편집 op는 나중.
- **클립보드 = HWPX fragment**, 모양복사 = `set_char_pr`+`set_para_pr` 합성 → 붙여넣기 서식 손실(한글 고질문제) 방지.
- UI와 AI는 동일 op에 바인딩. 이 인벤토리 표가 곧 **op-bus 커버리지 체크리스트 + 골든 테스트 시드**(그룹당 문서 1개).

#### 3-웨이브 op 커버리지
- **Wave 1 (MVP, 뷰+편집+export)**: 텍스트(insert/delete) · set_char_pr · set_para_pr · apply_style · 번호/글머리표 · 표(삽입+행/열/병합/분할/셀테두리·여백) · 이미지 삽입(+BinData) · 클립보드(cut/copy/paste HWPX-fragment) · 찾기/바꾸기 · 페이지 설정 + section · 머리/꼬리말 · 각주/미주 · 쪽번호 · 책갈피 · 하이퍼링크 · undo/redo.
- **Wave 2 (Later)**: 차트/수식/도형 **authoring** · 누름틀/필드 · 메모 · 변경내용추적 · 다단 미세조정.
- **Wave 3 (Optional)**: 글맵시 · 옛한글/세로쓰기 authoring · 개체 그룹. 맞춤법/사전/번역/문서비교 = 툴 사이드, op-bus 밖.

---

## 4. HWPX export 계약 & round-trip 안전 커널 (자체 구현의 핵심)

> rhwp 직렬화기는 한컴 호환 미보장(issue #196: 한컴2020이 손상 판정, 표/이미지/스타일 손실 가능). **export는 100% 자체 구현**하고 python-hwpx(Apache-2.0, PyPI 2.9.1)의 동작을 Rust로 재구현한다.

### 4.1 PR #40 3종 불변식 (한컴 거부의 3축 — 각각 단독으로 "손상" 유발)
1. 모든 `sec/head` XML 선언에 **`standalone="yes"`**.
2. `sec/head` 루트에 **15개 HWPML 호환 네임스페이스 surface** (`ha, hp(2011), hp10(2016), hs, hc, hh, hhs, hm, hpf, dc, opf, ooxmlchart, hwpunitchar, epub, config`) — XSD 요구가 아니라 *de-facto 한컴 호환 계약*.
3. **mimetype 첫 엔트리 + ZIP_STORED**, 나머지는 **원본 archive 순서 + per-entry ZipInfo**(date_time/compress_type/extra/flag_bits…) 보존, 새 part만 끝에 추가.

### 4.2 dirty-only 재직렬화 (round-trip 안전의 구조적 보장)
- 미변경 part는 **원본 바이트 그대로**(provenance bag) 다시 쓰기. dirty part만 재직렬화.
- 한 셀 편집이 다른 곳의 캡션/메모/차트데이터를 건드릴 수 없음 = 생태계 #1 버그(데이터 손실)의 정공법.
- 절반만 모델링된 노드를 건드리면 → 편집 거부 또는 verbatim fallback(보수적 dirty 마킹).

### 4.3 acceptance 게이트 = `validate_editor_open_safety` 포팅
- 매 저장마다 실행. `ok = (블로킹 패키지 에러 0) AND (재오픈 round-trip 성공) AND (스키마 lint clean)`.
- 블로킹 마커: standalone 누락 · HWPML 루트 ns 누락 · manifest href 누락 · mimetype 비-첫엔트리/비-STORED · 표 필수 자식(`tbl`엔 sz/pos/outMargin/inMargin, `tc`엔 subList/cellAddr/cellSpan/cellSz/cellMargin) · `secPr`는 첫 문단 첫 run에 · stale lineseg textpos.
- **XSD는 WARNING-only convergent lint**(스펙 통과 ≠ 한컴 수용). 진짜 오라클 = 47-샘플 코퍼스 + LibreOffice/H2Orestart(+가능 시 한컴) 교차검증.

### 4.4 ID 정합성
생성 id = `uuid4 & 0x7FFFFFFF` (signed int32 `[0, 2^31)`). `*IDRef → header 테이블` 매핑 검증(charPr/paraPr/style/borderFill/bullet/numbering/tabPr/binaryItem/memoShape + fontRef 7-언어). sentinel `charPrIDRef=0xFFFFFFFF` 허용. orphan BinData 탐지.

### 4.5 객체별 규칙
- **이미지**: 3-step — `BinData/..` 쓰기 + manifest item 추가 + header binItem, 이후 `<hp:pic>` 그래프(imgRect/imgClip/imgDim/hc:img/effects).
- **표**: `border_fill_id_ref` 필수, 한컴 필수 자식 전부 emit. 병합 = covered 셀 **비활성화(span 1×1, size 0, 텍스트 clear)** — 삭제 ❌(렌더러/익스포터가 이 관례 이해해야).
- **알려진 미완성(하드 게이트)**: 전체 `<hp:pic>` 그래프, shape/control, 차트, connect-line 제어점, 수식, 암호화 HWPX → **재생성보다 verbatim passthrough 우선**, 오라클 통과 전엔 export-safe 표시 금지.

### 4.6 한컴(특히 macOS) 호환 hint (WARNING으로 만족)
`Preview/PrvText.txt` 포함 · `hh:head version=1.4` · `hh:compatibleDocument targetProgram=HWP2018` · bold charPr에 채워진 `hh:fontRef` · dirty 섹션의 stale `linesegarray/lineseg` strip. mimetype 리터럴 `application/hwp+zip`, content.hpf media-type `application/hwpml-package+xml`.

---

## 5. rhwp 벤더링 전략

- **소비 모델: 벤더 포크** (crates.io 부재 — `cargo add rhwp` 불가). edwardkim/rhwp를 **fork → git submodule, v0.7.15(2026-06-06) 태그 pin**. native + wasm32 둘 다 소스에서 빌드. (DanMeon/rhwp-python의 PyO3+submodule 패턴과 동일.)
- **모델 경계**: `model` 크레이트(단일 Document IR) 접합점. 어댑터가 SemanticDoc로 lift.
- **렌더 계약**: `getPageLayerTree`(PageLayerTree schemaVersion 1) — SVG 문자열 ❌. schemaVersion 1 assert(additive-only라 안전).
- **저장 경로 비활성화**: rhwp HWPX/HWP save 사용 금지(issue #196). parse+layout+render만.
- **op-bus는 hwpctl 모델 차용**: ~30 Actions + ParameterSet/ParameterArray + Field API(GetFieldList/PutFieldText/GetFieldText) 형태를 우리 버전드 op로, 경계 안에서 op → rhwp document_core command 번역.
- **빌드 위생**: wasm는 순수 Rust 의존만(wasm-bindgen/web-sys/js-sys/quick-xml/cfb/flate2), native-skia(C 의존)·librsvg·poppler는 wasm feature에서 제외. WASM init 전 `globalThis.measureTextWidth` 주입(Tauri webview/node가 제공).
- **업스트림 churn 대비**: 커밋 pin, 매 bump마다 한컴 수용 게이트 실행, 포크에 로컬 패치 carry 예산.

---

## 6. 정합성 오라클 & 골든 테스트

- **오라클**: `soffice --headless --convert-to pdf/png --infilter=Hwp2002_File`(+H2Orestart .oxt), 프로세스 격리.
- **스코어러**: 페이지별 SSIM/perceptual + structural diff. **green(인라인 편집) / yellow(근사 배너) / red(읽기전용 PDF)** UX 게이트 + 문서화된 H2O 버그 known-divergence allowlist.
- **골든**: 47-샘플 hwpxlib 코퍼스 + rhwp CLI `ir-diff`/`dump-pages`/native-skia PNG. 미편집 콘텐츠는 replay LineSeg 대비, 편집은 행동 비교(허용오차).
- **정책**: "no-regression vs 우리 골든"으로 게이트(절대 한컴 동일성 ❌ — 한컴 PDF조차 환경의존).

---

## 7. 주요 리스크 & 완화

| 리스크 | 완화 |
|---|---|
| rhwp 버스팩터-1·pre-parity·HWPX 직렬화기 한컴 비호환 | 우리 provenance/passthrough 레이어가 위에서 round-trip 보장(rhwp 손실 마스킹); 자체 직렬화기; 포크 pin; 코어를 rhwp 비의존으로 유지(교체 가능) |
| 한컴 줄바꿈/정렬 알고리즘 비공개 (픽셀 동일 round-trip 불가) | 허용오차 행동 게이트 + 오라클 reverse-engineering 골든 테스트 |
| 폰트 메트릭 발산(웹뷰 vs 골든 vs native) | 셰이핑/레이아웃을 공유 Rust로, `FontMetricsProvider` 주입+pin, HWPX BinData 임베드 폰트 추출, 결정적 fallback 정책 |
| 옛한글 Hanyang PUA 글리프 폰트-특정·재배포 불확실 | 첫가끝 변환 테이블 보유 + Source Han Old Hangul 등 fallback; 원본 바이트 provenance 보존 |
| harfrust wasm32 미문서화 | 벤더 시점에 `wasm32-unknown-unknown` 실제 빌드 검증; 안 되면 rustybuzz(`wasm-shaper`) |
| 차트/도형/수식 authoring·전체 pic 그래프 한컴 거부 위험 | passthrough 우선, 오라클 통과 전 비활성, 오라클 주도 반복 |
| 2024 OWPML ns 실문서 코퍼스 부재 | 합성 fixture + 한컴 조기 검증 |

---

## 8. 단계별 로드맵

> 각 Phase는 독립 가치 산출. round-trip 안전·정합성 게이트는 *나중*이 아니라 처음부터.

- **Phase 0 — 기반 + 진실 게이트**: Rust 워크스페이스, `model/` SemanticDoc(provenance/passthrough/dirty), rhwp 벤더 포크(native+wasm 빌드 확인, `measureTextWidth` 주입), 오라클 CLI + 페이지 diff 스코어러. 산출: *아무 .hwp/.hwpx 열어 페이지별 정합성 점수 표시*.
- **Phase 1 — 충실 뷰 (MVP read)**: ingest 어댑터(HWP5/HWPX/HWP3 → SemanticDoc), rhwp typeset → `getPageLayerTree` → Canvas/WebGL 렌더(표/이미지/차트/수식/도형 포함), 미편집 LineSeg replay. Tauri 데스크톱 + wasm 웹 프리뷰. 산출: *원본 그대로 뷰*.
- **Phase 2 — 타이포그래피 분리 + 보강**: `typeset/` 경계 함수화, rhwp 메트릭 한계(widow/orphan, keep flags, useKerning) 매핑·보강, 자간/장평/3정렬/금칙/줄간격 4모드 골든 게이트. (선택) harfrust 셰이퍼 PoC. 산출: *Korean 타이포 정합성 측정·개선 루프*.
- **Phase 3 — 편집 + HWPX export (MVP edit)**: `ops/` typed op-bus(Wave 1) + undo/redo, `hwpx-export/` 자체 직렬화기(PR#40 3종 + dirty-only + ID 정합성 + 이미지/표 규칙), round-trip 안전 커널 + 한컴 수용 게이트(CI). 산출: *편집 → .hwpx 저장(손상 편집은 비활성, 무손실)* — **목표(.hwp/.hwpx 입력→뷰→수정→.hwpx export) 달성**.
- **Phase 4 — AI 컨텐츠 작성**: `ai/` AST↔Markdown/JSON projection, op 제안→검증→diff 미리보기→승인 루프, MCP 서버(단일 op 스키마), 템플릿/표 채우기. 산출: *AI가 문서에 컨텐츠 작성(리뷰 가능)*.
- **Phase 5+ — 고급/확장**: Wave 2 op(차트/수식/도형 authoring, 누름틀, 메모, 변경추적), 배포용/비밀번호 `crypto/`(golden-vector), PDF/DOCX export, (장기) 자체 셰이퍼 완성·세로쓰기 authoring·협업(CRDT).

---

## 부록 A — 검증 메모 (초기 조사 대비 정정)
- **rhwp는 자간/장평/금칙/옛한글을 이미 구현**(소스 검증). "미구현"은 오류. 진짜 갭은 widow/orphan·kerning·ligature·hanging punctuation, 그리고 한컴 전용 폰트 미번들.
- **현대 Rust 셰이퍼 = harfrust**(swash는 rasterizer로). swash는 Linebender가 유지(단일 메인테이너 아님). swash 최신 0.2.9(2026-06-12).
- **rhwp는 crates.io에 없음** → 벤더 포크 필수. npm `@rhwp/core`/`@rhwp/editor` v0.7.15만 공개.
- **rhwp HWPX 저장은 한컴 비호환**(issue #196) → 자체 직렬화기 필수.

## 부록 B — 핵심 포맷 상수
- HWP5: OLE/CFB, 레코드 헤더 Tag(10b)+Level(10b)+Size(12b), `0xFFF`→DWORD, zlib raw-deflate `wbits=-15`.
- HWPX: ZIP+OWPML, KS X 6101(2011-12-30 채택, 2024-10-30 개정). mimetype `application/hwp+zip`.
- 배포용 crypto(Phase5+): `HWPTAG_DISTRIBUTE_DOC_DATA` 256B → MSVC srand/rand LCG(첫4B 시드) → UTF-16LE SHA-1 → AES-128-ECB(ViewText). openhwp의 XOR 스텁 ❌, volexity/hwp-extract(BSD-3) 교차검증.
