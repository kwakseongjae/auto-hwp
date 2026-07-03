#!/usr/bin/env bash
# nodes.sh — issue 033 SVG-DOM node census via the NATIVE own-render path (same hwp-typeset →
# hwp-render → SvgSink pipeline the wasm engine runs), so it cross-checks measure-engine.mjs without
# needing the wasm build. Counts element open-tags per page + a whole-doc element histogram.
#
# Usage:  scripts/figma-grade/nodes.sh [benchmarks/benchmark2.hwp]
set -euo pipefail
export PATH="$HOME/.cargo/bin:$PATH"

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DOC="${1:-$ROOT/benchmarks/benchmark2.hwp}"
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT

echo "=== issue 033 · SVG-DOM node census (native own-render) — $(basename "$DOC") ==="
( cd "$ROOT" && cargo run -q -p tf-hwp-cli --features "shaper rhwp" --release -- \
    own-render "$DOC" --out "$OUT/p.svg" ) >/dev/null

total=0 max=0 maxf="" n_pages=0
for f in "$OUT"/*.svg; do
  n=$(grep -oE '<[a-zA-Z]' "$f" | wc -l | tr -d ' ')
  total=$((total + n)); n_pages=$((n_pages + 1))
  if [ "$n" -gt "$max" ]; then max=$n; maxf="$(basename "$f")"; fi
done
echo "pages=$n_pages  total_nodes=$total  max_page=$max ($maxf)  avg=$((total / n_pages))"
echo "--- element histogram (whole doc) ---"
cat "$OUT"/*.svg | grep -oE '<[a-zA-Z]+' | sort | uniq -c | sort -rn
