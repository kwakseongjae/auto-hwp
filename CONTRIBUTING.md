# Contributing to tf-hwp

기여 환영합니다. 이 프로젝트는 **정확도 게이트가 CI보다 우선**하는 코드베이스입니다 —
아래 불변식을 깨는 PR은 아무리 좋아 보여도 머지되지 않습니다.

## 개발 환경

```bash
# Rust (stable) + wasm 타깃 + Node 20+ / pnpm
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli
brew install binaryen   # wasm-opt (선택 — 번들 다이어트)

git clone --recurse-submodules https://github.com/kwakseongjae/tf-hwp
# external/rhwp 서브모듈이 필수입니다 (파싱 부트스트랩, MIT)
```

## 검증 — 푸시 전 필수

```bash
scripts/verify-local.sh          # quick: fmt·clippy·전체 테스트·게이트·wasm 위생·licenses
scripts/verify-local.sh --full   # + wasm 재빌드·JS 빌드/vitest·e2e — crates/packages 접촉 시 필수
```

CI(GitHub Actions)는 수동 트리거 전용입니다 — **로컬 verify가 정본**입니다.

## 불변식 (위반 = 작업 실패)

1. **게이트**: `layout-check` 기준 `benchmarks/benchmark.hwp` **8==8** 페이지,
   `benchmark1.hwp` **18==18** 페이지, 줄바꿈 일치율 98.9%+ 유지. 조판기(`hwp-typeset`)를
   건드리는 변경은 반드시 게이트 before==after를 증명해야 합니다.
2. **LOCKSTEP**: `place_doc`(crates/hwp-typeset/src/place.rs)과 `NaiveLayout`(lib.rs)의
   페이지 수는 항상 일치해야 합니다 — 한쪽만 고치지 마세요.
3. **rhwp는 파싱 전용**: `external/`은 vendored 수정 금지. 렌더는 항상 우리 IR(SemanticDoc)에서.
4. **단위 규율**: 지오메트리 커맨드 = px(=HWPUNIT/75), ops 커밋 = HWPUNIT.
   변환은 `packages/editor-core/src/units.ts` 단일 지점에서만.
5. **round-trip moat**: 편집하지 않은 HWPX 콘텐츠는 바이트 그대로 재직렬화되어야 합니다.
   렌더 전용 복원(테두리 복원·레이아웃 정리 등)은 render-IR만 만지고 저장 바이트에 닿지 않습니다.
6. **Intent 스키마 v0**: additive 확장만 + unknown field 명시적 거부.

## 함정 (자주 걸림)

- **crates(Rust) 변경 후 wasm pkg 재빌드 필수**:
  ```bash
  cargo build -p hwp-wasm --release --target wasm32-unknown-unknown
  wasm-bindgen --target web --out-dir packages/engine/pkg target/wasm32-unknown-unknown/release/hwp_wasm.wasm
  node apps/hwp-lab/scripts/copy-wasm.mjs && rm -rf apps/hwp-lab/.next
  ```
  스테일 wasm은 신규 Intent를 "unknown variant"로 조용히 거부합니다.
- e2e 전 `rm -rf apps/hwp-lab/.next` — 웹팩 캐시가 dist 재빌드를 감지하지 못합니다.
- 앱은 `packages/*/dist`(컴파일 산출물)를 소비합니다 — 소스만 고치면 스테일 dist가 실립니다.
  `pnpm -C packages/<p> build` 후 확인하세요.
- `cargo fmt`는 강제입니다 — fmt-dirty 커밋은 다음 verify에서 걸립니다.

## 아키텍처 지도

```
React UI (@tf-hwp/react: HwpWorkspace + overlays)          ← 선택 레이어
 → editor-core (@tf-hwp/editor-core: headless selection/edit/session)
  → EngineAdapter 27메서드 (adapter.ts)                     ← 자체 에디터는 여기에 연결
   → WasmAdapter(웹) | TauriAdapter(데스크톱) — 같은 계약
    → @tf-hwp/engine (wasm): SemanticDoc + 조판 + SVG/HTML/PDF/HWPX
```

레이어 계약 상세는 `docs/SDK-LAYERS.md`, 임베드는 `docs/EMBED-GUIDE.md`,
편집 프로토콜은 `docs/INTENT-SCHEMA.md`를 보세요.

## 라이선스

기여물은 MIT OR Apache-2.0 듀얼 라이선스로 제출됩니다 (LICENSE-MIT / LICENSE-APACHE).
