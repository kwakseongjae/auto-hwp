#!/usr/bin/env bash
#
# golden.sh — issue 012 (P2): freeze the "pure move" invariant BEFORE the hwp-session
# extraction, and re-check it after every slice. The move must be byte-identical:
#
#   1. layout-check benchmarks/benchmark.hwp — the 8==8 page gate + line-break accuracy.
#   2. own-render benchmarks/benchmark.hwp / benchmarks/benchmark1.hwp — the self-owned SVG per page.
#      We render TWICE and diff the two runs first (own-render SVG must be
#      deterministic; if not, the offending field is normalized before hashing —
#      see the notes at the bottom). Then shasum every page SVG.
#
# Usage:
#   scripts/golden.sh baseline   # capture into /tmp/golden_base
#   scripts/golden.sh check      # capture into /tmp/golden_post and diff vs baseline
#
# Exit non-zero if the layout-check text or any SVG hash differs from the baseline.

set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 2

MODE="${1:-check}"
FEATURES="shaper rhwp"

if [ "$MODE" = "baseline" ]; then
  OUT=/tmp/golden_base
else
  OUT=/tmp/golden_post
fi
rm -rf "$OUT"
mkdir -p "$OUT"

echo "== golden ($MODE) — features: $FEATURES =="

# --- 1. layout-check (the 8==8 gate + line accuracy) ---
cargo run -q -p auto-hwp-cli --features "$FEATURES" -- layout-check benchmarks/benchmark.hwp \
  > "$OUT/layout_benchmark.txt" 2>&1
echo "-- layout-check benchmarks/benchmark.hwp --"
cat "$OUT/layout_benchmark.txt"

cargo run -q -p auto-hwp-cli --features "$FEATURES" -- layout-check benchmarks/benchmark1.hwp \
  > "$OUT/layout_benchmark1.txt" 2>&1
echo "-- layout-check benchmarks/benchmark1.hwp --"
cat "$OUT/layout_benchmark1.txt"

# --- 2. own-render SVG, TWICE, to prove determinism ---
render_all () {
  local file="$1" tag="$2" run="$3"
  cargo run -q -p auto-hwp-cli --features "$FEATURES" -- own-render "$file" \
    --out "$OUT/${tag}_r${run}.svg" >/dev/null 2>&1
}

for pair in "benchmark.hwp:b" "benchmarks/benchmark1.hwp:b1"; do
  file="${pair%%:*}"; tag="${pair##*:}"
  render_all "$file" "$tag" 1
  render_all "$file" "$tag" 2
  # determinism: run1 vs run2 (compare the whole set of page svgs by content)
  ok=1
  for f in "$OUT/${tag}_r1"*.svg; do
    g="${f/_r1/_r2}"
    if ! cmp -s "$f" "$g"; then ok=0; echo "!! NON-DETERMINISTIC: $f vs $g"; fi
  done
  [ "$ok" = 1 ] && echo "-- own-render $file: SVG byte-stable across 2 runs ($(ls "$OUT/${tag}_r1"*.svg | wc -l | tr -d ' ') page svg files) --"
done

# --- 3. hashes of run-1 SVGs (the canonical set) ---
( cd "$OUT" && shasum *_r1*.svg | sort -k2 ) > "$OUT/hashes.txt"
echo "-- SVG hashes ($MODE) --"
cat "$OUT/hashes.txt"

# --- 4. if checking, diff vs baseline ---
if [ "$MODE" = "check" ]; then
  rc=0
  echo "== DIFF vs baseline =="
  for f in layout_benchmark.txt layout_benchmark1.txt; do
    if diff -q "/tmp/golden_base/$f" "$OUT/$f" >/dev/null 2>&1; then
      echo "OK   $f"
    else
      echo "DIFF $f"; diff "/tmp/golden_base/$f" "$OUT/$f" || true; rc=1
    fi
  done
  # compare hash sets (strip the run tag so _r1 lines up baseline↔post)
  if diff -q "/tmp/golden_base/hashes.txt" "$OUT/hashes.txt" >/dev/null 2>&1; then
    echo "OK   SVG hashes identical"
  else
    echo "DIFF SVG hashes"; diff "/tmp/golden_base/hashes.txt" "$OUT/hashes.txt" || true; rc=1
  fi
  [ "$rc" = 0 ] && echo "== GOLDEN OK ==" || echo "== GOLDEN BROKEN =="
  exit $rc
fi

# NOTE on determinism: as of the baseline the own-render SVG carries no random id /
# timestamp / pointer-formatted field — the only HashMap (RealFontMetrics advance
# memo cache) does not affect output order — so no normalization is applied. If a
# future non-deterministic field appears, normalize it here (sed) BEFORE hashing and
# record that fact rather than reporting a false "mismatch".
