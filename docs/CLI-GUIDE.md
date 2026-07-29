# auto-hwp CLI 가이드 (터미널에서 한글 문서 다루기)

`auto-hwp`는 엔진을 그대로 터미널에 노출한 단일 바이너리다. 서버도, 한컴 오피스도, 인터넷도 필요 없다 —
문서는 실행한 컴퓨터를 떠나지 않는다.

> 이 문서가 **명령 팔레트의 정본**이다. `skills/hwp/SKILL.md`(Claude Code 스킬)와 README는 여기를 가리킨다.
> 명령 목록의 근거는 `crates/auto-hwp-cli/src/main.rs`이며, 아래 표는 그 파일에서 그대로 옮긴 것이다.

## 설치

```bash
cargo install --git https://github.com/kwakseongjae/auto-hwp auto-hwp-cli --features rhwp,shaper,pdf
```

서브모듈 문제로 위가 실패하면 클론 후 설치한다:

```bash
git clone --recurse-submodules https://github.com/kwakseongjae/auto-hwp
cargo install --path auto-hwp/crates/auto-hwp-cli --features rhwp,shaper,pdf
```

빌드에 수 분이 걸린다. 설치 확인은 `which auto-hwp`.
레포에서 바로 돌려보고 싶다면 `cargo run -p auto-hwp-cli --features rhwp,shaper,pdf -- <서브커맨드>`도 된다.

### 기능 플래그 — 무엇이 켜지나

| 플래그 | 없으면 못 하는 것 |
|---|---|
| `rhwp` | **바이너리 `.hwp`(HWP5) 열기** 전부. `render`·`view`·`verify-convert`·`layout-check`도 이 플래그가 켠다 |
| `shaper` | 실제 글꼴 폭(rustybuzz)에 기반한 줄바꿈. 없으면 근사 메트릭으로 조판한다 |
| `pdf` | `export-pdf`. 없으면 정직한 에러 + `export-html` → 브라우저 인쇄 우회 안내가 나온다 |
| `ai` | `ai-fill`/`ai-edit`의 실제 LLM 제공자(Anthropic·OpenRouter·로컬 Ollama)와 `ai-key` 키체인 |
| `docx` / `pdfin` | `.docx` 열기 / `.pdf` 열기(보기 위주) |

`.hwpx`만 다룰 거라면 플래그 없이도 열기·편집·HTML 내보내기·양식 일괄 채움까지 전부 동작한다.

## 자주 쓰는 것부터

| 하고 싶은 것 | 명령 |
|---|---|
| 포맷·구조 확인 | `auto-hwp detect 문서.hwp` · `auto-hwp info 문서.hwpx` |
| 텍스트 추출 | `auto-hwp extract-text 문서.hwp` |
| **PDF로 변환** (레이아웃 보존) | `auto-hwp export-pdf 문서.hwp -o 문서.pdf` |
| HTML로 변환 (시맨틱 리플로) | `auto-hwp export-html 문서.hwp -o 문서.html` |
| 페이지 그림(SVG) 뽑기 | `auto-hwp own-render 문서.hwp --page 0 --out p.svg` (`--page` 생략 = 전 페이지) |
| `.hwp` → 편집 가능한 `.hwpx` | `auto-hwp convert 문서.hwp` |
| AI가 읽을 구조 컨텍스트 | `auto-hwp ai-context 문서.hwp` (표는 격자로, 블록마다 `[s/b]` 주소) |
| **양식 일괄 작성** | `auto-hwp inspect 양식.hwpx --out map.json` → 검수 → `auto-hwp fill 양식.hwpx --map map.json --data 명단.csv --out 결과/` |

여러 파일은 셸 루프로 돌린다:

```bash
for f in *.hwp; do auto-hwp export-pdf "$f" -o "${f%.hwp}.pdf"; done
```

## 전체 명령

### 열기 · 살펴보기

| 명령 | 하는 일 | 주요 인자 |
|---|---|---|
| `detect <파일>` | 매직 바이트로 포맷 판정 | — |
| `info <파일>` | 포맷·크기 요약. HWPX면 mimetype과 파트 목록까지 | — |
| `extract-text <파일>` | 평문 추출(문단 하나에 한 줄) | — |
| `ai-context <파일>` | AI가 읽는 창 — 구조 보존 Markdown(표=격자, `[s/b]` 주소) + 콘텐츠 템플릿 | — |

### 그리기 · 내보내기

| 명령 | 하는 일 | 주요 인자 |
|---|---|---|
| `own-render <파일>` | **우리 엔진**으로 조판해 페이지 SVG 생성(페이지당 파일 1개) | `--page <N>`(생략=전체) · `--out <경로>`(기본 `page.svg`) |
| `export-html <파일>` | 자체 완결 HTML 1개 — 브라우저가 다시 흘려 배치(픽셀 동일 아님) | `-o/--out <경로>`(기본 `out.html`) |
| `export-pdf <파일>` | 우리 조판 그대로 PDF — 한글 폰트 임베드·서브셋 | `-o/--out <경로>`(기본 `out.pdf`) · `--features pdf` 필요 |
| `render <파일>` | rhwp 부트스트랩 렌더(대조용) | `--page <N>` · `--out <경로>` · `--features rhwp` 필요 |
| `view <파일>` | 전 페이지를 한 장의 미리보기 HTML로 | `--out <경로>`(기본 `view.html`) · `--features rhwp` 필요 |

### 변환 · 편집

| 명령 | 하는 일 | 주요 인자 |
|---|---|---|
| `convert <파일>` | `.hwp` → 편집 가능한 `.hwpx`. HWPX 입력은 정규화(재직렬화) | `--out <경로>`(기본: 입력 경로의 확장자만 교체) · `--verify` |
| `edit <파일>` | HWPX에 문단을 덧붙여 저장(왕복 안전) | `--append <문장>`(반복 가능) · `--out`(기본 `out.hwpx`) · `--verify` |
| `inspect <양식>` | 라벨 → 값칸 **fill-map 초안** 유도(`autohwp.fillmap.v1`) | `--out <경로>`(생략 시 표준출력) |
| `fill <양식>` | 확정 fill-map + 명단 → 인원별 HWPX + `output.zip` + `report.json` | `--map` · `--data` · `--out`(기본 `fill-out`) · `--pattern` · `--strict` |

`--verify`가 붙은 명령은 산출물을 오라클(LibreOffice + H2Orestart)로 다시 열어 "정말 열리는가"를 확인한다.
soffice가 없으면 조용히 건너뛴다.

`inspect`/`fill`은 [양식 일괄 작성 가이드](./BULK-GUIDE.md)에서 자세히 다룬다.

### AI로 고치기

| 명령 | 하는 일 | 주요 인자 |
|---|---|---|
| `ai-edit <파일>` | 자연어 지시 → 지정한 위치 기준 편집 제안 → 적용 → 저장 | `--instruction <지시>` · `--provider auto\|mock\|anthropic\|openrouter\|local` · `--out`(`.html`이면 HTML, 아니면 HWPX) · `--dry-run` |
| `ai-fill <파일>` | 자연어 지시 → 문단 작성 제안 → 적용 → HWPX (HWPX 입력 전용) | `--instruction` · `--provider` · `--out` · `--verify` · `--dry-run` |
| `ai-apply <파일>` | 에이전트가 쓴 콘텐츠 JSON을 적용(키 불필요 — `ai-context`의 짝) | `--content <JSON 경로>` · `--out` · `--verify` |
| `ai-key <set\|clear\|status>` | Anthropic 키를 OS 키체인에 저장·삭제·확인(`set`은 stdin으로 읽는다) | `--features ai` 필요 |

**`--dry-run`을 먼저 써라.** 제안 근거와 op별 변경 미리보기만 출력하고 파일은 건드리지 않는다.
`--provider mock`은 키 없이 도는 결정론 제공자라 파이프라인 점검용으로 좋다.
키를 안 넣으면 `auto`가 알아서 mock으로 떨어진다 — 조용히 실패하지 않는다.

### 엔진 개발용 (기여자)

| 명령 | 하는 일 |
|---|---|
| `layout-check <파일>` | production parser+우리 조판 vs 한컴 stored lineseg 대조(쪽수·본문/셀 문단 줄수). `--rows <섹션>/<블록>`은 표 행 높이, `--cells <섹션>/<블록>\|all`은 셀 불일치 폭·padding을 감사. 한컴 저작 HWPX도 production parser를 타며, lineseg cache가 없으면 missing-oracle로 명시. `--features rhwp` 필요 |
| `fidelity [파일]` | 충실도 게이트 전제조건 점검 + 가능하면 기준 렌더와 비교 |
| `oracle <파일>` | LibreOffice + H2Orestart로 기준 PDF 생성 (`--out <디렉토리>`) |
| `verify-convert <파일>` | 원본 `.hwp`와 변환 `.hwpx`를 나란히 렌더한 HTML로 육안 대조. `--features rhwp` 필요 |
| `open-project <파일> --out-dir <디렉토리>` | HWPX를 JSX(내용) + CSS(디자인) 프로젝트로 투영(선택 코덱) |
| `edit-op <프로젝트>` | 그 프로젝트에 CSS 선언 하나만 적용해 내용/디자인 분리를 실증. `--node`/`--class` · `--prop` · `--value` |

## 정직 고지 (엔진 공통)

- 암호(password) 걸린 `.hwp`는 **열지 못한다** — 정직하게 거부한다. 배포용(DRM) 문서는 복호해서 연다.
- **PDF의 수식·차트는 자리표시 상자**로 나간다(화면·HTML은 실제로 그린다). 해당 요소가 있으면 미리 알려라.
- 저장 포맷은 **HWPX**다. `.hwp`로 다시 저장하는 경로는 없다. `.hwp`를 입력하면 산출물은 변환본이라
  쪽 나눔·표 너비가 원본과 달라질 수 있다(HWPX 입력은 고치지 않은 영역이 바이트 그대로 보존된다).
- 함초롬 등 상용 서체는 번들하지 않으며 OFL 대체(나눔 계열)로 렌더된다.
- 쪽수 게이트(8==8 · 18==18 · 24==24)와 셀 lineseg 게이트는 벤치마크 기준이다 — 임의 문서의 완전
  일치 보증이 아니다.

## 다른 표면

- AI 도구에 상시 장착: 로컬 MCP 서버 → [MCP 가이드](./MCP-GUIDE.md)
- Claude Code 세션에서 바로: [스킬 정의](../skills/hwp/SKILL.md) (이 CLI를 감싼다)
- 웹앱에 임베드: `@auto-hwp/engine` / `@auto-hwp/react` → [임베드 가이드](./EMBED-GUIDE.md)
- 양식 N부 일괄 작성: [양식 일괄 작성 가이드](./BULK-GUIDE.md)
