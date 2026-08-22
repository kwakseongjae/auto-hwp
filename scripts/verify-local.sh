#!/usr/bin/env bash
# auto-hwp 로컬 검증 정본 — CI(GitHub Actions)는 main 대상 PR + workflow_dispatch에서 실행된다.
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
echo "═══ PDF visual oracle (standard-library unittest) ═══"
python3 -m unittest discover -s scripts/tests -p 'test_pdf_visual_check.py'
echo "═══ tests (hwp-rhwp features) ═══"
cargo test -p hwp-rhwp --features "rhwp shaper"

echo "═══ 게이트 v2 (benchmark 8 · benchmark1 18 · benchmark2 24 · 줄정확 98.9%+ · modu-startup 6==6) ═══"
# 사람이 읽는 `쪽수 일치` 문자열만 보면 7==7 같은 절대 쪽수 회귀도 통과한다. JSON 검증기가
# 정확한 문서 집합, 절대 쪽수, 채점 가능 여부, 줄 정확도, 본문 오라클 보존을 한 계약으로 강제한다.
cargo run -q -p auto-hwp-cli --features "shaper rhwp" -- \
  layout-check --json \
  benchmarks/benchmark.hwp \
  benchmarks/benchmark1.hwp \
  benchmarks/benchmark2.hwp \
  | node scripts/canonical-layout-gate.mjs
# modu-startup 실물 양식은 공개 재배포 금지 — corpus/private/(gitignore)에만 존재한다.
# 있으면 기존과 동일하게 SHA + 6==6을 강제하고, 없으면 점수를 꾸며내지 않고 skip을 명시한다(068 규율).
MODU=corpus/private/modu-startup/modu-startup.hwp
if [ -f "$MODU" ]; then
  shasum -a 256 -c corpus/private/modu-startup/modu-startup.sha256
  out=$(cargo run -q -p auto-hwp-cli --features "shaper rhwp" -- layout-check "$MODU")
  echo "$out" | grep "쪽수"
  echo "$out" | grep "쪽수" | grep -q "일치" || { echo "❌ 게이트 실패: modu-startup.hwp 페이지 수 불일치"; exit 1; }
else
  echo "⚠️  modu-startup 게이트 skipped(corpus/private 부재 — 로컬 전용 실물 벤치, 공개 커밋 금지)"
fi

echo "═══ 공공문서 후보 카탈로그 계약 (이슈 99 — metadata-only · 다운로드 없음) ═══"
node --test \
  scripts/tests/gov-sources.test.mjs \
  scripts/tests/fetch-gov-corpus.test.mjs \
  scripts/tests/gov-source-catalog.test.mjs
node scripts/gov-source-catalog.mjs --check

echo "═══ 조판 오라클 스윕 산출물 (이슈 72 — 전수 재실행 아님 · 커밋된 요약만) ═══"
# 코퍼스 전수 layout-check 는 로컬 `node scripts/oracle-sweep.mjs` (--check 가 회귀).
# 여기서는 게이트 시간을 늘리지 않고, 커밋된 JSON/MD 가 규율(참값 아님 · 채점 불가≠0점)을 지키는지 본다.
node --test scripts/tests/canonical-layout-gate.test.mjs scripts/tests/oracle-sweep.test.mjs
node scripts/oracle-sweep.mjs --check-committed

echo "═══ HWPX 축 게이트 (W4.3 — 참값 아님 · 현재 실측 회귀 잠금) ═══"
# ⚠️ 아래 상수는 "한/글의 참값"이 **아니다**. 오늘 이 엔진이 내는 값을 그대로 못 박은 회귀 금지선일
#    뿐이다(HWPX 참값 오라클 = 네이티브 렌더 대조는 이슈 075 몫). 위 .hwp 게이트가 "우리 == 한컴"을
#    요구하는 것과 성격이 다르다 — 여기서 요구하는 것은 "어제와 같은가"뿐이다.
#    조판을 의도적으로 고쳐 값이 바뀌면, 무엇을 왜 고쳤는지 커밋 메시지에 남기고 이 상수를 갱신한다.
#    (그동안 게이트에 .hwpx 가 0건이라 HWPX 전용 경로의 회귀가 전부 무성이었다 — 그 구멍을 막는다.)
hwpx_num() { echo "$1" | tr -d '()%,'; }                     # "(98.2%)" → 98.2
hwpx_ge() { awk -v a="$1" -v b="$2" 'BEGIN{exit !(a+0 >= b-0)}'; }
hwpx_check() { cargo run -q -p auto-hwp-cli --features "shaper rhwp" -- layout-check "$1"; }

# ① benchmark1.hwpx — 쪽수 + 본문 문단 줄수 exact/±1 바닥.
#    2026-07-30 실측 기준선: 우리 22쪽 · 정확 291/325(89.5%) · ±1 319/325(98.2%).
#    (같은 파일이 apps/hwp-lab/public/samples/sample-18p.hwpx 로도 배포된다 — 한 번만 잰다.)
HWPX_MAIN=benchmarks/benchmark1.hwpx
HWPX_MAIN_PAGES=22
HWPX_MAIN_EXACT_MIN=89.5
HWPX_MAIN_W1_MIN=98.2
out=$(hwpx_check "$HWPX_MAIN")
echo "$out" | grep -E "쪽수|줄수 정확 일치|줄수 ±1 이내" | grep -Fv '셀'
pages=$(echo "$out" | grep -F '쪽수' | awk '{print $3}')
exact=$(hwpx_num "$(echo "$out" | grep -F '줄수 정확 일치' | grep -Fv '셀' | awk '{print $5}')")
within1=$(hwpx_num "$(echo "$out" | grep -F '줄수 ±1 이내' | awk '{print $5}')")
[ "$pages" = "$HWPX_MAIN_PAGES" ] || {
  echo "❌ HWPX 게이트: ${HWPX_MAIN} 쪽수 ${pages} ≠ ${HWPX_MAIN_PAGES}(잠금값 — 참값 주장 아님)"; exit 1; }
hwpx_ge "$exact" "$HWPX_MAIN_EXACT_MIN" || {
  echo "❌ HWPX 게이트: 본문 줄수 정확 ${exact}% < ${HWPX_MAIN_EXACT_MIN}%(바닥)"; exit 1; }
hwpx_ge "$within1" "$HWPX_MAIN_W1_MIN" || {
  echo "❌ HWPX 게이트: 본문 줄수 ±1 ${within1}% < ${HWPX_MAIN_W1_MIN}%(바닥)"; exit 1; }

# ② 셀 lineseg 축 — ⚠️ benchmark1.hwpx 는 셀 레이아웃 캐시가 제거된 파일이라(oracle 없음 845건)
#    셀 축을 공급하지 못한다. 캐시가 살아 있는 corpus/hwpx 문서로 건다: 대조 셀 문단 수(줄어들면
#    파서가 오라클을 놓치기 시작한 것)와 exact/±1 비율을 함께 본다.
#    2026-07-30 실측: FormattingShowcase 5/5(100%·100%) · footnote-01 9/9(100%·100%).
for spec in "corpus/hwpx/FormattingShowcase.hwpx:5:100.0:100.0" "corpus/hwpx/footnote-01.hwpx:9:100.0:100.0"; do
  IFS=: read -r f n_min e_min w_min <<<"$spec"
  out=$(hwpx_check "$f")
  echo "$f → $(echo "$out" | grep -F '셀 줄수 정확 일치' | sed 's/^ *//')"
  n=$(echo "$out" | grep -F '셀 문단' | awk '{print $3}')
  e=$(hwpx_num "$(echo "$out" | grep -F '셀 줄수 정확 일치' | awk '{print $6}')")
  w=$(hwpx_num "$(echo "$out" | grep -F '셀 줄수 정확 일치' | awk '{print $11}')")
  hwpx_ge "$n" "$n_min" || { echo "❌ HWPX 게이트: $f 대조 셀 문단 ${n} < ${n_min}(오라클 유실)"; exit 1; }
  hwpx_ge "$e" "$e_min" || { echo "❌ HWPX 게이트: $f 셀 줄수 정확 ${e}% < ${e_min}%"; exit 1; }
  hwpx_ge "$w" "$w_min" || { echo "❌ HWPX 게이트: $f 셀 줄수 ±1 ${w}% < ${w_min}%"; exit 1; }
done

# ③ 한컴 저작 HWPX 쪽수 참값 축(이슈 080) — 명시적 쪽 나누기 + noAdjust 표 행 높이.
#    ⚠️ 위 ①과 성격이 다르다: 여기서는 **우리 == 한컴** 을 요구한다(.hwp 게이트와 같은 강도).
#    실물은 공개 재배포 금지라 corpus/private 에만 있다 — 부재 시 점수를 꾸며내지 않고 skip 한다.
HWPX_GOV=corpus/private/bench-public/files/bizinfo-mss__붙임1_투자형_운영사_사업계획서_양식.hwpx
if [ -f "$HWPX_GOV" ]; then
  out=$(hwpx_check "$HWPX_GOV")
  echo "$out" | grep -F '쪽수'
  echo "$out" | grep -F '쪽수' | grep -q '일치' || {
    echo "❌ HWPX 게이트: bizinfo-mss 붙임1 쪽수가 한컴과 불일치(이슈 080 회귀)"; exit 1; }
else
  echo "⚠️  HWPX 정부양식 쪽수 게이트 skipped(corpus/private 부재 — 로컬 전용 실물 벤치)"
fi

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
  cargo build -p hwp-wasm --profile wasm-size --target wasm32-unknown-unknown
  wasm-bindgen --target web --out-dir packages/engine/pkg target/wasm32-unknown-unknown/wasm-size/hwp_wasm.wasm
  # 이슈 055 번들 다이어트: wasm-opt -Oz (2026-07-11 실측 raw 11.2→8.7MiB -22%, gzip -6%; SVG/HTML/
  # PDF/HWPX 골든 바이트동일 검증 완료). 구버전 binaryen(예: cargo-bin의 116)은 최신 rustc 인코딩을
  # 못 읽으므로 "실제로 성공한" 후보만 채택하고, 전부 실패하면 미적용 경고만 남긴다(다이어트는
  # 게이트가 아니라 최적화 — 미적용 wasm도 기능은 동일하다).
  WASM_PKG=packages/engine/pkg/hwp_wasm_bg.wasm
  WASM_OPTED=0
  for WO in wasm-opt /opt/homebrew/bin/wasm-opt /usr/local/bin/wasm-opt; do
    if command -v "$WO" >/dev/null 2>&1 && "$WO" -Oz --all-features "$WASM_PKG" -o "$WASM_PKG.opt" 2>/dev/null; then
      mv "$WASM_PKG.opt" "$WASM_PKG"
      WASM_OPTED=1
      echo "wasm-opt -Oz 적용 ($("$WO" --version 2>/dev/null | head -1)) → $(wc -c <"$WASM_PKG" | tr -d ' ') bytes"
      break
    fi
    rm -f "$WASM_PKG.opt"
  done
  [ "$WASM_OPTED" = 1 ] || echo "(wasm-opt 미적용 — 동작하는 binaryen 없음. brew install binaryen 권장)"
  node apps/hwp-lab/scripts/copy-wasm.mjs
  rm -rf apps/hwp-lab/.next
  echo "═══ JS 빌드 ═══"
  # ⚠️ ai-protocol 먼저 — 앱/에디터가 그 dist(buildDocContext 등)를 소비한다. 이 빌드가 빠지면 소스는
  # 최신인데 스테일 dist가 그대로 실려 나간다(066 표 그리드가 조용히 드롭돼 QA에서 라벨칸 오타겟 재현).
  pnpm -C packages/ai-protocol build
  pnpm -C packages/editor-core build
  pnpm -C packages/react build
  echo "═══ 본문 캐럿 엔진 교차검증 ═══"
  node packages/engine/bench/body-caret-crosscheck.mjs
  echo "═══ i18n 게이트 (이슈 077 — SDK 문자열은 카탈로그 경유만) ═══"
  # AST 스캔: packages/react/src + packages/editor-core/src 의 bare 한국어 literal 금지.
  # 빌드 산출물이 아니라 소스를 읽으므로 JS 빌드 전후 어디서 돌려도 결과가 같다.
  node packages/react/scripts/check-i18n-literals.mjs
  echo "═══ vitest ═══"
  pnpm -C packages/editor-core exec vitest run
  pnpm -C packages/ai-protocol exec vitest run
  pnpm -C packages/react exec vitest run
  (cd apps/hwp-lab && npx vitest run)
  # 데모 AI 워커도 게이트에 편입(2026-08-05 — 다중 셀 절단 수리가 무성 회귀하지 않게).
  # node_modules 부재(fresh clone)면 점수를 꾸며내지 않고 skip을 명시한다.
  if [ -d services/demo-ai-proxy/node_modules ]; then
    (cd services/demo-ai-proxy && npm test --silent)
  else
    echo "⚠️  demo-ai-proxy vitest skipped(node_modules 부재 — services에서 npm ci 후 재실행)"
  fi
  echo "═══ e2e (playwright) ═══"
  (cd apps/hwp-lab && npx playwright test)
fi

echo ""
echo "✅ verify-local ($MODE) 전부 그린"
