# tf-hwp 피벗 설계 (PIVOT DESIGN)

> 상태: 확정 설계 (buildable). 작성 기준일 2026-06-20. 코드 그라운드 트루스로 검증 완료(아래 §11 부록 참조).

---

## 1. 한 줄 방향 + 핵심 결정 요약

**한 줄:** hwp/hwpx를 읽어 **편집 가능한 JSX(내용)+CSS(디자인) 프로젝트**로 투영(project)하고, **브라우저가 아닌 자체 Rust 엔진**이 레이아웃·페인트·캐럿·내보내기(HTML/PDF)를 담당하며, GUI·헤드리스가 **하나의 Rust 코어**를 공유한다.

**확정 결정 (D1–D4, 변경 불가):**

| 코드 | 내용 |
|---|---|
| **D1 EXPORT** | HTML + PDF (web output). 바이너리 HWPX **출력은 폐기**. INPUT은 hwp + hwpx 유지. doc(.docx)는 stretch. |
| **D2 RENDER** | **자체 엔진, 브라우저 레이아웃 미사용**. webview는 React 앱 셸을 호스팅하되 *문서는 canvas/SVG에 우리 엔진이 페인트*. |
| **D3 SHELL** | React (현 SolidJS+Tauri 셸을 React로 이관). |
| **D4 FIDELITY** | 두 모드 — `layout-preserve`(원본 레이아웃 보존 뷰) + `semantic-reflow`(편집/내보내기용 깨끗한 web-native 구조). |

**신규 요구 (사용자 6점):**
1. 엔진이 hwp/hwpx를 편집 가능한 요소로 변환, React를 **라이브러리로** 써서 요소 관리.
2. 요소를 CSS+JSX로 분리해 **프로젝트(파일 폴더)** 로 관리(.jsx + .css).
3. JSX = HEADLESS(구조/내용), CSS = DESIGN.
4. AI 편집 라우팅: "내용 수정"→JSX만, "글꼴 크기 변경"→CSS만, "표 추가"→JSX+CSS(이미 있는 CSS 규칙은 중복 생성 금지).
5. HTML/PDF 내보내기.
6. (stretch) doc/.docx 일부 + PDF.
- **헤드리스 필수:** 파싱→모델→렌더/내보내기 전 파이프라인이 데스크톱 앱 없이 동작.

### 1.1 설계가 비판(adversarial critique)을 받아들여 *수정한* 5가지 (정직성 우선)

이 문서는 후보 설계 5개의 **상호 모순**을 발견하고 다음과 같이 해소했다. 이 다섯 결정이 본 문서를 "후보 묶음"이 아닌 "확정 설계"로 만든다.

1. **정전(正典, canonical)은 `SemanticDoc`다. JSX/CSS는 그 위의 *투영(projection)* 이다.** ("JSX/CSS가 정전 IR" 안은 기각.) — 근거: §3.0, §8.
2. **`98.9%`는 *줄 개수* 충실도다(글자 x 아님).** layout-preserve와 정확한 캐럿은 **존재하지 않는 shaper(rustybuzz)에 걸린 베팅**임을 명시. layout-preserve v1은 **rhwp SVG를 그대로 쓴다.** — 근거: §4.3, §10.
3. **`hwp-render`는 "확장할 stub"이 아니라 *미작성 서브시스템*이다.** 모델의 `PaintOp`(색/폰트/TextRun 없음)는 caret이 읽는 rhwp `PaintOp::TextRun`과 **다른 타입**이므로 "additive, schema v1 유지"는 거짓 — `PaintOp` enum 재설계 + schema bump가 새 작업이다. — 근거: §4.2.
4. **custom react-reconciler는 v1(그리고 아마 영구히) 채택 안 함.** Rust-owns-tree 아키텍처와 정면 충돌하는 의례(ceremony). React = chrome + Inspector(op 디스패치). — 근거: §2.3.
5. **CSS dedup은 *정확 일치만*(superset 재사용 금지).** superset 재사용은 무관 선언을 적용해 *조용한 서식 오염*을 낳음. — 근거: §5.3.

**비목표(non-goals)는 §10.2에 명시.**

---

## 2. 중심 긴장 해소 — React + 자체 엔진 + 헤드리스를 한 모델로

### 2.1 긴장의 정체

- 사용자는 "React로 요소를 관리"(JS 세계)를 원한다.
- D2는 "브라우저가 아닌 자체 엔진이 렌더"(Rust 세계)를 강제한다.
- "헤드리스 in Rust"는 JS 런타임을 금지한다.

이 셋이 충돌하지 않으려면, **정전 문서가 무엇인지** 와 **JS가 어디까지 관여하는지** 를 못박아야 한다.

### 2.2 채택안: **Framing A (직렬화/AI 편집 표면) — 단, JSX/CSS는 *코덱*이지 *정전 in-memory 모델*이 아니다**

두 후보:

- **(A) JSX/CSS = 언어 중립 직렬화 + AI 편집 표면.** 정전 in-memory는 Rust 타입(`SemanticDoc`). JSX/CSS는 `SemanticDoc` 위의 **양방향 코덱**(load 시 parse, save 시 emit) — `hwp-hwpx`가 `SemanticDoc`의 코덱인 것과 동일. **헤드리스 경로에 JS 런타임 0.**
- **(B) 전부 JS/React 경유(react-dom/server로 HTML), 헤드리스에 JS 엔진 임베드.**

**A를 채택. B 기각.** 근거:

1. **코드가 이미 server-authoritative**다. 모든 Tauri 커맨드는 `hwp_mcp::apply_intent`의 얇은 래퍼이고(`crates/hwp-viewer/src/lib.rs`), Rust가 문서를 소유하며 UI는 Intent를 보내고 지오메트리를 다시 fetch한다. *오늘 정전인 client-side state는 없다.* B는 JS 런타임이 *없는* 파이프라인에 JS 런타임을 *추가*하는 것 → "헤드리스 in Rust" 위반.
2. B는 레이아웃을 브라우저에 넘겨 D2 위반, `hwp-typeset`·caret·op-bus 투자를 폐기.
3. B가 사는 유일한 것("공짜 HTML" `renderToString`)은 우리가 원치 않는다 — 우리는 *reflow*가 아니라 *paint*한다.

**A의 핵심 트위스트 (critique 반영):** JSX/CSS를 *정전 IR*로 삼으면 op-bus(현재 `&mut SemanticDoc` 변이), `intern_char_shape`/`intern_para_shape` 풀, undo 스냅샷(`SemanticDoc.clone()`), 그리고 무엇보다 **round-trip-safety 불변식**(`Provenance`/`Passthrough`/`Dirty`, `types.rs:35-69`)을 전부 문자열 버퍼 위에 재구현해야 한다. 이는 현존 기반 위에서 buildable하지 않다. 그래서:

> **정전 = `SemanticDoc` (Rust 타입). JSX/CSS 프로젝트 = `SemanticDoc`의 결정적·양방향 투영.** op-bus·typeset·caret·내보내기는 *타입드 Rust 구조체* 위에서 그대로 돌고, JSX/CSS는 *디스크 직렬화 + AI 편집 표면 + semantic-reflow 내보내기 형태*가 된다.

### 2.3 React의 역할 (요구 1 "React가 요소를 관리"를 *정직하게* 충족)

- React는 **chrome**(타이틀바, ⌘K 팔레트, find bar, AI 패널, 프로젝트 파일 트리, **Inspector**)을 렌더한다 — 평범한 React DOM.
- 문서는 React가 그리지 않는다. **`<DocumentCanvas>`** 가 Rust가 만든 `PageLayerTree`(paint IR)를 canvas/SVG에 **블릿(blit)만** 한다(D2). 브라우저는 reflow 0.
- "요소 관리"의 실체 = **Inspector**: canvas에서 노드 선택 → Content/Design 탭 → op-bus `Op` 디스패치. 이것은 op-bus 위의 controlled tree이지 reconciler가 아니다.

> **custom react-reconciler(react-three-fiber/react-pdf 식)는 채택하지 않는다.** 그 패턴은 *host instance가 JS에 사는* 경우(Three 씬그래프, PDF 문서)에 의미가 있다. 여기선 host instance가 **Rust**(Wasm/IPC 뒤)에 산다. reconciler가 매 변이를 경계 너머로 왕복시켜 Rust 구조체를 바꾸고 다시 지오메트리를 끌어와 canvas를 그리는 것은 *양쪽의 최악*이다(React diffing은 무용 — Rust가 revision으로 diff 권위, 게다가 경계 레이턴시). 요구 1은 **의미적으로** 충족된다(편집 표면이 React) — 그러나 **정전 트리는 Rust다**("헤드리스 in Rust"가 이긴다). 이 트레이드오프를 사용자에게 명시한다.

### 2.4 데이터 흐름

```
                                    ┌──────────────── INPUT (D1: hwp + hwpx) ────────────────┐
                                    │                                                          │
  .hwp bytes ──(rhwp parse+lift)──┐ │  .hwpx bytes ──(hwp-hwpx parse)──┐                       │
                                  ▼ ▼                                  ▼                        │
                          ┌────────────────────────── SemanticDoc (정전, in-memory) ──────────┐
                          │  Section/Block/Paragraph/Run/Inline + CharShape/ParaShape 풀        │
                          │  + Provenance/Passthrough(Raw) + Dirty + NodeId   (변경 없음)       │
                          └───────┬──────────────────────────────────┬───────────────────────┘
                                  │  op-bus(EditSession): Insert/Delete/SetCharPr/Table*/...    │
                                  │  undo/redo 스냅샷 + revision + dirty                         │
                                  ▼                                                              ▼
   ┌──────── hwp-jsx 코덱 (신규) ────────┐                       ┌──────── hwp-typeset (자체 레이아웃) ───────┐
   │ emit:  SemanticDoc → JsxCssProject  │  ◀──양방향──▶          │ greedy line-break + paginator + table       │
   │ parse: JsxCssProject → SemanticDoc  │  (dirty-only)         │ (StyledNode 입력으로 일반화)                │
   │  document.jsx / styles/*.css / ...  │                       └───────┬───────────────────────────────────┘
   └───────┬─────────────────────────────┘                               ▼ LayoutResult{pages, LineSeg}
           │  (디스크 = "프로젝트 폴더" / .tfhwp)                  ┌──────── hwp-render (신규 구현) ───────┐
           │  AI 편집 표면 + semantic-reflow 내보내기              │ walk(SemanticDoc ∥ LayoutResult)      │
           ▼                                                      │  → PageLayerTree{ops}  (재설계 enum)   │
   ┌──── 내보내기 (hwp-export, 신규) ────┐                        └───────┬───────────────────────────────┘
   │ HTML(semantic-reflow=직렬화 /         │                              ▼ PageLayerTree (paint IR)
   │       layout-preserve=page-box)       │            ┌─────────────────┼─────────────────────────────┐
   │ PDF (paint IR 재생 → printpdf)        │            ▼                 ▼                 ▼            ▼
   │ docx(restricted → OOXML, stretch)     │      Canvas/SVG sink     PDF sink         HTML sink    tiny-skia
   └──────────────────────────────────────┘      (webview, D2)     (printpdf)        (absolute)    (golden)
                                                       │
                                                  caret geometry: page_glyph_boxes ← PageLayerTree::TextRun
                                                  hit_test / caret_rect (rhwp 순수함수 재사용, 소스만 교체)
```

**한 문장 요약:** `parse → SemanticDoc → (op 편집) → {hwp-jsx 코덱 ↔ 디스크} / {typeset → render → paint IR → canvas|HTML|PDF}` — 전 구간 Rust, JS 런타임 없음.

---

## 3. 문서 모델 — JSX(내용)+CSS(디자인) 프로젝트 IR

### 3.0 정전 vs 투영 (반드시 먼저)

- **정전(canonical):** `hwp-model::SemanticDoc` (in-memory, Rust). op-bus·typeset·caret·undo·find가 이것을 만진다. **변경 최소.**
- **투영(projection):** `JsxCssProject` (디스크 + AI 편집 표면). `hwp-jsx` 코덱이 `emit`/`parse`.
- **불변식:** `parse(emit(doc)) == doc` (모델링된 것은 값-동일, un-modeled은 바이트-동일). 이게 깨지면 JSX/CSS-canonical 전제가 틀린 것 — **M0 게이트로 가장 먼저 검증**(§9).

### 3.1 JsxCssProject 노드 모델 (디스크 형태의 타입)

`hwp-jsx` 크레이트가 emit/parse하는 타입. `SemanticDoc`의 노드와 1:1 대응:

```
JsxNode = Element(JsxElement) | Text(JsxText)
JsxElement { tag: Tag, class_list: Vec<ClassRef>, id: Option<NodeKey>,
             attrs: BTreeMap<String,String> (data-*, colSpan, href...), children: Vec<JsxNode> }
JsxText    { node_key: Option<NodeKey>, text: String }

Stylesheet { rules: Vec<CssRule> }
CssRule    { selector: Selector(.class | #id | Tag), decls: BTreeMap<CssProp, CssValue> }
```

**`Tag`는 닫힌(closed) HWP-시맨틱 어휘** (임의 HTML 아님):
`Document, Section, Page, Para, Run, Span, Table, TableRow, TableCell, Image, Equation, Field(FieldKind), Note(NoteKind), Bookmark, Header, Footer, Raw`.
닫힌 이유: (a) 레이아웃 엔진이 각 태그의 flow 시맨틱을 알아야 함, (b) JSX 파서·AI가 다룰 표면을 한정, (c) `Raw`가 un-modeled 내용을 verbatim 보존(round-trip 안전).

**`SemanticDoc` ↔ `Tag` 매핑 (1:1, 모델 변경 0):**

| SemanticDoc | JSX 요소 | 비고 |
|---|---|---|
| `Section` | `<Section data-sec=i>` | 섹션당 .jsx 파일 1개 |
| `Block::Paragraph` | `<Para className="pN">` | pN = ParaShape 풀 인덱스 (§3.4) |
| `Run`+`Inline::Text` | `<Run className="cN">텍스트</Run>` | cN = CharShape 풀 인덱스. caret offset 안정성 위해 v1에선 run 병합 안 함(reflow 모드에서만 선택적 병합) |
| `Inline::Image` | `<Image src="assets/.." data-w data-h/>` | bytes ← BinData |
| `Inline::Equation` | `<Equation script="1 over 2"/>` | HWP 수식 스크립트 **verbatim**(transcode 없음). 다운스트림서 MathML/자체 렌더 |
| `Inline::FieldBegin/End` | `<Field kind=.. data-cmd=..>…</Field>` | 하이퍼링크는 `<Field kind="hyperlink" href=..>`; 그 외 inert 보존 |
| `Inline::Bookmark` | `<Bookmark id="bm-name"/>` | |
| `Inline::Note` | `<Note kind data-num><body…/></Note>` | inline 마커 + 중첩 본문; 배치는 paginator가 |
| `Inline::Raw(RawPart)` | `<Raw data-tag=.. data-b64=../>` | **un-modeled 내용을 base64로 보존** — round-trip 안전 계약. layout서 inert |
| `Block::Table` | `<Table className="tN"><TableRow><TableCell colSpan rowSpan>…` | `Cell.active=false`(피복 셀)은 emit 생략, 살아있는 셀이 span 보유 — `AppendRichTable`가 만드는 모양과 동일 |
| `Section.decorations`(머리/꼬리말) | `<Header apply="odd">…</Header>` | 섹션 스코프, paginator가 배치 |

### 3.2 식별자 (NodeKey) — 기존 스킴 일반화

- 모든 addressable 노드가 `NodeId(u64)`(`types.rs:28`) 보유. 오늘은 id-bearing paragraph만 — v2는 `assign_node_ids`를 일반화해 모든 요소에 부여.
- **디스크 안정 형태 = 구조적 경로**: 기존 `section:S/para:P/char:C[/cell:…]` 문법을 일반화. JSX의 `id`/`data-nid` 속성으로 직렬화 → re-parse 후에도 동일 노드 식별.
- `resolve_key_to_node`/`node_to_section_para_ord`/`parse_stable_key`(`hwp-rhwp/src/lib.rs:247,273,296`)는 거의 verbatim 생존 — "id-bearing paragraph 카운트"를 "DocNode children 경로 해석"으로 일반화만.
- op-bus의 `Caret{node, offset}`/`Range{start,end}`는 `NodeId`로 주소 지정 — AI 타겟팅·undo 주소 변경 없음.

### 3.3 지원 JSX subset (디스크 문법, Rust 직접 파싱 — *순수 선언적 데이터*)

> **결정(critique 반영): `.map()`·조건문·임의 JS 표현식 전면 금지.** 표현식이 들어오는 순간 파서는 *데이터 포맷*이 아니라 *언어*를 평가하게 되고, 이는 JS 런타임을 향한 scope creep다. 닫힌 문법을 **조기 동결**한다.

허용:
- 파일당 default-export 함수 컴포넌트 1개, 루트 요소 1개.
- 요소 이름 = 닫힌 `Tag` 집합.
- 속성: `className="a b c"`, `id="n42"`, `data-*`, 태그별 타입드 prop(`<Image src w h/>`, `<Table rows cols/>`). `style={{...}}`은 **린트 경고**("design이 headless로 누출"), AI 라우터는 크기 변경을 CSS로 보냄.
- children: 중첩 요소 | 텍스트 | `{문자열/숫자 리터럴}` 만.
- **금지:** 임의 JS, 조건/반복, 함수 호출, 컴포넌트 합성(props.children) — v1.
- 문법 밖 구성은 **`<Raw>`로 패스스루**(파서가 절대 죽지 않음). import 시 린트.

파서: hand-rolled recursive-descent (general JSX/TS 파서 아님). `hwp-hwpx`의 quick-xml 파싱 규율 재사용.

### 3.4 지원 CSS subset (닫힌 `CssProp`)

- 셀렉터: `.class`, `#id`, `Tag` (flat). **descendant combinator·specificity 엔진 없음.** cascade = class_list 순서 → inline. tie-break = inline > .class > Tag.
- 단위: px/pt/%/em. 색: hex/rgb.
- 지원 `CssProp` (레이아웃 엔진이 *전부* 소비할 수 있는 것만):
  `font-family, font-size, font-weight, font-style, text-decoration, color, background-color, text-align(+ HWP distribute/distribute-space는 data-attr로), line-height, margin-*, padding-*, text-indent, width, height, border-*, display(block|inline|inline-block|table*), vertical-align, letter-spacing(자간), font-stretch/transform:scaleX(장평), white-space, page-break-before`.
- **미지원(연기, 가장 가까운 값으로 폴백):** float, position(내부 absolute paint 외), flex/grid, margin-collapsing, background-image, gradient, transition, @media, calc(), pseudo(:first-line/:first-letter 연기), media query.
- **CharShape/ParaShape ↔ CSS:** 오늘 `Run`은 이미 `CharShape`를 *인덱스로* 참조 == 클래스. 풀 인덱스 `i` → `.cN`/`.pN`. 즉 **dedup이 공짜로 상속**된다(`intern_char_shape`/`intern_para_shape`, `hwp-ops/src/lib.rs:198,207`). `CharShape::is_default()`/`ParaShape::is_default()`로 default shape는 클래스 생략(풀 축소).

**Korean-specific 누출(정직하게):** per-script 폰트(`face_id: PerScript<u16>`, 7 슬롯), 배분/나눔 정렬, 장평/자간, klreq line-spacing 모드는 단일 CSS 속성으로 표현 불가. → `data-*`/CSS custom prop으로 *의도 보존*하고 **우리 엔진만** 정확히 렌더. (브라우저로 raw HTML 내보내면 이 부분은 다름 — §6.4 정직성 명시.)

### 3.5 파일/프로젝트 레이아웃

문서를 **프로젝트 디렉터리**(또는 zip된 `.tfhwp`)로 연다:

```
mydoc.tfhwp/
  project.json          매니페스트: doc id, 섹션별 PageSetup(HWPUNIT), 폰트 테이블,
                        bin 매니페스트, per-script 폰트 맵(7슬롯), schema 버전, fidelity 모드, reflow collapse 맵
  document.jsx          루트 <Document> — <Section> 자식 import
  sections/
    section-0.jsx       <Section> → <Para>/<Table> (내용/HEADLESS)
    section-1.jsx
  components/           재사용 서브트리 (복잡한 표, 머리/꼬리말)
  styles/
    base.css            태그 기본값 (Para/Run/Table) = 문서 default charPr/paraPr
    theme.css           디자인 토큰 (CSS custom prop: 색/폰트 스케일/간격)
    document.css        deduped 클래스 풀 (.c1 .c2 .p1 ...) (DESIGN)
  assets/
    img-1.png           추출된 BinData
```

- **JSX = 구조+내용+className/id (디자인 값 0).** **CSS = 모든 폰트/크기/색/간격/테두리.** 린트가 강제(요구 3).
- **섹션당 .jsx 1개** = `SemanticDoc::sections`와 1:1 → dirty-only 재emit(섹션 dirty → 그 파일만 재작성). 기존 per-section dirty 규율 verbatim 재사용.
- `project.json`이 **무손실 사이드 채널**: design도 content도 아닌 것(섹션별 PageSetup, bin 매니페스트, per-script 폰트, fidelity 모드) 전부 — JSX를 깨끗(HEADLESS)하게 유지하면서 round-trip 정확.

### 3.6 두 충실도 모드 (D4) — 하나의 정전, 두 투영

`SemanticDoc`는 모드 무관. `RenderMode` 플래그가 투영을 선택:

- **LAYOUT-PRESERVE:** importer가 원본 지오메트리 보존(Page에 원본 PageSetup, CSS에 원본 margin/indent/line-spacing). Hancom `linesegarray` 존재 시 Provenance에 보관해 paint가 재생(read-only 충실). 셀렉터는 대부분 `#id`/inline. **v1 현실(critique): 자체 엔진이 글자-정확이 아니므로, layout-preserve 뷰는 rhwp SVG를 그대로 쓴다(§4.3).**
- **SEMANTIC-REFLOW:** 같은 트리를 깨끗한 web 출력으로 재투영 — absolute 위치 제거, design을 공유 *클래스*로 수렴(동일 ComputedStyle 클러스터링 → 적고 재사용 가능한 CSS 규칙; AI 요구 4의 "기존 규칙 재사용"에 직결), 태그 정규화(heading 스타일 run → semantic). hwp-typeset이 export viewport로 reflow. **HTML/PDF 내보내기·편집의 기본 모드.**

모드는 *투영 + importer lift 정책*의 속성(project.json 저장). 모드 전환 = 투영 재실행, 정전 트리는 fork 안 됨. reflow 모드 편집도 op-bus op이므로 양 모드에 반영.

---

## 4. 파이프라인

### 4.1 변환: hwp/hwpx → SemanticDoc → JSX+CSS (두 모드)

1. **입력 파싱(재사용):** `.hwp`→rhwp parse+lift, `.hwpx`→`hwp-hwpx` parse → `SemanticDoc`. (입력 코덱 변경 없음.)
2. **(편집) op-bus:** `EditSession` 위 typed op.
3. **emit(`hwp-jsx`):** `SemanticDoc → JsxCssProject`. 풀 인덱스 → `.cN`/`.pN` 클래스(dedup 상속). default shape는 클래스 생략. `<Raw>`+project.json이 Passthrough/Provenance/bin_data 보존. **dirty-only emit**(미변경 파일 바이트-안정).
4. **모드 분기:**
   - LAYOUT-PRESERVE emit: 섹션 = 고정 크기 `<Page>` 스택. (자체 엔진 글자-정확 전까지는 §4.3대로 rhwp SVG 뷰.)
   - SEMANTIC-REFLOW emit: flow 컨테이너 + 공유 클래스. 인접 동일-클래스 run 선택적 병합(collapse 맵을 project.json에 기록 → caret 안정).

특수 매핑: 배분/나눔 → `text-align:justify` + `data-justify="distribute"`(엔진이 honor). 장평 → `transform:scaleX(ratio/100)` + `data-jangpyeong`. 자간 → `letter-spacing`. per-script 폰트 → 지배 face는 CSS `font-family`, 전체 7슬롯 맵은 project.json(엔진 폰트 피커가 사용).

### 4.2 자체 엔진 렌더 — paint IR (**미작성 서브시스템, "stub 확장" 아님**)

> **정직성(critique): 모델 `PaintOp`는 `Glyph{x,y,ch,size}`/`Rect{x,y,w,h}`/`Image`(색·폰트·stroke·TextRun 없음, per-char)이고, caret이 읽는 것은 rhwp의 `PaintOp::TextRun{bbox,run}`(`hwp-rhwp/src/lib.rs:365`) — *다른 타입*이다.** 따라서 "additive, schema v1 유지"는 거짓. `PaintOp` enum **재설계 + schema bump(2)** 가 새 작업이다. `NullRenderer`는 `ops: Vec::new()`(`hwp-render/src/lib.rs:22`)로 *아무것도* emit하지 않는다.

**재설계된 `PaintOp` (hwp-model::layout, schema_version=2):**
```
PaintOp =
  TextRun { x, baseline_y, text: String, font: FontKey, size, color, weight, italic,
            decoration, key: StableKey, char_start }   // per-char Glyph 대체. 1 TextRun == 1 GlyphBox
  | Rect  { x, y, w, h, fill: Option<Color>, stroke: Option<(Color, width)> }  // 테두리/배경/셀 음영/표 그리드
  | Image { x, y, w, h, bin_ref }
  | Line  { x0, y0, x1, y1, color, width }              // 셀 테두리/밑줄 폴백/hr
```

**렌더(`hwp-render` 실구현):** `(SemanticDoc 트리 ∥ LayoutResult)` 병행 walk. 페이지마다: (a) box 장식(Rect/Line: 테두리/배경) 페인트 순서 → (b) TextRun/Image. `PageLayerTree{ops}`를 z-order로. **각 TextRun을 rhwp와 동일한 StableKey 스킴**(`section:S/para:P/char:C[/cell:…]`)으로 emit → `resolve_key_to_node`/caret이 바이트 호환. (rhwp를 GlyphBox 소스에서 *교체*하는 것이지 GlyphBox 계약을 바꾸는 게 아님.)

**CSS box model 측정기(신규):** `ComputedStyle → {margin,border,padding,width,height,display}`. block flow = 기존 vertical cursor 루프에 box model 높이 가산. inline flow = 기존 greedy breaker, 단 "chars" 스트림이 inline children(각자 ComputedStyle 보유 → 줄 중간 `<Run class=bold>`가 FontKey 변경)에서 생성. `line_width = container content width − (margin+border+padding+text-indent)`(루프 앞 뺄셈). margin-collapsing v1 = 없음(가산, 문서화).

> **인라인 cascade 복잡도 정직성:** 한 줄이 N개 inline span(각자 폰트/크기)을 담을 수 있다. greedy breaker는 per-style measure, 줄 높이 = span들의 max. 현 코드는 줄당 단일 폰트 가정(`plain_font()`) — 이건 "루프 앞 뺄셈"이 아니라 **실제 inline-formatting-context 작업**이다.

**paint sink (PaintSink 트레이트 존재, 4개 재생, screen==export 보장):**
- WEBVIEW(D2): `PageLayerTree`를 JSON 직렬화 → Tauri IPC → React canvas 컴포넌트가 ops 재생(Canvas2D fillText/fillRect/drawImage). 브라우저 레이아웃 0.
- PDF(D1): 같은 ops를 printpdf로 재생(순수 Rust).
- HTML(D1): layout-preserve=absolute div / semantic-reflow=깨끗한 클래스 HTML.
- GOLDEN: tiny-skia raster(픽셀 회귀, 오프라인).

### 4.3 layout-preserve의 정직한 v1 전략 (rhwp SVG 유지)

> **결정(critique): `98.9%`는 *줄 개수* 충실도다(`oracle=rp.line_segs.len()`, `ours=layout_paragraph(...).len()`, `if ours==oracle`, `hwp-rhwp/src/lib.rs:1093-1099`).** 어디서 줄이 끊기는지·글자 x는 측정하지 않으며 `ApproxFontMetrics`(0.5/1.0/0.3 EM)로 돈다. 따라서 자체 엔진의 layout-preserve "원본처럼 보임"은 **존재하지 않는 shaper에 건 베팅**이다.

- **v1: layout-preserve 뷰 = rhwp SVG(sanitize 후 canvas/SVG에 표시).** 이미 충실하고 완성됨(현 뷰의 ~90%).
- **자체 엔진 = semantic-reflow 단일 모드를 담당.** 측정 가능(reflow가 layout-check 대상)하고 사용자의 핵심 니즈(편집+web 출력).
- shaper(rustybuzz + 폰트 발견/폴백 + per-script face + PDF CID 임베드)가 자체 엔진을 글자-정확으로 끌어올리면 그때 layout-preserve를 자체 엔진으로 승격. 그 전엔 **승격하지 않는다.**

### 4.4 캐럿 — 통째 재사용, GlyphBox 소스만 교체

- `hit_test_page`/`caret_rect_in_page`/`caret_in_run`은 `&[GlyphBox]` 위 순수함수(`hwp-rhwp/src/lib.rs:402,469,489`) — rhwp 특정 로직 없음. 통째 재사용.
- 신규 `page_glyph_boxes_from_layertree`: 우리 `PageLayerTree`의 `PaintOp::TextRun`을 walk해 `GlyphBox` 생성(x0=x, x1=x+advance, top=baseline−ascent, key, char_start). 이 한 함수가 교체 전부 — 단, **StableKey 패리티가 load-bearing**(키 어긋나면 잘못된 paragraph로 조용히 resolve; footnote-flatten 드리프트 버그 `lib.rs:267`가 그 미묘함의 증거). **rhwp 오라클 대비 key-parity 테스트 필수.**
- `caret.ts`(순수 좌표 수학, DOM-free)는 React로 로직 변경 0 포팅.
- "보간 x → 정확 x" 업그레이드는 shaper가 오면 공짜(우리가 정확 advance를 emit하므로).

---

## 5. AI 라우팅 — 내용→JSX / 스타일→CSS / 구조→JSX+CSS

### 5.1 분류 (요구 4)

`EditClass`:
- **ContentOnly(JSX만):** "내용 수정/문장 다듬기/오타/번역" → JSX 텍스트·children만.
- **StyleOnly(CSS만):** "글꼴 14pt/제목 빨강/줄간격 좁게/가운데" → stylesheet(또는 노드 className)만.
- **Structural(JSX+CSS):** "표 추가/3단 구획/콜아웃" → JSX 노드 삽입 + 필요한 CSS 규칙 보장(**dedup**: 기존 규칙 재사용, 진짜 새 design만 신규).

분류는 LLM 단계지만 **op에서 사후 도출이 권위**: emit된 op가 JSX op만 건드리면 ContentOnly, CSS op만이면 StyleOnly, 둘 다면 Structural. 모델 self-label은 advisory. preview 헤더가 "이 편집은 CSS만 변경(JSX 불변)"을 단언.

### 5.2 op 어휘 (hwp_ops::Op 확장; apply는 `&mut SemanticDoc` 유지 — 투영이므로)

**JSX(내용) op:**
- `JsxSetText{node, text}` / `JsxSpliceText{node, start, len, text}` (char-space, Korean-safe — find.rs 규율) — `InsertText`/`DeleteRange`의 직접 대응.
- `JsxInsertNode{parent, index, node}` / `JsxRemoveNode{node}` / `JsxMoveNode{...}`.
- `JsxSetAttr{node,name,value}` / `JsxRemoveAttr` / `JsxAddClass` / `JsxRemoveClass`.

**CSS(디자인) op (전부 dedup-aware):**
- `CssSetDecl{selector, prop, value}` / `CssRemoveDecl` — "글꼴 크기 변경"의 흔한 케이스.
- `CssUpsertRule{selector, decls}` — 기존 규칙에 머지(중복 생성 안 함).
- `CssEnsureClass{decls} -> ClassName` — **dedup 프리미티브**(§5.3).

**Structural = op 배치**(atomic 단일 undo 단위, `do_ops`): "표 추가" → `CssEnsureClass{table}` → `CssEnsureClass{cell}` → `JsxInsertNode{<Table className=..>}`. CSS-ensure가 **먼저** 실행돼 JSX가 *존재 증명된* 클래스를 참조. dedup 덕에 두 번째 표는 새 CSS op 0 — 배치가 `JsxInsertNode`로 축소.

이 op들은 `SemanticDoc` 변이로 lower된다(투영 코덱이 다시 JSX/CSS로 emit). op-bus·undo·dirty·find 메커니즘 변경 없음.

### 5.3 CSS dedup 알고리즘 (요구 4 "중복 금지")

`CssEnsureClass(decls)`:
1. decls 정규화(BTreeMap prop 순서, 값 정규화 `14pt`/`14.0pt`, 색 `#FF0000`/`#f00`).
2. **정확(exact) decl-set 일치** 규칙 탐색 → 그 클래스 재사용.
3. 없으면 `u-<base36(hash)>` 새 규칙 1개 push, 반환.

> **결정(critique): superset 재사용 금지(v1).** "decls의 superset인 규칙 재사용"은 그 규칙이 *무관한 선언도* 함께 적용 → **조용한 서식 오염**. 정확-정규화-일치만 허용하고 클래스가 더 생기는 것을 받아들인다. (superset은 flag 뒤 later.) 이는 `intern_char_shape`(find-or-push, `hwp-ops/src/lib.rs:198`)와 동일 패턴 — 사실상 CSS 클래스 interning.

"글꼴 크기 변경" StyleOnly에서 "이 요소만"(새 클래스 fork) vs "이런 것 전부"(공유 규칙 편집)는 model의 `style_patch` scope가 구분 → `CssEnsureClass`+`JsxAddClass` vs `CssSetDecl`. blast-radius가 다르므로 **preview에 영향 노드 수 표시**.

### 5.4 propose → commit (verbatim 재사용)

`propose → scratch clone dry-run → Proposal{ops, rationale, preview} → commit`(hwp-ai/lib.rs:184-210, MCP Intent::Propose/Commit) 구조 변경 0 — `doc.clone()` 그대로(정전이 SemanticDoc이므로 *변경조차 없음*), 새 op만 apply. `op_summary` 확장:
- `JsxSpliceText` → "✎ 내용: '…'→'…' (JSX만)"
- `CssSetDecl` → "🎨 디자인: .heading font-size→14pt (CSS만)"
- `CssEnsureClass`(재사용) → "♻ 기존 .tbl 재사용 (CSS 추가 없음)" / (신규) → "＋ 새 스타일 .u-3f2"
- structural → "표 추가: JSX 1노드 + CSS 0신규/2재사용"

`AiContent`/`AiBlock`/`AiRun` JSON 스키마(`hwp-ai/src/content.rs`)는 **structural arm에 그대로 재사용** — 컴파일러 백엔드만 `intern_char_shape` 대신 `CssEnsureClass`로 lower. `template_brief()`에 라우팅 preamble 추가. MCP에 `Intent::ProposeEdit{instruction,target}` / `ApplyEdit{json}` 추가(기존 Propose/Commit 변경 없음).

**EditTarget 해석:** GUI selection(`HitTest`→{NodeKey,offset}) / find Match(`find.rs`) / data-nid 인용 → op가 주소 지정할 NodeKey. (오늘 append가 `section:0` 하드코딩하던 자리를 해석된 NodeKey가 대체.)

> **라우팅 정직성(critique):** lift가 *전부 고유* 클래스를 만들면(공유 utility 없음) 거의 모든 스타일 편집이 새 클래스를 fork → dedup이 발화 안 함 → 요구 4가 조용히 실패. **라우팅은 좋은 lift(공유 시맨틱 클래스 emit)에 의존** — 라우팅 단독으로 못 고침. semantic-reflow의 클래스 수렴 패스(§3.6)가 이를 담보.

---

## 6. 내보내기 — HTML / PDF (+ docx 일부)

신규 크레이트 `hwp-export` (순수 Rust, wasm-safe, GUI 독립). 하나의 `Exporter` 트레이트, 세 impl. **세 백엔드 모두 Rust 코어 — CLI/MCP/Tauri가 동일 함수 호출, 같은 바이트 산출.** soffice/headless-Chrome 없음.

### 6.1 HTML (Rust emitter, 레이아웃 엔진 아님 — semantic-reflow)

JSX 트리는 이미 HTML-shaped → 구조적 전사(transcription). emit:
- CSS 패스: 프로젝트 .css를 `<style>` 블록(또는 sidecar). sanitize 게이트(`@import`/`url(javascript:)`/`expression()` 제거 — P0-4 규율 계승).
- JSX 패스: `<Para>`→`<p>`, heading→`<hN>`, `<Table>`→`<table>`, `<Run className>`→`<span class>`, `<Image>`→`<img>`, hyperlink→`<a>`, note→`<sup>`+`<aside>`. className은 공유 stylesheet 참조(요소별 inline 중복 금지 — AI 요구 4의 export-side 거울).
- assets: BinData → `data:` base64(`embed_assets`) 또는 sidecar.
- **레이아웃 엔진 미사용 이유:** HTML의 가치는 소비자 쪽 브라우저가 reflow하는 것. paginator를 먼저 돌리면 줄바꿈이 absolute div로 동결(취약/비접근성).

### 6.2 HTML (layout-preserve) = emitter + 페이지 박싱

JSX가 원본 페이지 지오메트리(크기/여백)를 data로 보유 → 같은 pagination(hwp-typeset)으로 페이지 박스 추출 → 페이지당 `<section class="page">` + print CSS(`@page{size:A4} .page{page-break-after:always}`). **글자-absolute로 가지 않음**(그건 PDF의 일). 페이지 수·페이지 단위 배치 보존, 페이지 내 reflow 허용 — 정직한 중간.

### 6.3 PDF — paint IR 재생 (자체 엔진)

```
JsxCssProject → CssBoxModel resolve → hwp-typeset layout → hwp-render PageLayerTree → PdfPaintSink(printpdf)
```
- printpdf(순수 Rust, MIT). 페이지 = 페이지 mm 크기. TextRun→text-show, Rect→fill/stroke, Image→임베드 XObject. HWPUNIT→pt = `hwpunit/100`.
- **폰트/shaping = 가장 큰 비용(critique):** PDF는 임베드 폰트 + 실 advance 없으면 글자가 깨짐. `fontdb`(발견) + `rustybuzz`(shaping/advance)를 실 `FontMetricsProvider`로, glyph subset+embed. **shaper 전까지: 번들 OFL 한글 폰트(Noto Sans KR) 1개 + 근사 advance = "shippable but not pixel-perfect"**(HTML 블로킹 안 함).
- 두 모드: PDF는 본질상 고정 레이아웃. layout-preserve=원본 지오메트리 트리, semantic-reflow=reflow 트리 + web-ish 페이지.

### 6.4 docx (.docx) — "to some degree" (stretch, model→OOXML)

HTML→docx 아님. `SemanticDoc`(또는 restricted JsxCssProject) → WordprocessingML: `<Para>`→`<w:p>`+`<w:pPr>`, `<Run>`→`<w:r>`+`<w:rPr>`, `<Table>`→`<w:tbl>`(gridSpan/vMerge), `<Image>`→`<w:drawing>`. `zip` 워크스페이스 dep으로 OPC 패키징(HWPX 패커 규율 거울).
**정직한 충실도 성명(CLI --help에 표기):** 문단/run/문자서식/heading/단순+병합 표/이미지/하이퍼링크 커버. 수식·텍스트박스·도형·차트·정확한 줄바꿈/페이지 지오메트리·각주는 미커버(이미지 rasterize 또는 alt-text drop+경고 — **절대 조용히 손상 금지**).

### 6.5 내보내기 정직성 요약

| 목표 | 모드 | 충실도 |
|---|---|---|
| HTML | semantic-reflow | 깨끗·접근성·재선택, 브라우저 reflow. Korean-specific는 data-* (raw 소비자엔 부정확) |
| HTML | layout-preserve | 페이지 박싱(페이지 단위 보존, 페이지 내 reflow) |
| PDF | both | 자체 엔진 페인트. **shaper 전엔 근사 위치**(pixel-perfect 아님) |
| docx | — | 부분 — 명시적 경고, fallback, 조용한 손실 없음 |

---

## 7. 헤드리스 — 하나의 Rust 코어 공유

헤드리스 스켈레톤은 *이미 존재·테스트됨*: `hwp_mcp::{Intent, Outcome, apply_intent, Session}`(`hwp-mcp/src/lib.rs`)이 GUI-free·browser-free op-bus 디스패처. loopback HTTP(`server.rs`, 127.0.0.1-only + Host/Origin allowlist + constant-time bearer) + stdio MCP(`main.rs`)도 순수 std::net/stdin-stdout.

**의존 형태:**
```
        hwp-jsx (신규: JsxCssProject 코덱) ── hwp-export (신규: HTML/PDF/docx)
                          │                          │
        hwp_mcp::Session/Intent/apply_intent (공유 코어, 확장)  ── hwp-render(실구현) ── hwp-typeset
                          │
  ┌──────────┬───────────┼───────────┬──────────────┬───────────┐
tf-hwp-cli  mcp stdio   mcp HTTP   hwp-viewer(Tauri)  Wasm     (전부 동일 코어 호출)
(headless)  (agent)     (loopback) (desktop, peer)   (lib)
```

**헤드리스 라이브러리 표면 (`hwp-project`/확장 `hwp-mcp`):**
```
Project::open_bytes / open_path / open_project_dir
       ::apply_intent / undo / redo
       ::page_count / page_layer_tree(page) -> PageLayerTree    // 브라우저 없음
       ::export_html(mode) / export_pdf(opts) / export_project_dir / export_docx(feature-gated)
FidelityMode { LayoutPreserve, SemanticReflow }
```

**CLI(기존 tf-hwp-cli 확장, 새 바이너리 불필요):**
- `tf-hwp open-project <in.hwp|.hwpx> --out-dir <proj/>` — JSX+CSS 프로젝트 디스크화(요구 2).
- `tf-hwp export-html <in> --mode layout|semantic -o out.html` (D1, D4).
- `tf-hwp export-pdf <in> -o out.pdf` (D1).
- `tf-hwp edit-op <proj/> --intent <intent.json>` — op 1개 적용·재기록(AI 라우팅 CLI 표면, dirty .jsx/.css만 재emit).
- `tf-hwp export-docx <in> -o out.docx` (--features docx).

**HTTP 서버:** `hwp_mcp::server::serve` verbatim 재사용 — `tools()`/`call_tool`에 `open_project/export_html/export_pdf/export_project/edit_content/set_style/insert_element`만 추가. `call_tool`과 `apply_intent`가 같은 `do_*` 헬퍼로 funnel → JSON(agent)/typed(GUI) 두 레인 lockstep("never drift").

**JS 런타임 0 재확인:** JSX/CSS는 디스크 직렬화 + AI 편집 표면일 뿐 *실행 표면 아님*. `react-dom/server`는 기껏해야 GUI-side 옵션 프리뷰(비권위)이고 헤드리스/충실도 경로엔 절대 없음.

---

## 8. 레거시 재사용 맵

판정 기준: **reuse**(거의 그대로) / **adapt**(코드 변경, 기능 유지) / **deprecate**(폐기).

| 서브시스템 (파일) | 판정 | 무엇이 남고 / 무엇이 바뀌나 |
|---|---|---|
| **hwp-model SemanticDoc AST** (`document.rs`, `style.rs`, `types.rs`) | **reuse(정전 승격)** | **남음:** 전체 AST가 *in-memory 정전*으로 유지. `Tag`/`CssProp`/`Stylesheet`는 *투영 코덱(hwp-jsx)* 쪽 신규 타입이지 모델 교체 아님. CharShape/ParaShape 7-script·6 align·klreq 그대로. **바뀜:** `assign_node_ids`를 모든 addressable 노드로 일반화. |
| **Provenance/Passthrough/Dirty** (`types.rs:35-69`) | **reuse** | round-trip-safety + dirty-only-emit 규율이 JSX/CSS 코덱으로 verbatim 이전(미변경 파일 바이트-안정, `<Raw>` base64). 프로젝트 #1 불변식. |
| **CharShape/ParaShape interned 풀 (인덱스 참조)** | **reuse → CSS 클래스 모델** | 이미 클래스 기반 stylesheet. 풀 인덱스 = `.cN`/`.pN`. dedup 공짜 상속. |
| **hwp-ops Op enum + apply + EditSession** (undo/redo 스냅샷·revision·dirty, `do_ops` atomic) | **adapt** | **남음:** op 어휘·undo·dirty·revision 메커니즘. `apply`는 `&mut SemanticDoc` 유지(정전이므로 변경 *최소*). **바뀜:** JSX/CSS op arm 추가(§5.2); content op은 투영 코덱이 JSX로 emit. |
| **intern_char_shape / intern_para_shape** (`hwp-ops/src/lib.rs:198,207`) | **reuse(패턴)** | find-or-push dedup = `CssEnsureClass`의 직접 모델. |
| **hwp-ops/find.rs** (Match, find_matches, replace_*_ops, char-space, right-to-left) | **adapt** | 메커니즘 그대로, 타겟이 JSX TextNode(또는 SemanticDoc TextNode)로 retarget. replace 빌더는 `JsxSpliceText` emit. |
| **hwp-typeset NaiveLayout** (greedy line-break·paginator·table_height·is_full_width·line_spacing_ratio) | **adapt** | **남음:** 알고리즘 전부(format-agnostic). **바뀜:** 입력을 `Paragraph.runs`→StyledNode inline children으로 일반화; CSS box model(margin/border/padding→line_width, block_height) 추가; **inline-formatting-context(줄당 다중 폰트)는 실작업**(현재 `plain_font()` 단일 폰트 가정). |
| **layout-check 오라클** (`layout_fidelity`, `hwp-rhwp/src/lib.rs:1044`) | **reuse(측정자) — 단 의미 정정** | **남음:** rhwp(Hancom linesegs) 대비 비교의 측정 도구. **정정:** *줄 개수* 충실도이지 글자-x 아님(§4.3). reflow 경로만 게이트; layout-preserve는 자동 게이트 없음(리스크). |
| **hwp-render** (`NullRenderer`, `ops: Vec::new()`, `lib.rs:22`) | **adapt(사실상 신규)** | **stub 확장 아님 — 미작성.** `PaintOp` enum 재설계(TextRun+color/font, Rect fill/stroke, Line) + schema bump(2). walk(SemanticDoc ∥ LayoutResult)→PageLayerTree 전부 신규. |
| **hwp-model layout.rs** (PageLayerTree, PaintOp, PaintSink, LayoutResult/LineSeg) | **adapt** | **남음:** PageLayerTree/PaintSink/LayoutResult 구조·sink 트레이트. **바뀜:** `PaintOp` enum 재설계(색/폰트/TextRun/stroke), PAINT_SCHEMA_VERSION 1→2. |
| **hwp-rhwp caret 기하** (hit_test_page·caret_in_run·caret_rect_in_page·parse_stable_key·resolve_key_to_node·node_to_section_para_ord, `&[GlyphBox]` 순수) | **reuse(소스만 교체)** | **남음:** 순수함수 통째. **바뀜:** GlyphBox 생산자만 rhwp tree→우리 PageLayerTree::TextRun(`page_glyph_boxes_from_layertree`). **key-parity 테스트 필수.** |
| **hwp-rhwp parse + lift** (DocumentCore→SemanticDoc) | **reuse(입력 코덱)** | **남음:** .hwp 입력 경로(D1). **바뀜(폐기):** rhwp SVG 렌더는 production 렌더 경로에서 *대부분* 빠짐 — **단 v1 layout-preserve 뷰는 rhwp SVG 유지**(§4.3) + 오라클. `--features rhwp`는 parse+오라클+preserve-view 쪽. |
| **caret.ts / commands.ts / api.ts** (순수 TS, DOM-free) | **reuse** | verbatim 포팅(api.ts는 새 커맨드 확장). |
| **hwp-viewer App.tsx / Palette / Composer** (SolidJS) | **adapt** | Signals→hooks, Kobalte→Radix, solid-virtual→react-virtual. App.tsx ~1:1. 명령 본문은 `hwp-app` 크레이트로 이동(body 변경 없음). |
| **hwp-viewer Rust 커맨드** (`apply_intent` 래퍼, SharedSession, pick_provider, server.rs) | **adapt** | **남음:** 로직 전부. **바뀜:** 비-Tauri 절반을 `hwp-app` 크레이트로 추출(데스크톱+헤드리스 서버 공유); viewer는 `#[tauri::command]` shim만. |
| **hwp-mcp Intent/Outcome/apply_intent/Session/server** | **reuse(확장)** | 모델 무관. additive 변이만(PaintPage/SetStyle/Export*/ProposeEdit/ApplyEdit). 기존 variant 변경 0. |
| **hwp-ai LlmProvider/Proposal/op_summary/content.rs schema/template_brief** | **adapt** | **남음:** propose→commit 게이트, AiContent JSON 스키마. **바뀜:** `propose_edit` 추가(propose_content 폴백), 컴파일러가 JSX/CSS op emit, op_summary 라우팅 arm. |
| **hwp-core::Engine** (detect/open/atomic_write) | **reuse** | format detect+lift+crash-safe write 그대로(프로젝트 파일·export 쓰기에도). |
| **tf-hwp-cli** (detect/info/convert/edit/ai-*) | **adapt** | 헤드리스 entry 그대로. export-jsx/import-jsx/export-html/export-pdf/edit-op/export-docx 추가. |
| **hwp-hwpx serialize/synth/open-safety 게이트** | **deprecate** | HWPX-out 폐기(D1). **남음:** parse 경로(입력). **바뀜(손실):** open-safety 인수 테스트(`apply_and_export_via_op_bus` 등) 소멸 → HTML/PDF에 동급 골든-렌더/diff 하니스 신규 필요(§10). |
| **hwp-oracle** (LibreOffice + H2Orestart) | **reuse(테스트만)** | 런타임 export 경로 *아님*. 충실도 오라클/골든 레퍼런스. |
| **hwp-viewer rhwp-SVG 표시 + sanitize.ts** | **adapt(폴백/preserve-view)** | semantic-reflow는 canvas로 전환되나, **layout-preserve 뷰의 백엔드로 유지**(§4.3). sanitize는 이 경로에 계속 필요. |

---

## 9. 단계별 마이그레이션 로드맵 (검수 게이트 포함)

> 원칙(critique): *측정 가능한·믿음에 의존하지 않는* 것을 먼저. 가장 모순적이고 새로운 주장(JSX/CSS = 무손실 투영 + AI JSX/CSS 라우팅)을 **렌더·shaper·React 이전에** 검증.

### M0 — JSX/CSS 투영 왕복 (헤드리스 only, GUI/렌더 0) — **1~2주**

가장 작은 검증 마일스톤. **렌더·shaper·canvas·React·PDF 불필요** → P0 리스크에 sandbag 안 됨.

- 입력 = **hwpx만**(rhwp/.hwp 제외 — feature-gated + shaper 리스크). `hwp-hwpx` parser → SemanticDoc.
- `hwp-jsx`: `SemanticDoc → JsxCssProject` emit + `JsxCssProject → SemanticDoc` parse. `intern_char_shape`를 CSS 클래스 모델로.
- AI 라우팅 op 1개 end-to-end: "노드 X 글꼴 14pt" → `CssSetDecl` → 재emit.

**검수 게이트 (자동):**
1. `parse(emit(doc)) == doc` — `corpus/hwpx/`의 5개 파일(00_smoke_min, footnote-01, form-01, FormattingShowcase, Skeleton) 전부 값-동일(+`<Raw>`/Provenance 바이트-동일).
2. `CssSetDecl` 후 **.css 파일만 변경**(dirty-flag), .jsx 바이트-동일.

**실패 시:** JSX-canonical 전제가 틀린 것 → 2분기 대신 2주에 학습. (정전을 SemanticDoc으로 둔 본 설계가 이미 이 리스크를 헷지.)

### M1 — 자체 paint IR + canvas 패리티 (렌더, shaper 없이) — **3~5주**

- `PaintOp` enum 재설계(TextRun+color/font, Rect fill/stroke, Line), schema 2.
- `hwp-render` 실구현: walk(SemanticDoc ∥ LayoutResult)→PageLayerTree(JSX 없이, ApproxFontMetrics).
- 기존 SolidJS 뷰 뒤에 canvas PaintSink 배선 → rhwp SVG와 A/B로 "브라우저 없는 페인트" 증명.
- `page_glyph_boxes_from_layertree` + caret을 우리 박스로 전환.

**검수 게이트:** layout-check + caret self-check green; **rhwp 오라클 대비 StableKey key-parity 테스트** green; canvas A/B 시각 비교(reflow 단순 문서).

### M2 — CSS box model + StyledNode 입력 경계 — **3~4주**

- `LayoutInput` 트레이트 + SemanticDoc→StyledNode shim(레거시·오라클 유지).
- CSS box model 측정기(margin/border/padding→line_width, block_height).
- **inline-formatting-context**(줄당 다중 폰트) — 실작업, 별도 PR.

**검수 게이트:** layout-check 패리티 이상; inline-style 문단 골든.

### M3 — 내보내기 (HTML semantic + PDF degraded) — **3~4주**

- `hwp-export`: HTML semantic-reflow emitter(레이아웃 엔진 없음) + HTML layout-preserve(페이지 박싱) + PDF(printpdf, 번들 OFL 폰트 + 근사 advance).
- **신규 골든-렌더/diff 하니스**(폐기된 open-safety 게이트 대체): HTML 스냅샷, PDF는 soffice/H2Orestart 오라클과 cross-renderer 비교, docx는 오라클로 openability.

**검수 게이트:** `(project,mode)→bytes` 결정성; HTML/PDF 골든 통과(17개 corpus).

### M4 — React 셸 이관 + Inspector + AI 라우팅 UI — **4~6주**

- SolidJS→React(D3): chrome·Inspector·`<DocumentCanvas>`(canvas sink + caret overlay).
- 크레이트 재구성: `hwp-app`(커맨드 서비스, tauri dep 없음) 추출; `hwp-mcp` export/edit 툴 확장.
- **layout-preserve 뷰 = rhwp SVG 유지**(승격 안 함). semantic-reflow = 자체 canvas.
- Inspector Content/Design 탭 = JSX/CSS op 디스패치(요구 1·3·4 가시화).

**검수 게이트:** 기존 caret 편집(클릭/타이핑/IME) 회귀 없음; "글꼴 변경"이 .css만 변경 + preview가 라우팅 단언; edit→op→Rust→paint→canvas 왕복이 타이핑/IME에 jank 없음(**증분 레이아웃**: dirty paragraph만 재레이아웃 — 신규 필수).

### M5 — shaper(rustybuzz) + layout-preserve 자체 엔진 승격 — **T3~T4, 별도 트랙**

- `fontdb` + `rustybuzz` 실 `FontMetricsProvider`(ApproxFontMetrics 대체), per-script face, PDF CID subset+embed.
- 자체 엔진이 글자-정확 달성 시 layout-preserve를 rhwp SVG에서 자체 엔진으로 승격. **그 전까지 승격 금지.**

**검수 게이트:** **글자-x 충실도 오라클 신규**(현 line-count 오라클을 글자-위치 비교로 확장); caret_in_run 정확; PDF pixel-diff.

### 의존 순서 요약

```
M0(투영 무손실) → M1(paint IR+canvas) → M2(box model) → M3(export) → M4(React 셸)
                                                                          ↘ M5(shaper, 병렬 트랙, layout-preserve 승격 게이트)
```
M0가 게이트 실패하면 그 위 5개 크레이트를 쌓기 전에 전제가 틀렸음을 안다. React 이관·hwp-render·canvas·shaper를 *먼저* 하지 않는다 — 전부 "투영이 건전한가?"의 다운스트림.

---

## 10. 정직한 리스크 + 비목표

### 10.1 리스크 (코드로 검증된 것 우선)

1. **`98.9%`는 줄-개수 충실도(글자-x 아님)**(`lib.rs:1093-1099`, ApproxFontMetrics). layout-preserve "원본처럼"과 정확 caret은 **미존재 shaper에 건 베팅**이며 critical path. 완화: shaper를 별도 트랙(M5)으로, 그 전까지 layout-preserve = rhwp SVG, 자체 엔진은 semantic-reflow만.
2. **`hwp-render`는 미작성**(`ops: Vec::new()`)이고 모델 `PaintOp`(색/폰트/TextRun 없음)는 caret이 읽는 rhwp `PaintOp::TextRun`과 *다른 타입*. "additive, schema v1, screen==export" 주장은 거짓 — enum 재설계 + schema bump가 새 작업. screen==export는 현재 양방향 모두 false(화면=rhwp SVG, PageLayerTree=빈 것).
3. **다섯 후보 차원이 정전을 두고 모순**(셋: JSX/CSS-canonical, 둘: SemanticDoc-canonical). 본 설계가 **SemanticDoc-canonical, JSX/CSS-투영**으로 확정 해소. 이 결정이 round-trip-safety(`Provenance`/`Passthrough`) 보존 + op-bus 무변경의 근거.
4. **JSX/CSS는 WP 핵심 기능에서 누출**: pagination(CSS 페이지 모델 없음), 각주/필드(계산 콘텐츠), 배분/장평/자간/per-script 폰트(CSS 동치 없음 → data-*). 즉 "깨끗한 web-native HTML"은 *이미 web-shaped인 문서*에만 성립. 한국 정부 RFP(`corpus/hwp/k-water-rfp.hwp`)는 data-*/--x 범벅 → 우리 엔진 외 소비자는 못 렌더. 완화: semantic-reflow를 web 출력의 주 모드로, Korean-specific는 우리 엔진 전용으로 명시.
5. **인라인 cascade**: 줄당 N개 다른-폰트 span은 "루프 앞 뺄셈"이 아니라 실제 inline-formatting-context 작업(현 `plain_font()` 단일 폰트 가정).
6. **편집→op→Rust→paint→canvas 왕복**(키스트로크/IME마다 Wasm/IPC 횡단). 현재 증분 레이아웃 없음(`NaiveLayout.layout`이 전체 문서). dirty-paragraph 증분 재레이아웃은 미작성·필수.
7. **테스트 커버리지 손실**: HWPX-out 폐기로 유일한 export 인수 테스트(open-safety 게이트)가 사라짐. corpus는 17파일(5 hwpx + 12 hwp)로 작음. HTML/PDF 골든-렌더/diff 하니스를 M3에 신규 구축(예산 반영).
8. **un-modeled 객체(textbox/도형/OLE/차트)**: `<Raw>`는 layout에서 inert → 공간 0 차지(task #21 pagination 드리프트). `shape-001.hwp`/`한셀OLE.hwp`/`draw-group.hwp`가 양 모드서 잘못 paginate. 피벗이 상속+악화(HTML/PDF는 Hancom이 객체 둔 자리에 뭔가 놓아야).
9. **CSS dedup 정확성**: superset 재사용 금지(v1)로 조용한 오염 회피, 단 정규화(단위/색/shorthand)는 long-tail. property-test(shape→css→shape == shape) 필요.
10. **헤드리스 폰트 가용성**: PDF/HTML/골든이 실 폰트(맑은 고딕 등) 필요. CI/서버엔 없음 → 번들 OFL 폰트로 고정(메트릭이 Hancom 설치 데스크톱과 다름 → "재현 가능 export"가 어려움).
11. **SolidJS→React + 렌더 backend 교체(rhwp-SVG→자체 paint) 동시 진행**: 두 큰 변경. 순서 잘못되면 뷰 회귀(현 뷰 ~90% rhwp). 완화: React 이관(M4)은 기존 커맨드 표면 위로 먼저, layout-preserve는 rhwp SVG 유지.

### 10.2 비목표 (Non-goals, v1)

- **바이너리 HWPX 출력**(D1로 폐기).
- **custom react-reconciler**(Rust-owns-tree와 충돌; 채택 안 함, 아마 영구히).
- **JSX subset의 JS 표현력**(.map/조건/함수/props.children) — 순수 선언적 데이터로 동결.
- **layout-preserve의 자체 엔진 글자-정확** — shaper(M5) 전까지 rhwp SVG.
- **CSS superset dedup 재사용** — 정확 일치만.
- **margin-collapsing, flex/grid, @media, calc(), pseudo-element** — CSS subset 밖.
- **un-modeled 객체의 충실 layout**(round-trip 보존은 하되 paint는 폴백/inert).
- **docx 완전 충실** — "to some degree", 명시적 경고.
- **수식/OLE의 AI 편집** — `<Raw>`/`<Equation script>` opaque(보존·inert, rhwp 폴백 paint).

---

## 11. 부록 — 그라운드 트루스 검증 (코드 인용)

본 설계의 load-bearing 주장은 추측이 아니라 코드로 확인했다:

- `hwp-render/src/lib.rs:22` — `NullRenderer` → `ops: Vec::new()` (paint IR 비어있음).
- `hwp-model/src/layout.rs:61-64` — `PaintOp::Glyph{x,y,ch,size}` / `Rect{x,y,w,h}` / `Image` (색·폰트·TextRun·stroke 없음, per-char). `PAINT_SCHEMA_VERSION = 1` (`:37`).
- `hwp-rhwp/src/lib.rs:365` — `PaintOp::TextRun { bbox, run }` (caret이 읽는 *다른* enum). `:181` 주석 "1 GlyphBox == 1 PaintOp::TextRun".
- `hwp-rhwp/src/lib.rs:1093-1099` — `oracle = rp.line_segs.len()`, `ours = layout_paragraph(...).len()`, `if ours == oracle { line_exact += 1 }` (줄-**개수** 충실도).
- `hwp-rhwp/src/lib.rs:402,469,489` — `hit_test_page`/`caret_in_run`/`caret_rect_in_page` (`&[GlyphBox]` 순수함수); `:247,273,296` — `parse_stable_key`/`resolve_key_to_node`/`node_to_section_para_ord`; `:267` footnote-flatten 드리프트 주석(key 미묘함).
- `hwp-ops/src/lib.rs:198,207` — `intern_char_shape`/`intern_para_shape` (find-or-push dedup = CssEnsureClass 모델).
- `hwp-model/src/types.rs:28,35,45,59,67` — `NodeId`/`Provenance`/`Passthrough`/`RawPart`/`Dirty` (round-trip-safety 기계); `document.rs:144,202` — `Paragraph.id: Option<NodeId>`, `Inline::Raw(RawPart)`.
- `corpus/` — hwpx 5개(00_smoke_min, footnote-01, form-01, FormattingShowcase, Skeleton) + hwp 12개 = 17파일(작은 corpus → 골든 하니스 리스크).
- `crates/` 확인 — hwp-render·hwp-typeset·hwp-rhwp·hwp-ops·hwp-ai·hwp-mcp·hwp-core·hwp-hwpx·hwp-viewer·tf-hwp-cli 존재(설계가 가정한 레거시 맵 일치).
