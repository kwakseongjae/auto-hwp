#!/usr/bin/env bash
# 백지 쪽 전수 조사 (이슈 302 · 307).
#
# **유일한 증거는 `요소 0` 이다.** `--pages` 가 함께 찍는 `필요 N` 은 증거가 아니다 —
# 그냥 그 줄의 높이라서, 내용이 있는 줄도 같은 값을 갖는다(실측: `필요 1200` 인 쪽에
# 요소 469개가 있었다). 「빈 문단이라 1200 이다」로 읽으면 틀린다.
#
# 쪽수가 맞아도 백지 쪽은 결함이다 — 쪽이 모자란 문서에도 백지가 있어서,
# 백지를 전부 없애도 총 쪽 격차는 −1 뿐이었다. **쪽수로 판정하지 말 것.**
#
# 사용:  scripts/empty-pages.sh                 # 내부 문서 + corpus/private
#        scripts/empty-pages.sh <디렉터리>...
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

# **언제나 빌드한다** (이슈 313 · #305 와 같은 함정).
# `target/release/auto-hwp` 에 누가 무엇으로 빌드해 뒀는지는 모른다. `--features rhwp`
# (shaper 없음)면 **approx 메트릭**으로 재고, 그건 다른 숫자다 — 실측으로 같은 main 에서
# 백지 쪽이 approx 0건 · shaper 1건, corpus 총 격차가 44 · 42 로 갈렸다.
# 오라클 게이트가 shaper 로 채점하므로 **그쪽이 정본**이다. cargo 는 증분이라 거의 공짜다.
BIN=target/release/auto-hwp
cargo build --release -q -p auto-hwp-cli --features rhwp,shaper

if [ $# -eq 0 ]; then
  set -- ../business_plan_k/fixtures/kstartup-forms corpus/private
fi

found=0
while IFS= read -r file; do
  out=$("$BIN" layout-check "$file" --pages 2>/dev/null) || continue
  # 5번째 칸이 「요소」다. 0 이면 그 쪽에 아무것도 안 그려졌다.
  empty=$(printf '%s' "$out" | awk '$1 ~ /^[0-9]+$/ && $5 == "0" { printf "%s ", $1 }')
  [ -n "$empty" ] || continue
  found=$((found + 1))
  total=$(printf '%s' "$out" | awk '$1 ~ /^[0-9]+$/ { n++ } END { print n + 0 }')
  printf '%-52s 총 %s쪽 · 백지: %s\n' "$(basename "$file" | cut -c1-52)" "$total" "$empty"
done < <(find "$@" -type f \( -name '*.hwp' -o -name '*.hwpx' \))

# 무엇으로 쟀는지 함께 찍는다 — approx 와 shaper 는 다른 숫자를 낸다(이슈 313).
metrics=$("$BIN" layout-check --json benchmarks/benchmark1.hwp 2>/dev/null \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)[0].get("metrics","?"))' 2>/dev/null || echo "?")
echo "메트릭 ${metrics} · 백지 쪽이 있는 문서: ${found}건"
