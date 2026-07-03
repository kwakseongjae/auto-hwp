# scripts/figma-grade — issue 033 측정 하네스 (docs-only)

`docs/FIGMA-GRADE-UX.md` 의 모든 수치를 재현하는 tracked 측정 스크립트. **코드 무수정** — 엔진/앱을
있는 그대로 계측만 한다.

## 재현

엔진 pkg 선빌드(레포 루트):
```bash
cargo build -p hwp-wasm --release --target wasm32-unknown-unknown
wasm-bindgen --target web --out-dir packages/engine/pkg target/wasm32-unknown-unknown/release/hwp_wasm.wasm
```

### 1. 엔진/노드 측정 (open·재조판·SVG-DOM 노드 수·전-페이지 재렌더·hitTest)
```bash
node scripts/figma-grade/measure-engine.mjs
```
앱 빌드체인 불필요 — `packages/engine/pkg/hwp_wasm_bg.wasm` 를 직접 로드. benchmark/benchmark1/
benchmark2 3종 모두 측정.

### 2. 브라우저 측정 (실 DOM 노드·스크롤 프레임·줌 리플로우·편집 재주입 DOM세)
빌드체인 + dev 서버 필요:
```bash
( cd packages/editor-core && npm i && npm run build )
( cd packages/ai-protocol && npm i && npm run build )
( cd packages/react && npm i && npm run build )
( cd apps/hwp-lab && npm i && npx playwright install chromium )
( cd apps/hwp-lab && rm -rf .next && npm run dev -- -p 3577 )   # 한 셸에서 상주
node scripts/figma-grade/measure-browser.mjs                     # 다른 셸에서 (LAB_URL 로 포트 변경)
```
benchmark2.hwp(25쪽)를 업로드하고 계측. `LAB_DOC` 로 다른 문서 지정 가능.

### 3. 네이티브 노드 히스토그램 (교차검증, wasm 불요)
```bash
scripts/figma-grade/nodes.sh
```
`own-render` (wasm 와 동일 엔진 경로)로 SVG 를 뽑아 페이지별 노드 수/요소 히스토그램을 센다.
