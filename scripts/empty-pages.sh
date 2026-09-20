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

BIN=target/release/auto-hwp
[ -x "$BIN" ] || cargo build --release -p auto-hwp-cli --features rhwp

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

echo "백지 쪽이 있는 문서: ${found}건"
