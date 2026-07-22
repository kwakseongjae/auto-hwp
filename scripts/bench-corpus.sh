#!/bin/bash
# bench-corpus.sh — 실물 벤치셋(corpus/private/bench-*) 전수 스윕 게이트.
# 검증 축: detect / own-render(페이지수) / export-pdf / extract-text (= "크래시 없이 파이프라인 통과").
# 시각 충실도는 검증하지 않는다(별도 QA.md 육안 트랙). corpus/private 부재 시(CI 등) skip 종료.
# 사용: scripts/bench-corpus.sh [--update-baseline]
set -u
cd "$(dirname "$0")/.." || exit 1
BENCH_ROOT=corpus/private
BIN=target/release/auto-hwp
[ -d "$BENCH_ROOT" ] || { echo "bench-corpus: $BENCH_ROOT 없음 — skip (로컬 전용 게이트)"; exit 0; }
if [ ! -x "$BIN" ]; then
  echo "bench-corpus: building CLI (release, rhwp+shaper+pdf)…"
  cargo build --release -p auto-hwp-cli --features rhwp,shaper,pdf || exit 1
fi
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
fail=0
for set_dir in "$BENCH_ROOT"/bench-*/; do
  [ -d "$set_dir/files" ] || continue
  set_name=$(basename "$set_dir")
  out="$TMP/$set_name.tsv"
  printf "file\tfmt\trender\tpages\tpdf\ttext_chars\n" > "$out"
  find "$set_dir/files" -type f \( -iname "*.hwp" -o -iname "*.hwpx" \) | sort | while IFS= read -r f; do
    name=$(basename "$f")
    fmt=$("$BIN" detect "$f" 2>&1 | head -1 | tr -d '\n')
    rout=$("$BIN" own-render "$f" --out "$TMP/p.svg" 2>&1)
    if [ $? -eq 0 ]; then
      pages=$(echo "$rout" | grep -oE '[0-9]+ page' | head -1 | grep -oE '[0-9]+'); render=OK
    else
      pages="-"; render=FAIL
    fi
    if "$BIN" export-pdf "$f" --out "$TMP/p.pdf" >/dev/null 2>&1; then pdf=OK; else pdf=FAIL; fi
    chars=$("$BIN" extract-text "$f" 2>/dev/null | wc -c | tr -d ' ')
    printf "%s\t%s\t%s\t%s\t%s\t%s\n" "$name" "$fmt" "$render" "$pages" "$pdf" "$chars" >> "$out"
  done
  baseline=$(ls "$set_dir"/RESULTS-*.tsv 2>/dev/null | sort | tail -1)
  n_total=$(($(wc -l < "$out") - 1))
  n_fail=$(grep -c $'\tFAIL' "$out" || true)
  echo "── $set_name: $n_total files, FAIL=$n_fail"
  grep $'\tFAIL' "$out" | cut -f1,3,5 | sed 's/^/   ✗ /'
  if [ "${1:-}" = "--update-baseline" ]; then
    cp "$out" "$set_dir/RESULTS-$(date +%Y-%m-%d).tsv"
    echo "   baseline 갱신 → RESULTS-$(date +%Y-%m-%d).tsv"
  elif [ -n "$baseline" ]; then
    # 기준선과 비교: 파일별 render/pages/pdf 컬럼 회귀 검출 (기준선은 must/folder 컬럼이 있을 수 있어 이름 기준 조인)
    while IFS=$'\t' read -r name fmt render pages pdf chars; do
      [ "$name" = "file" ] && continue
      base_line=$(grep -F "$name" "$baseline" | head -1)
      [ -z "$base_line" ] && continue
      base_render=$(echo "$base_line" | grep -o $'\tOK\t' | head -1)
      if [ "$render" = "FAIL" ] || [ "$pdf" = "FAIL" ]; then
        echo "   ✗ 회귀: $name render=$render pdf=$pdf (기준선은 통과)"; fail=1
      fi
    done < "$out"
  fi
  [ "$n_fail" -gt 0 ] && fail=1
done
[ "$fail" -eq 0 ] && echo "bench-corpus: ALL PASS" || echo "bench-corpus: FAIL 존재"
exit "$fail"
