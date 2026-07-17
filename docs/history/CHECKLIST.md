# tf-hwp — 구현 체크리스트

> [PLAN.md](./PLAN.md)에서 파생된 실행 체크리스트. 목표: **.hwp/.hwpx 입력 → 원본 뷰 → 수정 → .hwpx export**.
> 표기: `[ ]` 미착수 · `[~]` 진행중 · `[x]` 완료 · 🔴=하드 게이트(통과 못 하면 다음 단계 금지) · ⭐=고려사항(1 렌더/타이포, 2 AI, 3 리본) 직접 관련.

---

## Phase 0 — 기반 + 진실 게이트  ✅ 스캐폴드 완료 (`cargo build`/`test`/`clippy -D warnings`/wasm32 green)

### 0.1 프로젝트 셋업
- [x] `git init` + Rust 워크스페이스(`crates/*`, 12 crates) 스캐폴딩 — 빌드 green
- [x] 라이선스 정책 문서화 (docs/LICENSE-POLICY.md + deny.toml: MIT/Apache/BSD only, GPL out-of-process, AGPL 금지)
- [x] CI 파이프라인 골격 (.github/workflows/ci.yml: fmt/clippy/test + wasm32 hygiene + cargo-deny)
- [x] Build-vs-Own 의존성 전략 문서화 (docs/DEPENDENCY-STRATEGY.md: capability trait 경계 + 교체 사다리)

### 0.2 SemanticDoc 모델 (`hwp-model`)
- [x] 노드 트리 정의: SemanticDoc/Section/Block/Paragraph/Run/Inline/Table/Cell/BinData/PageSetup
- [x] ⭐1 모든 편집 노드에 **provenance(원본 바이트/XML)** 필드
- [x] ⭐1 노드별 **verbatim passthrough bag** + `Inline::Raw` (수식/도형/차트 보존)
- [x] 노드별 **dirty flag** + 안정 NodeId + `any_dirty()` 전파
- [x] CharShape(per-script 7배열 PerScript<T>: faceID/ratio(장평)/spacing(자간)/relSz/offset + 속성)
- [x] ParaShape(HorizontalAlign 6값/LineSpacingType 4모드/들여쓰기/여백/탭/줄나눔 Latin·NonLatin/widow-orphan/keep flags)
- [x] capability traits 정의(DocumentParser/LayoutEngine/Renderer/HwpxSerializer/FontMetricsProvider) + SafetyReport
- [x] `hwp-model` 의존 최소화(thiserror만) + 🔴 **wasm32 컴파일 검증** (hwp-model/hwp-ops/hwp-ingest)

### 0.3 rhwp 벤더 부트스트랩 (어댑터 경계 우선, 실제 벤더링은 다음 단계)
- [x] `hwp-rhwp` 어댑터 크레이트 + capability trait 구현 골격 (feature `rhwp`; 없으면 inert, 워크스페이스 green)
- [x] `scripts/vendor-rhwp.sh` (fork→submodule v0.7.15, native+wasm 빌드, save 비활성화 안내)
- [x] rhwp HWPX/HWP **save 경로 비사용 정책** 명문화 (HwpxSerializer는 우리 것 — issue #196)
- [x] PageLayerTree `PAINT_SCHEMA_VERSION=1` pin + Renderer가 emit 시 보장
- [x] fork `kwakseongjae/rhwp` 생성 → `external/rhwp` submodule(v0.7.15), 워크스페이스 `exclude`
- [x] 🔴 rhwp native 빌드 성공 + **`benchmark.hwp` 8페이지 SVG 렌더 검증**(표·병합셀·음영·한국어 타이포 원본 그대로)
- [x] `hwp-rhwp` in-process 어댑터(path-dep, feature `rhwp`): `page_count`/`render_page_svg`(rhwp `DocumentCore`) + CLI `render --features rhwp`
- [~] 🔴 wasm32 빌드 검증(Docker wasm-pack) + `measureTextWidth` 배선(웹 경로) — 대기
- [~] 실제 parse → SemanticDoc lift + `build_page_layer_tree` → 우리 PageLayerTree 매핑 — 진행중(현재는 SVG 직접 경로)

### 0.4 정합성 오라클 + 스코어러 (`hwp-oracle`)
- [x] `soffice --headless --convert-to pdf` 호출 래퍼 + `soffice_available()` (프로세스 격리, native) — soffice 설치 확인됨
- [~] 페이지별 SSIM/perceptual + structural diff 스코어러 (FidelityBand enum 정의, 스코어러 구현 대기)
- [ ] H2Orestart .oxt 설치(현대 HWP 변환 필수) + 47-샘플 hwpxlib 코퍼스 벤더링
- [~] **산출물**: `tf-hwp detect/info/extract-text` 동작(✅ HWPX 텍스트 추출 확인), `oracle` PDF 변환 동작; 페이지별 점수 게이트는 대기

---

## Phase 1 — 충실 뷰 (MVP read) ⭐1

### 1.1 Ingest (`ingest/`)
- [x] 포맷 탐지: CFB(d0cf11e0)=HWP5 / ZIP+OWPML=HWPX / HWP3 legacy
- [x] rhwp 파서 호출 → Document IR (`rhwp::parse_document`, in-process)
- [x] 어댑터: rhwp Document → SemanticDoc (`hwp-rhwp/src/lift.rs`; provenance.source=Hwp5, dirty=false) — **subset(문단 텍스트+표 셀/행열/span)**; 깊은 fidelity(charPr/paraPr 풀·이미지·수식·passthrough)는 진행중
- [x] UI/AI가 rhwp 타입 직접 접근 못 하도록 경계 강제 (lift가 격리; `Engine::open` → SemanticDoc)
- [x] ✅ HWP5 텍스트 추출 동작: `tf-hwp extract-text benchmark.hwp` → 262줄(표 셀 포함, 읽기순) · `SemanticDoc::plain_text()`

### 1.2 렌더 (`render/`)
- [x] ⭐1 표·이미지·**차트/도표**·머리/꼬리말·다단 뷰 확인 — **`benchmark.hwp` 8페이지 충실 렌더 검증**(rhwp)
- [~] 렌더 계약: 현재 `render_page_svg_native`(SVG) 사용 → `getPageLayerTree`(paint IR schemaVersion 1) 매핑으로 전환 예정
- [~] Canvas/WebGL 페인트 · native skia(골든) — SVG 경로 우선, 전환 대기
- [~] ⭐1 미편집 문단 LineSeg **replay** — 대기
- [x] CanvasKit 제외(wasm32 미지원) 명시

### 1.3 셸
- [x] **산출물(interim): 원본 그대로 뷰** — `tf-hwp view benchmark.hwp` → 단일 self-contained HTML 뷰어(8p)
- [ ] Tauri 2 데스크톱(코어 in-process) + TS/React 크롬 — *결정 필요: HTML 뷰어 유지 vs Tauri 앱*
- [ ] wasm 웹 프리뷰 (Docker wasm-pack)

### 1.4 ✅ benchmark fidelity 게이트 ON ⭐1 (→ docs/FIDELITY.md)
- [x] `hwp-fidelity` 하베스 + `benchmark.hwp` 배선 + `tf-hwp fidelity`
- [x] ✅ **오라클 병목 해결**: openjdk 26 설치 + H2Orestart(GUI) → `benchmark.hwp` → PDF 변환 동작. `Prerequisites::detect()`가 soffice/H2Orestart/engine 보고.
- [x] 페이지별 스코어러 구현(grayscale MAE 교차렌더 일치도, green≥0.90/yellow≥0.78/red) — `hwp-oracle::{pdf_to_pngs,svg_to_png}` + `image` crate. `benchmark_oracle_and_fidelity` 테스트 통과(merged, 직렬).
- [x] ✅ **절대 fidelity 정답지(`benchmark.pdf`, 8쪽) 확보 + 연결**: `reference_pdf_for`(=`<stem>.pdf`)를 오라클보다 우선 사용. `tf-hwp fidelity` → **page 1–8 전부 GREEN (94.9–99.2% 일치), overall GREEN (ABSOLUTE)**.
- [x] ✅ **검증된 사실**: benchmark.pdf=8쪽 = **우리 rhwp와 일치**, LibreOffice(10쪽)가 틀림 → rhwp 페이지네이션이 정답.
- [ ] (선택) known-divergence allowlist · 다른 코퍼스 정답지 확장
- [ ] 🔴 benchmark **모든 페이지 Red 0** (합의 tolerance); `cargo test -p hwp-fidelity -- --ignored` 통과
- [ ] known-divergence allowlist(문서화된 오라클/rhwp 버그)

---

## Phase 2 — 타이포그래피 분리 + 보강 ⭐1

### 2.1 경계 분리 (`typeset/`)
- [ ] 순수 함수 경계: `layout(runs+charshape, parashape, column_geometry, FontMetricsProvider, writing_mode) -> Vec<LineSeg> + PageLayout`
- [ ] `FontMetricsProvider` 명시적 주입 의존성 + 골든 테스트 폰트 pin
- [ ] HWPUNIT(1in=7200) ↔ font units ↔ px@dpi 단위 레이어 일원화
- [ ] LineSeg는 진실의 원천 ❌ — provenance로만, dirty 문단은 재레이아웃/strip

### 2.2 rhwp 한계 보강
- [ ] ParaShape widowOrphan/keepWithNext/keepLines/pageBreakBefore 매핑
- [ ] CharShape useKerning/useFontSpace 매핑
- [ ] (조사) kerning/glyph shaping·ligature·hanging punctuation 갭 평가
- [ ] HWPX BinData 임베드 폰트 추출 + 결정적 fallback 정책

### 2.3 🔴 정합성 acceptance 게이트 4종 (가시 reflow 차이 대부분)
- [ ] 자간(per-script advance delta) / 장평(advance+outline 비등방 수평 스케일) 골든
- [ ] 3정렬: JUSTIFY / DISTRIBUTE(배분) / DISTRIBUTE_SPACE(나눔) 골든
- [ ] 금칙처리(줄머리/줄꼬리 금지 문자클래스) 골든
- [ ] 줄간격 4모드(PERCENT/FIXED/BETWEEN_LINES/AT_LEAST) 골든

### 2.4 옛한글 / 세로쓰기
- [ ] Hanyang PUA(E000–F8FF) → Unicode 첫가끝 변환 테이블(데이터) + import 정규화 패스(원본 바이트 provenance 보존)
- [ ] 현대 한글 `unicode-normalization` NFC
- [ ] 세로쓰기 writing_mode 파라미터 + 글자 orientation 규칙

### 2.5 (선택) 자체 셰이퍼 PoC
- [ ] harfrust 셰이퍼 PoC(Hangul ljmo/vjmo/tjmo) + 🔴 wasm32 빌드 검증
- [ ] 안 되면 rustybuzz(`wasm-shaper`) fallback
- [ ] icu_segmenter(UAX#14) + 한컴 금칙 post-filter
- [ ] 셰이핑/레이아웃 공유 Rust → native·wasm 동일 줄바꿈 검증
- [ ] **산출물**: Korean 타이포 정합성 측정·개선 루프

---

## Phase 3 — 편집 + HWPX export (MVP edit) — ✅ M4 핵심 목표 달성 ⭐3
> ✅ **M4 달성(2026-06-16)**: 실제 HWPX `편집(문단 추가) → export → 오라클(LibreOffice+H2Orestart)이 정상 오픈` + 우리 파서 재오픈(원본 보존). `tf-hwp edit --verify`로 한컴 수용 검증. acceptance 게이트가 실제 버그(누락 id/dangling ref)를 잡아내 수정함.

### 3.1 op-bus (`ops/`) — Wave 1
- [x] ⭐3 단일 typed op-bus(`hwp-ops`), raw XML 경로 0; `Op` 열거 + `apply()` (MVP: `AppendParagraph`) + undo/redo journal
- [~] (확장) `set_char_pr`/`set_para_pr`/`apply_style`(property-set, header 풀 intern), `insert_text`/`delete_range`, 표/이미지 op — 골격만, 점진 구현
- [ ] **section/구역 op**: `insert_section_break` + section-addressed
- [ ] 텍스트: `insert_text`/`delete_range` (NodeId 기반)
- [ ] 표: insert + insertRow/Col, deleteRow/Col, mergeCells(비활성화 관례), splitCell, setCellBorderFill/Margin
- [ ] 이미지: `insert_image`(BinData 관리) + 배치 모드
- [ ] 번호/글머리표/개요, applyStyle/defineStyle
- [ ] 클립보드: cut/copy/paste **HWPX-fragment**, 모양복사=set_char_pr+set_para_pr 합성
- [ ] 찾기/바꾸기, 책갈피, 하이퍼링크
- [ ] 페이지 설정(용지/여백/방향) + 머리/꼬리말 + 각주/미주 + 쪽번호

### 3.2 HWPX 직렬화기 (`hwp-hwpx/serialize.rs`) — 자체 구현 ✅
- [x] 🔴 **PR#40 #1·#2·#3 자동 충족**: 미변경 part를 `zip raw_copy_file`로 **byte-verbatim 복사** → standalone·15 네임스페이스·mimetype-first/STORED·ZIP 순서·per-entry 메타 전부 보존
- [x] ⭐1 **dirty-only 재직렬화**: 미변경 part 원본 바이트 그대로, **dirty 섹션만** 패치
- [x] dirty 섹션 = 원본 XML에 **새 문단만 surgical 삽입**(기존 서식 무손실), 유효 `id`/`paraPrIDRef`/`charPrIDRef`(기존 ref 재사용) + stale linesegarray 미생성(한컴 재계산)
- [ ] (확장) NodeId 기반 in-place 텍스트 patch, ID 정합성 풀 검증, 이미지 `<hp:pic>` 3-step, 표 편집, macOS hint

### 3.3 🔴 round-trip 안전 커널 + acceptance 게이트 ✅(MVP)
- [x] `validate_open_safety`(cheap 게이트): OPC 유효·mimetype 첫엔트리·섹션 standalone+root. **단 cheap 게이트는 false-OK 가능**(broken edit을 OK로 통과시킨 사례 확인) → **오라클 재오픈이 진짜 게이트**.
- [x] **오라클 한컴 수용 게이트**: `tf-hwp edit --verify` = 출력 HWPX를 soffice+H2Orestart로 오픈 → 진짜 수용 판정. **실제 버그(누락 id) 검출·수정 완료**.
- [x] 자체 round-trip 테스트(`hwp-hwpx`): no-edit 재오픈 동일 텍스트 + append 후 원본 보존·추가 생존
- [ ] (확장) 기능별 골든(캡션/표 pageBreak/여백…), CI 오라클 게이트, round-trip 실패 op 비활성화, 하드 게이트 객체 passthrough 우선
- [x] **🎯 산출물 달성: 편집 → .hwpx 저장(원본 무손실, 한컴/오라클이 여는)** — *업로드·뷰·편집·.hwpx 다운로드 = 프로덕션 코어 완성*
- [ ] **산출물**: 편집 → .hwpx 저장(무손실, 한컴이 여는) — **🎯 목표 달성: 업로드·뷰·편집·.hwpx 다운로드** ✅
> export = HWPX only (확정). 바이너리 .hwp 쓰기는 스코프 밖.

---

## Phase 4 / A0 — AI 컨텐츠 작성 ⭐2 (헤드리스 코어 ✅ · 키없는 템플릿 루프 ✅) → docs/AI-LOCAL-CONTROL-PLAN.md
> ✅ **A0 헤드리스 AI 코어 동작**: `LlmProvider` trait(`hwp-ai`) + `MockProvider`(키 없이) + `AnthropicProvider`(BYOK) + `ai_fill`(op-bus 경유). CLI `tf-hwp ai-fill <in.hwpx> --instruction "…" [--provider auto|mock|anthropic] [--verify]`. **검증: mock로 AI→op→.hwpx→오라클 정상 오픈** (실 HWPX). default·feature `ai` 빌드 green, clippy clean.
> ✅ **A0.5 키 없는 "Claude Code = LLM" 템플릿 루프**(§7): `hwp-ai::content`(AiContent 스키마 + `template_brief`/`parse_content`/`compile_to_ops` 전처리기) + CLI `ai-context`(read 툴)·`ai-apply --content c.json --verify`(write 툴). **검증: Claude Code가 템플릿 준수 JSON 작성 → 헤딩·부분볼드·불릿·구분선·표 11블록→15op→FormattingShowcase.hwpx에 append→오라클 정상 렌더(원본 보존, 네이티브 볼드 charPr 재사용 확인)**.

- [~] ⭐2 SemanticDoc → 구조보존 Markdown projection — `to_markdown`(현재 plain_text), 표=그리드/수식=문법은 다음
- [x] ⭐2 op 스키마=도구(MVP): LLM이 문단 제안 → **op-bus `apply`** 적용 → `validate_open_safety` + (선택)오라클 검증
- [x] ⭐2 **템플릿 → 생성 → 전처리 → 이식가능 OWPML 파이프라인**: `AiContent`(Heading/Paragraph(bold runs)/Bullet/Divider/Table) → `compile_to_ops` → `AppendRichParagraph`(네이티브 부분 볼드, `find_bold_charpr`로 실제 charPr 재사용)
- [x] **Anthropic 인터페이스 뒤 교체 가능**(BYOK): Messages API 직접 HTTP, default 모델 `claude-opus-4-8`(TF_HWP_MODEL 오버라이드), `ANTHROPIC_API_KEY` env, native-only feature
- [ ] ⭐2 diff 미리보기(변경추적) → 사람 승인 → commit (현재 CLI는 즉시 적용 — GUI 단계에서 diff 게이트)
- [x] 템플릿 심화 — **네이티브 `<hp:tbl>` 방출** ✅: `Op::AppendTable`→AST `Block::Table`→serializer `emit_table`(행/열·헤더 볼드·실제 테두리, `find_table_borderfill`로 valid `borderFillIDRef` 재사용). **검증: 3×5 표가 오라클에서 테두리 표로 렌더, 라운드트립으로 native Table 블록 복원**
- [x] **헤더 합성 레이어(완성형 P2/P3/P4)** ✅ — `hwp-hwpx/synth.rs`. header.xml을 "verbatim copy"에서 "clone-and-patch + 새 풀 엔트리 합성"으로. 2-pass serialize: dirty 콘텐츠의 interned Char/ParaShape → 기본 charPr/paraPr를 복제·패치하여 새 id로 추가(itemCnt bump, container-vs-element 회피). **글자모양**: bold(순수, 파랑 아님)·italic·underline·strike·글자색·형광(shade)·크기 — charPr child order `…offset,[italic],[bold],underline…`(로드맵 확인). **글꼴**: `intern_font`로 7개 fontface 풀에 reuse-or-clone, per-script fontRef. **문단모양**: align(L/C/R/justify/distribute)·줄간격%·들여쓰기·여백·문단간격 — `hp:switch` case=V/default=2V doubling(코퍼스 확인). 디자인 워크플로(17 agents) 로드맵 → `docs/COMPLETION-ROADMAP.md`. **검증: 4종 content.json이 오라클에서 정상 렌더(글자/문단/글꼴/마스터 showcase), 16+ 단위테스트, clippy clean**
- [x] **완성형 표 심화** ✅ — `Op::AppendRichTable` + `CellSpec`(col_span/row_span/bold/shade). 셀 병합(HTML 커버리지 배치, 커버된 셀 omit, 빈 `<hp:tr>` suppress), 셀 배경음영(`synth::synthesize_border_fill`로 테두리 fill 복제+fillBrush 추가→borderFills 풀 합성). **검증: 가로3열·세로2행 병합 + 파랑/노랑/초록 음영 표가 오라클 렌더, colSpan 라운드트립**
- [x] **완성형 목록** ✅ — `bullet_list`/`ordered_list` 블록 → 행잉 인덴트(margin_left 18pt + indent -18pt) 문단으로 렌더(번호/글머리표 마커 + 둘째 줄 정렬). 네이티브 numbering/bullet 풀은 로드맵 고위험(코퍼스 근거 0)으로 보류
- [x] **완성형 종합 시연** ✅ — `out/final.json`: 제목·혼합서식·번호목록·글머리목록·병합/음영표·구분선 전부 한 문서에서 오라클 렌더(14 op). 워크스페이스 22 테스트 green, clippy clean
- [x] **완성형 스타일·개요 수준(P5)** ✅ — `ParaSpec.style`/`Paragraph.style_name` + `synth::parse_styles`(이름·engName→styleIDRef/paraPr/charPr). 문단에 named-style 적용(바탕글/본문/개요 1~7); **개요 N 스타일은 자동 번호까지 생성**(스타일이 번호와 연동). 직접 서식 override가 스타일보다 우선(styleIDRef 유지 + 합성 paraPr). **검증: 개요 1/2/3·본문·바탕글+가운데 오라클 렌더(개요 자동번호 1./나./1.)**
- [x] **#005 쪽 레이아웃(방향+여백)** ✅ — `Op::SetPageLayout`(orientation/margins_mm) → `synth::patch_page`가 기존 secPr의 pagePr width/height + page margin을 **in-place 패치**(엔진 최초의 기존요소 편집, append 아님). **검증: landscape+30mm → pagePr 84188×59528, 오라클 통과, rhwp 가로 렌더(1122×793)**. AiContent `page:{orientation,margin_mm}`.
- [x] **원본 그대로 렌더 검증(벤치마크)** ✅ — `benchmark.hwp` 엔진 렌더가 `benchmark.pdf` 대비 8페이지 전부 GREEN(94.9~99.2%, 시각 확인). 갭은 엔진이 아니라 **뷰어가 .hwp를 못 열던 것** → `hwp_mcp::open_document`가 HW5 뷰 허용 + 다이얼로그 `["hwp","hwpx"]` + render는 serialize-live-HWPX-else-원본바이트. 테스트 `opens_and_renders_hwp5_benchmark`.
- [x] **자체 검증 루프 상시화** ✅ — `scripts/bench-compare.py`(우리 렌더 ‖ 정답 PDF 나란히 → `out/bench-compare.html`) + `tf-hwp fidelity <file>`(MAE 밴드). 엔진 변경 후 시각 교차검증.
- [x] **#004 structure-preserving projection** ✅ — `to_markdown`가 블록 `[s/b]` 앵커 + 표=그리드. (prompt caching은 BYOK 필요로 보류)
- [x] **복잡 시나리오 데모** ✅ — `out/complex.json`(11블록→16op): 제목·개요스타일·리치런·목록·병합/음영표·페이지레이아웃·구분선 → 오라클 오픈 + rhwp 충실 렌더.
- [ ] **long-term(이슈화, 코퍼스 근거/인프라 부재로 보류)**: 네이티브 자동번호(#001), 헤더 full parse-in(#003), 쪽 다단/머리말/쪽번호(#005), 이미지 임베드(#006). 외부 실-한컴 샘플 또는 in-place 편집 인프라 확보 후. (#002 탭=저가치 폴리시)
- [x] ⭐2 **MCP 서버 A1** ✅ — `crates/hwp-mcp` self-contained MCP stdio 서버(JSON-RPC 2.0, rmcp 미사용). 툴: open_document·get_context·apply_content·export_hwpx·extract_text. `handle()` 순수함수 단위테스트 + 실 stdio E2E + **에이전트 산출물 오라클 통과**. 등록: `claude mcp add --transport stdio tf-hwp -- hwp-mcp`.
- [x] ⭐1 **Tauri 뷰어 셸 A2** ✅ — `crates/hwp-viewer`(Tauri 2.11.2, 무-npm 프론트엔드, rhwp SVG 렌더 + AI 패널). 커맨드는 `hwp_mcp::handle` 재사용. 헤드리스: 컴파일(default+rhwp)+clippy+2 단위테스트. 윈도우는 사용자 실행(`cargo run -p hwp-viewer --features rhwp`).
- [x] ⭐3 **라이브 제어 서버 A3** ✅ — `hwp_mcp::server`(자체 std::net 루프백 HTTP, rmcp/axum 미사용) + `hwp-viewer::server::spawn`(managed Session + emit). 보안 fail-closed(루프백·Host·Origin·Bearer ct_eq). **헤드리스 curl 검증: 401/403/405 거부 + open→apply→export + 오라클 통과 + 127.0.0.1-only + cred 0600**. `claude mcp add --transport http`.
- [x] **#003 헤더 풀 dedup(부분)** ✅ — `synth::existing_equivalent_id`로 합성 charPr/paraPr가 기존 풀 엔트리와 (id 제외) 동일하면 재사용(풀 비대 방지). **검증: bold+#1F4E79 요청이 기존 charPr id=7 재사용, max_pool_id 불변**. 전체 parse-in(기존 본문 서식을 AST로 → in-place 편집)은 verbatim-passthrough 아키텍처상 in-place 편집 op + 비-verbatim 재방출이 생긴 뒤로 이슈 #003에 잔여.
- [ ] BYOK 키를 keyring으로(Tauri 단계); ⚠️ **실 Anthropic 호출 테스트엔 ANTHROPIC_API_KEY 필요**
- [ ] **산출물**: AI가 문서에 컨텐츠 작성(리뷰 가능) — 헤드리스 ✅, GUI diff 게이트는 다음

---

## Phase 5+ — 고급/확장

- [ ] ⭐3 Wave 2 op: 차트/수식/도형 **authoring**, 누름틀/필드, 메모, 변경내용추적, 다단 미세조정
- [ ] 배포용/비밀번호 `crypto/`: MSVC srand/rand LCG → SHA-1 → AES-128-ECB, golden-vector, fail-closed (openhwp XOR 스텁 ❌, volexity 교차검증)
- [ ] PDF/DOCX export
- [ ] ⭐3 Wave 3(Optional): 글맵시, 옛한글/세로쓰기 authoring, 개체 그룹
- [ ] (장기) 자체 셰이퍼 완성, 협업(CRDT op-log)

---

## 횡단 게이트 (매 Phase 적용)
- [ ] 🔴 매 rhwp bump 시 한컴 수용 게이트 통과
- [ ] 셰이핑/레이아웃 native==wasm 줄바꿈 동일성
- [ ] 라이선스 위생(링크 코드 MIT/Apache/BSD, GPL out-of-process)
- [ ] 정합성 점수 회귀 없음(vs 우리 골든, 한컴 동일성 아님)

---

## 한글 리본 → op 커버리지 매핑 (Wave별, op-bus 체크리스트 겸용)

### Wave 1 (MVP)
| 리본 그룹 | 컨트롤 | op |
|---|---|---|
| 편집 | 실행취소/재실행 | `undo`/`redo` (엔진, 비직렬화) |
| 편집 | 잘라/복사/붙이기, 골라붙이기 | `cut_range`/`copy_range`/`paste_fragment(HWPX)`/`paste_special` |
| 편집 | 모양 복사 | `copy_format`+`apply_format` (=set_char_pr+set_para_pr) |
| 편집 | 찾기/찾아바꾸기 | `find_text`/`replace_range`/`replace_all` |
| 입력 | 표 | `insert_table` + 행/열/병합/분할/셀테두리·여백 |
| 입력 | 그림 | `insert_image`(BinData) + 크기/배치 |
| 입력 | 각주/미주 | `insert_footnote`/`insert_endnote` |
| 입력 | 하이퍼링크/책갈피 | `insert_hyperlink`/`insert_bookmark` |
| 입력 | 머리말/꼬리말/쪽번호/문자표 | `set_header`/`set_footer`/`set_page_numbering`/`insert_special_char` |
| 서식 | 글자모양 | `set_char_pr`(fontRef 7슬롯, sz, 색, bold/italic/underline/strike/outline/shadow/sub-sup, 자간, 장평, offset) |
| 서식 | 문단모양 | `set_para_pr`(정렬 6값, 줄간격 4모드, 들여/내어쓰기, 여백, 탭, 테두리, 줄나눔) |
| 서식 | 스타일/번호 | `apply_style`/`define_style`/`apply_numbering`/`apply_bullet` |
| 쪽 | 용지/여백/구역/단/테두리/쪽번호/바탕쪽 | `set_page_setup`/`insert_section_break`/`set_columns`/`set_page_border_fill`/`set_master_page` (모두 section-scoped) |

### Wave 2 (Later)
| 입력 | 차트/수식/도형 authoring | `set_chart_data`/`insert_equation` 편집/`insert_shape` (MVP=뷰+passthrough) |
| 입력 | 누름틀/필드 | `insert_press_field`/`set_field_value` |
| 검토 | 메모 | `insert_memo`/`edit_memo`/`delete_memo` |
| 검토 | 변경내용추적 | `enable_track_changes`/`accept_change`/`reject_change` |

### Wave 3 (Optional)
| 입력 | 글맵시/개체그룹 | `insert_word_art`/`group_objects` |
| 서식 | 옛한글/세로쓰기 authoring | typeset 서브시스템 경유 |
| 검토/도구 | 맞춤법/사전/번역/문서비교 | op-bus 밖(툴 사이드) |
