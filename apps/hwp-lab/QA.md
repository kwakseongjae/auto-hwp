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

데모 픽스처: 레포 루트의 `benchmark.hwp`(8쪽), `benchmark1.hwp`(19쪽).

---

## 시나리오

### ① 벤치마크 .hwp 업로드 → 8페이지 렌더 확인
- 단계: 상단 **파일 열기 (.hwp/.hwpx)** → `benchmark.hwp` 선택.
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

### ⑥ 폰트 주입 → PDF 다운로드 → 한글 육안
- 단계: 상단 **폰트 선택 (.ttf/.otf)** 로 한글 폰트(예: Noto Sans KR / 나눔고딕 .ttf)를 고른 뒤
  툴바 **PDF** 클릭. (또는 `public/fonts/NotoSansKR-Regular.ttf` 배치 시 자동 fetch.)
- 기대결과: `<문서명>.pdf` 다운로드. PDF 뷰어에서 **한글이 깨지지 않고** 표시된다. 폰트 미주입
  상태로 PDF를 누르면 상단에 폰트 주입 안내 에러 메시지가 뜨고 빈 PDF를 만들지 않는다.

### ⑦ (키 설정 시) 실 LLM 바이브편집
- 단계: `ANTHROPIC_API_KEY` 설정 후 기동. 배지 `실 LLM 모드` 확인. 표/문단을
  마킹하고 자연어 지시(예: "이 셀 값을 '2025년 매출'로 바꿔줘") 전송.
- 기대결과: 실제 모델이 반환한 편집 Intent가 프리뷰로 뜬다. 서버는 허용 Intent
  (SetTableCell/SetTableCellRuns/SetCellRangeFmt/SetCellRangeShade/SetParagraphText)만
  통과시키고 그 밖은 드롭한다(서버 로그에 `dropped non-whitelisted intent`). 적용/undo 동작은
  ③④와 동일. `<document-content>` 안의 지시문은 무시된다(R5).

### ⑧ 대형 문서(benchmark1, 19p) 렌더 성능 체감
- 단계: `benchmark1.hwp` 업로드.
- 기대결과: 19쪽이 모두 렌더된다(초기 렌더에 수 초 걸릴 수 있음). 스크롤/줌(±)이 멈춤 없이
  동작. 표 마킹/편집도 ②③과 동일하게 동작.

### ⑨ 악성/손상 파일 업로드 → 에러 메시지(트랩 복구 안내)
- 단계: `.hwp`가 아닌 파일(예: 임의 .txt를 .hwp로 리네임하거나 잘린 바이트)을 업로드.
  - 확장자 불일치(.png 등): 즉시 "지원하지 않는 형식입니다" 에러.
  - 손상된 .hwp/.hwpx: "파일을 열 수 없습니다 … 손상되었거나 지원하지 않는 파일…" 에러.
- 기대결과: **화면 상단에 빨간 에러 박스**가 표시된다(콘솔 전용 아님). 기존에 열려 있던 문서/앱은
  죽지 않는다. 이후 정상 파일(benchmark.hwp)을 다시 업로드하면 정상 렌더된다(엔진 트랩 시
  인스턴스 자동 재생성 → 복구).

---

## 상태/모드 표시(요약)
- 우상단 배지: `모드 확인 중…` → `mock 모드`(황색) / `실 LLM 모드`(녹색).
- 좌하단/상단 상태줄: `문서 여는 중…`(파랑), 채팅 패널의 적용/취소/오류 카드.
- 에러: 상단 빨간 박스(파일 열기/폰트/네트워크 실패).

## 자동화(Playwright 스모크)
`apps/hwp-lab/e2e/smoke.spec.ts` — 페이지 로드 → benchmark.hwp 업로드 → SVG 8페이지 assert →
mock 편집 적용 → undo. 실행:

```bash
cd apps/hwp-lab
npx playwright install chromium   # 최초 1회 (네트워크 필요)
npm run build && npm run test:e2e
```

chromium 설치가 불가한 환경이면 위 ①③④를 수동으로 대체 수행하라.
