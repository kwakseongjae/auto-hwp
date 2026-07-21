# tf-hwp

**브라우저에서 동작하는 자체 HWP/HWPX 엔진** — `.hwp`/`.hwpx`를 열어 원본 그대로 렌더하고,
편집하고, HTML/PDF/HWPX로 내보냅니다. 서버 없이 100% 클라이언트(WebAssembly)에서.

[English](./README.en.md) · [라이브 데모](https://kwakseongjae.github.io/tf-hwp/) ·
[임베드 가이드](./docs/EMBED-GUIDE.md) · [기여 가이드](./CONTRIBUTING.md)

```
.hwp / .hwpx ──▶ SemanticDoc(IR) ──▶ 조판(hwp-typeset) ──▶ SVG 페이지 (화면·hit-test)
                     │                                  ├▶ PDF (레이아웃 보존, krilla)
                     │                                  └▶ HTML (시맨틱 reflow)
                     └── Intent JSON ──▶ Op ──▶ IR 변이 (편집·undo/redo) ──▶ HWPX 저장
```

## 왜 만들었나

한국 공공·기업 문서의 표준인 HWP는 웹에서 다루기 어렵습니다. tf-hwp는 뷰어 렌더링을
외부 프로그램에 위임하지 않고 **파싱 → 조판 → 렌더 → 편집 → 저장 전체를 소유하는 엔진**입니다:

- **원본 정확도를 게이트로 잠급니다** — 실물 정부 양식 벤치마크에서 한컴 렌더와
  페이지 수 완전 일치(8==8, 18==18), 줄바꿈 위치 98.9%+ 일치를 CI 불변식으로 유지합니다.
- **round-trip 안전** — 편집하지 않은 콘텐츠는 바이트 그대로 재직렬화됩니다.
  문서를 열었다 저장해도 원본이 망가지지 않습니다.
- **headless-first** — 엔진은 UI가 없습니다. SVG 문자열/HTML/PDF 바이트를 돌려줄 뿐,
  어떻게 그릴지는 호스트가 정합니다. 자체 에디터를 만들 수 있습니다.

## 패키지 (npm)

| 패키지 | 레이어 | 역할 |
|---|---|---|
| **`@tf-hwp/engine`** | L1 | **headless 엔진 (wasm)** — 파싱·조판·SVG/HTML/PDF/HWPX·Intent 편집·undo. UI 없음 |
| `@tf-hwp/editor-core` | L2 | headless 에디터 상태 (선택·편집·세션) — DOM 최소, React 무관 |
| `@tf-hwp/ai-protocol` | L2′ | 바이브 편집 LLM 프로토콜 (프롬프트/컨텍스트/검증) — fetch 없음, 키 없음 |
| `@tf-hwp/react` | L3 | **선택** 레이어: 레퍼런스 에디터 `<HwpWorkspace/>` + React 바인딩 |

> 아직 npm 레지스트리에 발행 전입니다. 지금은 `examples/vite-embed`의 레시피대로
> `npm pack` tarball로 소비할 수 있습니다 (4패키지 모두 발행 준비 완료 상태).

## 빠른 시작 ① — headless 엔진만 (자체 UI)

React도, 우리 에디터도 필요 없습니다. 엔진은 SVG 문자열과 바이트를 돌려줍니다:

```js
import { initEngine, HwpDoc } from '@tf-hwp/engine';

await initEngine();                          // wasm 1회 인스턴스화
const bytes = new Uint8Array(await file.arrayBuffer());
const doc = HwpDoc.open(bytes, file.name);   // .hwp / .hwpx 자동 감지

// 렌더 — 페이지별 SVG 문자열. 어디에 어떻게 그릴지는 당신의 자유.
for (let p = 0; p < doc.pageCount(); p++) {
  container.insertAdjacentHTML('beforeend', doc.renderPageSvgSanitized(p));
}

// 편집 — Intent JSON (스키마 v0, docs/INTENT-SCHEMA.md)
doc.applyIntent({ intent: 'SetTableCell', section: 0, index: 1, row: 0, col: 0, text: '값' });
doc.undo();

// 내보내기
const html = doc.exportHtml();               // 시맨틱 reflow HTML
const pdf  = doc.exportPdf();                // 레이아웃 보존 PDF (Uint8Array)
const hwpx = doc.toHwpx();                   // round-trip 안전 HWPX (Uint8Array)

doc.free();
```

지오메트리 질의(`hitTest`/`tableAt`/`blocksInRect`…)까지 27개 메서드가
[`EngineAdapter` 계약](./packages/editor-core/src/adapter.ts)으로 문서화되어 있어,
클릭 선택·드래그·캐럿이 있는 **완전한 자체 에디터**를 엔진 위에 지을 수 있습니다.
중간층이 필요하면 `@tf-hwp/editor-core`(선택 모델·편집 컨트롤러, React 무관)를 쓰세요.

## 빠른 시작 ② — 레퍼런스 에디터 (React)

```tsx
import { HwpWorkspace, WasmAdapter } from '@tf-hwp/react';
import '@tf-hwp/react/styles.css';

<HwpWorkspace
  adapter={adapter}                 // WasmAdapter (웹) 또는 자체 어댑터
  document={{ bytes, name }}
  enableEditing
  onAiRequest={myLlmBridge}         // 선택: 바이브 편집 — LLM은 당신 서버에서 (BYOK)
/>
```

wasm/워커 정적 서빙, CSP, 폰트, AI 프록시까지 전체 임베드 레시피는
[`docs/EMBED-GUIDE.md`](./docs/EMBED-GUIDE.md) · 동작 예제는 [`examples/vite-embed`](./examples/vite-embed) ·
AI 프록시 예제는 [`examples/ai-proxy-express`](./examples/ai-proxy-express).

## 데모 실행 (로컬)

```bash
git clone --recurse-submodules https://github.com/kwakseongjae/tf-hwp
cd tf-hwp

# 엔진 wasm 빌드 (Rust + wasm-bindgen 필요 — CONTRIBUTING.md 참고)
cargo build -p hwp-wasm --release --target wasm32-unknown-unknown
wasm-bindgen --target web --out-dir packages/engine/pkg target/wasm32-unknown-unknown/release/hwp_wasm.wasm

# 데모 앱
cd apps/hwp-lab && npm install && npm run dev   # http://localhost:3000
```

바이브 편집(AI)을 쓰려면 `apps/hwp-lab/.env.local`에 `OPENROUTER_API_KEY`를 넣으세요
(키는 서버 라우트에만 존재 — 클라이언트 번들에 절대 실리지 않습니다).

## 바이브 편집 (AI)

문서의 셀/문단/표를 클릭해 앵커로 지정하고 "이 표 채워줘"라고 말하면, LLM이
**Intent JSON**(화이트리스트 스키마)을 돌려주고 엔진이 검증 후 적용합니다.

- LLM 호출은 항상 **호스트 서버**에서 (BYOK — 이 레포의 어떤 패키지도 API 키를 보지 않음)
- 모델 출력은 스키마 검증 + unknown field 거부 후에만 문서에 닿음
- 에이전틱 모드: 웹 검색 → 근거 인용 → 편집 제안 스트리밍

## 설계 노트 — 무엇이 정본인가

초기 기획은 "HWP → XML(구조) + CSS(디자인) → LLM이 어느 쪽을 고칠지 선택"이었습니다.
구현하며 **포맷 중립 IR(SemanticDoc) + 타입드 Intent 편집**으로 피벗했습니다
([`docs/PIVOT-DESIGN.md`](./docs/PIVOT-DESIGN.md)):

- 렌더 정본은 **SemanticDoc → 조판 → SVG** (HWP 원본과 픽셀 수준 대조 가능)
- 편집 정본은 **Intent JSON → Op → IR 변이** (LLM 출력을 스키마로 잠금 — 자유 XML/CSS 패치보다
  검증 가능하고 undo가 정확함)
- XML+CSS 상은 [`hwp-jsx`](./crates/hwp-jsx) **선택 코덱**(JSX/CSS 투영·round-trip 검증됨)으로
  남아 있으며, HTML export가 그 계보입니다

즉 "LLM이 구조/디자인 중 어디를 고칠지 감지한다"는 목표는 유지하되, 그 매체가
XML/CSS 텍스트가 아니라 **타입드 Intent**입니다.

## 정확도

| 벤치마크 | 한컴 렌더 | tf-hwp | 판정 |
|---|---|---|---|
| benchmark.hwp (정부 양식, 8쪽) | 8쪽 | 8쪽 | ✅ 일치 |
| benchmark1.hwp (신청서, 18쪽) | 18쪽 | 18쪽 | ✅ 일치 |
| 줄바꿈 위치 일치율 | — | 98.9%+ | 게이트 |

`scripts/verify-local.sh`가 이 게이트를 매 커밋 강제합니다. 손실 변환된 `.hwpx`
(한컴 "다른 이름으로 저장"이 줄간격·행높이를 뭉갠 파일)는 열화를 자동 감지해
원본 근사로 복원하는 **레이아웃 정리** 모드를 제공합니다.

**알려진 제약 (정직 고지)**
- **PDF의 수식·차트**: 화면·HTML에서는 실제로 그려지지만, PDF 백엔드는 아직
  벡터로 내보내지 못해 **자리표시 상자**로 출력됩니다(내보내기 시 앱이 미리
  경고합니다). SVG→PDF 벡터화는 후속 로드맵입니다.
- **암호(password) 걸린 `.hwp`**: 지원하지 않으며 정직하게 거부합니다.
  (배포용(distribution) 문서의 복호는 지원 — `hwp-crypto`.)
- **`.hwp`(바이너리)로 재저장 불가**: 저장 포맷은 HWPX입니다. `.hwp`를 열어
  편집한 결과도 HWPX로 내려받습니다(무편집 HWPX 영역은 바이트 그대로 보존).

## Rust 크레이트 (엔진 내부)

`hwp-model`(IR) · `hwp-hwpx`(HWPX 코덱) · `hwp-rhwp`(.hwp 파싱 부트스트랩, [rhwp](https://github.com/kwakseongjae/rhwp) MIT) ·
`hwp-typeset`(조판: 금칙·장평·자간·옛한글) · `hwp-render`(PaintOp→SVG) · `hwp-export`(PDF/HTML) ·
`hwp-ops`(op-bus·undo) · `hwp-mcp`(Intent 스키마) · `hwp-session`(지오메트리) · `hwp-wasm`(바인딩) ·
`hwp-crypto`(배포용 문서 복호) · `tf-hwp-cli`(CLI)

CLI만으로도 쓸 수 있습니다:

```bash
cargo run -p tf-hwp-cli --features rhwp -- own-render 문서.hwp --out page.svg
cargo run -p tf-hwp-cli --features rhwp -- export-pdf 문서.hwpx -o out.pdf
```

## 라이선스

MIT OR Apache-2.0 ([LICENSE-MIT](./LICENSE-MIT) / [LICENSE-APACHE](./LICENSE-APACHE)).
서드파티 고지는 [NOTICE](./NOTICE) — rhwp(MIT)·나눔 폰트(OFL)·oracle의 GPL 격리 방식 포함.
