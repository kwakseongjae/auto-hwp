#!/usr/bin/env bash
# tf-hwp 로컬 검증 정본 — CI(GitHub Actions)는 workflow_dispatch 수동 전용으로 전환됨(2026-07-11).
# 머지/푸시 전 이 스크립트가 그린이어야 한다. CI가 검사하던 것(fmt/clippy/test/wasm/deny)을 전부 포함하고,
# CI가 못 하던 것(게이트 v2, rhwp 피처 테스트, wasm 재빌드, JS/e2e)까지 --full에서 커버한다.
#
# 사용:  scripts/verify-local.sh            # quick: Rust 전체 (fmt/clippy/test/게이트/wasm/deny)
#        scripts/verify-local.sh --full     # + wasm 재빌드 + JS 빌드/vitest + e2e (crates·UI 접촉 시 필수)
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
MODE="${1:---quick}"

echo "═══ fmt ═══"
cargo fmt --all --check
echo "═══ clippy (-D warnings) ═══"
cargo clippy --workspace --all-targets -- -D warnings
echo "═══ tests (workspace) ═══"
cargo test --workspace
echo "═══ tests (hwp-rhwp features) ═══"
cargo test -p hwp-rhwp --features "rhwp shaper"

echo "═══ 게이트 v2 (benchmark 8==8 · benchmark1 18==18) ═══"
for b in benchmark benchmark1; do
  out=$(cargo run -q -p tf-hwp-cli --features "shaper rhwp" -- layout-check "benchmarks/${b}.hwp")
  echo "$out" | grep "쪽수"
  echo "$out" | grep "쪽수" | grep -q "일치" || { echo "❌ 게이트 실패: ${b}.hwp 페이지 수 불일치"; exit 1; }
done

echo "═══ wasm 위생 ═══"
cargo check -p hwp-wasm --target wasm32-unknown-unknown

if command -v cargo-deny >/dev/null 2>&1; then
  echo "═══ licenses (cargo-deny) ═══"
  cargo deny check licenses
else
  echo "(cargo-deny 미설치 — 라이선스 검사 생략. 설치: cargo install cargo-deny --locked)"
fi

if [ "$MODE" = "--full" ]; then
  echo "═══ wasm 재빌드 (AGENTS.md 함정 top6 — 스테일 wasm 방지) ═══"
  cargo build -p hwp-wasm --release --target wasm32-unknown-unknown
  wasm-bindgen --target web --out-dir packages/engine/pkg target/wasm32-unknown-unknown/release/hwp_wasm.wasm
  node apps/hwp-lab/scripts/copy-wasm.mjs
  rm -rf apps/hwp-lab/.next
  echo "═══ JS 빌드 ═══"
  pnpm -C packages/editor-core build
  pnpm -C packages/react build
  echo "═══ vitest ═══"
  pnpm -C packages/editor-core exec vitest run
  pnpm -C packages/ai-protocol exec vitest run
  pnpm -C packages/react exec vitest run
  (cd apps/hwp-lab && npx vitest run)
  echo "═══ e2e (playwright) ═══"
  (cd apps/hwp-lab && npx playwright test)
fi

echo ""
echo "✅ verify-local ($MODE) 전부 그린"
