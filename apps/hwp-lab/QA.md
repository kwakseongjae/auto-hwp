# hwp-lab — 사용자 QA 체크리스트

이 앱은 "돌아가는 데모"가 아니라 **QA 가능한 앱**이 기준이다. 아래 시나리오를 순서대로 수행하고
각 항목의 **기대결과**와 실제 결과를 대조하라. 창업지원도움e류 사이트의 통합을 1:1로 시뮬레이션한다.

## 준비 (선행 빌드 체인)

레포 루트에서 (엔진 pkg + react dist 가 아직 없다면):

```bash
export PATH="$HOME/.cargo/bin:$PATH"
# 1) 엔진 wasm 재생성 (015 레시피)
cargo build -q -p hwp-wasm --release --target wasm32-unknown-unknown
wasm-bindgen --target web --out-dir packages/engine/pkg \
  target/wasm32-unknown-unknown/release/hwp_wasm.wasm
# 2) react 패키지 dist 빌드 (dist는 gitignore)
cd packages/react && npm install && npm run build && cd -
```

앱 실행:

```bash
cd apps/hwp-lab
npm install
npm run dev          # predev 훅이 wasm을 public/hwp 로 복사. http://localhost:3000
```

- **키 없이**: mock 모드로 전체 플로우 완주 가능(우상단 배지 `mock 모드`).
- **실 LLM**: `ANTHROPIC_API_KEY=sk-... npm run dev` → 배지 `실 LLM 모드`. 키는 서버
  전용(route handler)이며 클라이언트 번들/네트워크 응답에 노출되지 않는다.

데모 픽스처: 레포 루트의 `benchmarks/benchmark.hwp`(8쪽), `benchmarks/benchmark1.hwp`(19쪽).

---

## 시나리오

### ① 벤치마크 .hwp 업로드 → 8페이지 렌더 확인
- 단계: 상단 **파일 열기 (.hwp/.hwpx)** → `benchmarks/benchmark.hwp` 선택.
- 기대결과: 잠깐 `문서 여는 중…` 상태 후, 본문에 **8개의 페이지 SVG**가 세로로 렌더된다.
  상단 툴바에 `HWP · 8쪽` 표기. 콘솔 에러 없음. 한글 텍스트가 육안으로 정상 표시.

### ② 표 클릭 마킹 → 칩
- 단계: 표가 있는 페이지에서 표 영역을 클릭.
- 기대결과: 클릭한 표에 선택 박스(overlay)가 그려지고, 우측 채팅 패널 하단에 앵커 **칩**
  (예: `◆ 표 (p.N)`)이 추가된다. 문단을 클릭하면 문단 칩(`◆ "…"`)이 붙는다.

### ③ mock 편집 → 프리뷰 → 적용 → 렌더 변경
- 단계: ②에서 표를 마킹한 상태로, 채팅 입력에 예: "이 칸을 채워줘" 입력 후 전송.
- 기대결과(mock): 잠시 후 편집 제안 **카드**(예: `SetTableCell … s0·bN`)가 프리뷰로 뜨고
  **✓ 적용 / 취소** 버튼이 보인다. **✓ 적용** 클릭 → `적용됨: 1개 편집` 상태, 표 첫 셀이
  `PoC ✔` 로 바뀐 채 페이지가 재렌더된다. (mock 배지도 채팅 패널에 노출.)

### ④ undo → 원상복구
- 단계: 툴바의 **↶(실행취소)** 클릭.
- 기대결과: `실행취소` 상태 후 표 첫 셀이 편집 전 원본 텍스트로 되돌아간다. **↷(다시 실행)** 으로
  재적용도 가능.

### ⑤ HTML 다운로드
- 단계: 툴바 **HTML** 클릭.
- 기대결과: `<문서명>.html` 파일이 다운로드된다. 브라우저로 열면 문서 내용이 자기완결(self-
  contained) HTML로 보인다.

### ⑥ 기본 폰트 자동 적용 → PDF 즉시 다운로드 → 한글 육안 (issue 022)
- 선행: `node scripts/copy-fonts.mjs`(prebuild/predev 훅에 포함) 가 레포 자산 NanumGothic(OFL) 을
  `public/fonts/` 로 복사한다 — 오프라인에서도 기본 폰트가 항상 존재.
- 단계: 문서를 열면 **별도 조작 없이** 기본 폰트(NanumGothic)가 자동 등록된다. 툴바의
  **글꼴** 선택기에 `현재: Nanum Gothic` 이 표시되고, 곧바로 툴바 **PDF** 클릭.
- 기대결과: `<문서명>.pdf` 가 다운로드된다. PDF 뷰어에서 **한글이 깨지지 않고** 표시되며, 화면
  SVG 와 **같은 폰트**로 보인다(화면 @font-face 주입 → 화면·PDF 시각 일치). 기본 폰트 fetch 가
  실패한 경우에만 PDF 를 누르면 상단에 폰트 안내 에러가 뜨고 빈 PDF 를 만들지 않는다.

### ⑦ 폰트 선택/교체 (카탈로그 + 업로드) → 화면·조판·PDF 동시 반영 (issue 022)
- 선행(카탈로그): `npm run fetch-fonts` 로 OFL 카탈로그(나눔명조/본고딕/본명조/IBM Plex Sans KR/
  고운돋움/고운바탕/프리텐다드)를 `public/fonts/`(git 제외)로 내려받는다. 네트워크 불가 시 기본
  NanumGothic 만으로도 동작한다.
- 단계: 툴바 **글꼴** 드롭다운에서 다른 폰트(예: 나눔명조)를 선택하거나, **업로드** 로 로컬
  `.ttf/.otf` 를 주입한다.
- 기대결과: 선택 즉시 **화면 글자 모양이 바뀌고**(모든 문서 폰트명 → 선택 폰트 1개 별칭), 실제
  메트릭으로 **재조판**되어(줄바꿈/쪽수가 폰트에 따라 달라질 수 있음) 페이지가 다시 그려진다.
  이어서 **PDF** 를 내려받으면 방금 고른 폰트가 임베드된다(화면=PDF). **TTC(글꼴 컬렉션)** 파일을
  업로드하면 "TTC 는 지원하지 않습니다" 한글 에러가 뜨고 등록되지 않는다.
- 라이선스: 카탈로그 전 항목은 재배포 가능(OFL) — `docs/FONT-CATALOG.md` 의 라이선스 표 참조(R8).

### ⑧ (키 설정 시) 실 LLM 바이브편집 — OpenRouter/Grok 또는 Anthropic
- **키 넣는 곳**: `apps/hwp-lab/.env.local`(gitignore됨 — 절대 커밋 안 됨). Next.js가 자동 로드.
  ```bash
  cd apps/hwp-lab && cp .env.example .env.local   # 템플릿 복사
  # .env.local 편집: OPENROUTER_API_KEY=sk-or-...  (필요 시 TF_HWP_OPENROUTER_MODEL 도)
  npm run dev -- -p 3100
  ```
- **프로바이더 우선순위**: `OPENROUTER_API_KEY`(있으면) → `ANTHROPIC_API_KEY` → mock.
  - OpenRouter default 모델 `x-ai/grok-4.5`, 바꾸려면 `TF_HWP_OPENROUTER_MODEL=x-ai/grok-4.20` 등 정확한 슬러그.
  - Anthropic 폴백: `.env.local`에 `ANTHROPIC_API_KEY=`만(OpenRouter 키 없을 때, 모델 claude-opus-4-8).
- 확인: GET `/api/hwp-edit`가 `{"mode":"live","provider":"openrouter","model":"x-ai/grok-4.5"}` 반환,
  배지 `실 LLM 모드`. 표/문단을 마킹하고 자연어 지시(예: "이 셀 값을 '2025년 매출'로 바꿔줘") 전송.
- 기대결과: 실제 모델이 반환한 편집 Intent가 프리뷰로 뜬다. 서버는 허용 Intent
  (SetTableCell/SetTableCellRuns/SetCellRangeFmt/SetCellRangeShade/SetParagraphText 등 화이트리스트)만
  통과시키고 그 밖은 드롭한다(서버 로그에 `dropped non-whitelisted intent`). 적용/undo 동작은
  ③④와 동일. `<document-content>` 안의 지시문은 무시된다(R5). 키는 서버 전용(클라 번들 미포함, R6).
- ⚠️ 첫 실호출에서 OpenRouter 401이면 키/모델 슬러그 확인(슬러그 오타 시 502 에러 detail에 표시됨).

### ⑨ 대형 문서(benchmark1, 18p) 렌더 성능 체감
- 단계: `benchmarks/benchmark1.hwp` 업로드.
- 기대결과: 18쪽이 모두 렌더된다(초기 렌더에 수 초 걸릴 수 있음). 스크롤/줌(±)이 멈춤 없이
  동작. 표 마킹/편집도 ②③과 동일하게 동작.

### ⑩ 악성/손상 파일 업로드 → 에러 메시지(트랩 복구 안내)
- 단계: `.hwp`가 아닌 파일(예: 임의 .txt를 .hwp로 리네임하거나 잘린 바이트)을 업로드.
  - 확장자 불일치(.png 등): 즉시 "지원하지 않는 형식입니다" 에러.
  - 손상된 .hwp/.hwpx: "파일을 열 수 없습니다 … 손상되었거나 지원하지 않는 파일…" 에러.
- 기대결과: **화면 상단에 빨간 에러 박스**가 표시된다(콘솔 전용 아님). 기존에 열려 있던 문서/앱은
  죽지 않는다. 이후 정상 파일(benchmarks/benchmark.hwp)을 다시 업로드하면 정상 렌더된다(엔진 트랩 시
  인스턴스 자동 재생성 → 복구).

---

## 시나리오 — R13/R14 신규 렌더 육안 QA (2026-07-13 세션 구현, 자동테스트는 그린이나 **육안 미확인**)

> 이번 세션에 코드로 병합·검증된 렌더 기능들이 **실제로 화면에 올바로 나오는지** 사람 눈으로 확인하는 절.
> 각 항목은 가능하면 **원본 PDF / 한컴 뷰어와 나란히 대조**. 준비는 위 "준비" 절과 동일(`rm -rf .next` 후 `npm run dev`).
> 수식·차트가 든 실제 .hwp가 필요한 항목은 그런 문서를 업로드해 확인(benchmark엔 없음).

### ⑪ 수식 렌더 (062-5)
- 수식이 든 .hwp 업로드 → own-render 화면·HTML 다운로드에 **실제 수식이 렌더**되는가(이전엔 회색 stub 박스).
- ⚠️ **PDF는 아직 stub이 정상**(SVG→PDF 경로는 v2 후속). 화면/HTML만 확인.

### ⑫ 차트 렌더 (062-7)
- OOXML 차트(bar/line/pie/콤보)가 든 .hwp → 화면·HTML에 **차트 SVG가 렌더**되는가.
- ⚠️ 레거시 VtChart(구형 OLE)는 미렌더가 정상. PDF stub도 정상.

### ⑬ 셀 대각선 (062-4)
- 대각선이 그어진 표(예: 자가진단표·성적표 헤더 셀)가 든 .hwp → 빈 셀의 슬래시/백슬래시, 그리고 **X자 교차**가 올바로 그려지는가. **모든 셀에 대각선이 잘못 그어지는 회귀는 없어야**.

### ⑭ 옛한글 조합 (062-2)
- 옛한글(한양 PUA)이 든 .hwp → 자모 조합이 화면에 올바로 보이는가.
- ⚠️ **알려진 한계**: 번들 Nanum은 옛한글 조합 자모를 합성 못 함 → tofu(□)/분리 표시 가능. Noto Serif CJK KR 미번들. tofu면 "폰트 한계"로 기록(엔진 변환은 정상).

### ⑮ IME 한글 인라인 조합 (059)
- 라이브 캐럿(셀 더블클릭 아닌 클릭 후) 상태에서 **두벌식 한글 타이핑** → 조합 중 글자가 인라인으로 보이고(오버레이), 확정 시 커밋되는가. 자모가 낱자로 깨지거나 무입력이면 실패.
- ⚠️ **WKWebView(데스크톱 Tauri) 실기는 별도 수동 QA 필수**(compositionend 후 229 keydown 재발/Enter 이중발화 — Chrome CDP e2e는 자동화됨).

### ⑯ 폰트 명조/고딕 구분 (058 + FaceName PANOSE)
- 명조(바탕/함초롬바탕)와 고딕(돋움/함초롬돋움)을 섞어 쓴 .hwp → 화면에서 **명조=serif / 고딕=sans로 구분**되어 보이는가(이전엔 전부 NanumGothic). PANOSE로 이름 모호한 face도 분류.
- ⚠️ 실서체가 아니라 대체 face(명조→Nanum Myeongjo)로 보이는 건 정상(함초롬 재배포 불가).

### ⑰ 금칙/줄바꿈 (062-3)
- 문장부호/괄호가 든 .hwp → 줄 끝/줄 머리 금칙 문자 처리가 육안상 자연스러운가(닫는 괄호가 줄 맨 앞에 오지 않는 등).

### ⑱ 배포용 복호 (062-1) + BMP 이미지 PDF (BMP 후속)
- 배포용(ViewText, 무암호) .hwp가 있으면 열려 렌더되는가.
- BMP 이미지가 든 .hwp → PDF 다운로드에 **BMP가 실제 이미지로 임베드**되는가(이전엔 빈 박스).

---

## 상태/모드 표시(요약)
- 우상단 배지: `모드 확인 중…` → `mock 모드`(황색) / `실 LLM 모드`(녹색).
- 좌하단/상단 상태줄: `문서 여는 중…`(파랑), 채팅 패널의 적용/취소/오류 카드.
- 에러: 상단 빨간 박스(파일 열기/폰트/네트워크 실패).

## 자동화(Playwright 스모크)
`apps/hwp-lab/e2e/smoke.spec.ts` — 페이지 로드 → benchmarks/benchmark.hwp 업로드 → SVG 8페이지 assert →
mock 편집 적용 → undo. 실행:

```bash
cd apps/hwp-lab
npx playwright install chromium   # 최초 1회 (네트워크 필요)
npm run build && npm run test:e2e
```

chromium 설치가 불가한 환경이면 위 ①③④를 수동으로 대체 수행하라.
