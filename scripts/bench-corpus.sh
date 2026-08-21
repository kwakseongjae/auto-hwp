#!/bin/bash
# bench-corpus.sh — 실물 벤치셋(corpus/private/bench-*) 전수 스윕 게이트.
#
# 두 축을 분리 보고한다 (이슈 #72). 한 표에 섞지 않는다 — 어느 쪽이 깨졌는지 읽어야 한다.
#   1) pipeline  : detect / own-render(페이지수) / export-pdf / extract-text
#                  = "크래시 없이 파이프라인 통과". 시각 충실도는 이 축이 아니다.
#   2) layout    : layout-check 줄 단위 정합 (저장 <hp:lineseg> 대조).
#                  한/글의 참값이 아니라 저장 lineseg 기준의 회귀 잠금이다.
#                  변환 HWPX의 빈 linesegarray 는 채점 불가이지 0점이 아니다.
#
# corpus/private 부재 시(CI 등) skip 종료. 공개 코퍼스 전수 스윕은
#   node scripts/oracle-sweep.mjs
# 사용: scripts/bench-corpus.sh [--update-baseline]
#       BENCH_ROOT=<경로> scripts/bench-corpus.sh   # 다른 루트를 스윕(scripts/bench-local.sh --pipeline 이 이렇게 위임)
set -u
cd "$(dirname "$0")/.." || exit 1
BENCH_ROOT="${BENCH_ROOT:-corpus/private}"
BIN=target/release/auto-hwp
[ -d "$BENCH_ROOT" ] || { echo "bench-corpus: $BENCH_ROOT 없음 — skip (로컬 전용 게이트)"; exit 0; }
if [ ! -x "$BIN" ]; then
  echo "bench-corpus: building CLI (release, rhwp+shaper+pdf)…"
  cargo build --release -p auto-hwp-cli --features rhwp,shaper,pdf || exit 1
fi
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
pipeline_fail=0
layout_fail=0
today=$(date +%Y-%m-%d)

layout_tsv_from_json() {
  node --input-type=module -e '
import { readFileSync } from "node:fs";
import { cliReportsToTsv } from "./scripts/lib/oracle-score.mjs";
const j = JSON.parse(readFileSync(process.argv[1], "utf8"));
process.stdout.write(cliReportsToTsv(j));
' "$1"
}

for set_dir in "$BENCH_ROOT"/bench-*/; do
  [ -d "$set_dir/files" ] || continue
  set_name=$(basename "$set_dir")
  out="$TMP/$set_name.tsv"
  printf "file\tfmt\trender\tpages\tpdf\ttext_chars\n" > "$out"
  files=()
  # -L: files 가 심볼릭 링크일 수 있다(bench-local.sh --pipeline 이 임시 스테이징으로 링크를 건다).
  while IFS= read -r f; do
    files+=("$f")
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
  done < <(find -L "$set_dir/files" -type f \( -iname "*.hwp" -o -iname "*.hwpx" \) | sort)

  baseline=$(ls "$set_dir"/RESULTS-*.tsv 2>/dev/null | sort | tail -1)
  n_total=$(($(wc -l < "$out") - 1))
  n_fail=$(grep -c $'\tFAIL' "$out" || true)
  echo "── $set_name [pipeline / 크래시 없음]: $n_total files, FAIL=$n_fail"
  grep $'\tFAIL' "$out" | cut -f1,3,5 | sed 's/^/   ✗ /'
  if [ "${1:-}" = "--update-baseline" ]; then
    cp "$out" "$set_dir/RESULTS-$today.tsv"
    echo "   pipeline baseline 갱신 → RESULTS-$today.tsv"
  elif [ -n "$baseline" ]; then
    while IFS=$'\t' read -r name fmt render pages pdf chars; do
      [ "$name" = "file" ] && continue
      base_line=$(grep -F "$name" "$baseline" | head -1)
      [ -z "$base_line" ] && continue
      if [ "$render" = "FAIL" ] || [ "$pdf" = "FAIL" ]; then
        echo "   ✗ pipeline 회귀: $name render=$render pdf=$pdf (기준선은 통과)"; pipeline_fail=1
      fi
    done < "$out"
  fi
  [ "$n_fail" -gt 0 ] && pipeline_fail=1

  # ── layout-check 축 (pipeline 과 다른 TSV · 다른 기준선) ──────────────────
  echo "── $set_name [layout-check / 줄 단위 정합]: 저장 lineseg 회귀 잠금 (한/글 참값 아님)"
  layout_json="$TMP/$set_name.layout.json"
  layout_out="$TMP/$set_name.layout.tsv"
  if [ "${#files[@]}" -eq 0 ]; then
    echo "   (파일 없음)"
    continue
  fi
  if "$BIN" layout-check --json "${files[@]}" > "$layout_json" 2>"$TMP/$set_name.layout.err"; then
    :
  else
    if [ ! -s "$layout_json" ]; then
      echo "   ✗ layout-check --json 실패"; layout_fail=1
      sed 's/^/      /' "$TMP/$set_name.layout.err" | head -20
      continue
    fi
  fi
  layout_tsv_from_json "$layout_json" > "$layout_out"
  n_layout=$(($(wc -l < "$layout_out") - 1))
  n_unsc=$(grep -c $'\tunscorable\t' "$layout_out" || true)
  n_lfail=$(grep -c $'\tfail\t' "$layout_out" || true)
  n_scorable=$((n_layout - n_unsc - n_lfail))
  echo "   files=$n_layout scorable=$n_scorable unscorable=$n_unsc fail=$n_lfail"
  awk -F'\t' 'NR>1 && ($2=="fail" || $2=="page_gap" || $2=="line_gap") {
    printf "   · %s  %s  pages=%s/%s  line=%s  cell=%s\n", $2, $1, $4, $5, $8, $10
  }' "$layout_out"
  [ "$n_lfail" -gt 0 ] && layout_fail=1

  layout_base=$(ls "$set_dir"/LAYOUT-*.tsv 2>/dev/null | sort | tail -1)
  if [ "${1:-}" = "--update-baseline" ]; then
    cp "$layout_out" "$set_dir/LAYOUT-$today.tsv"
    echo "   layout baseline 갱신 → LAYOUT-$today.tsv  (참값 아님 · 저장 lineseg 잠금)"
  elif [ -z "$layout_base" ]; then
    echo "   layout baseline 없음 — 이번 값은 보고만. 잠그려면 --update-baseline"
  else
    while IFS=$'\t' read -r name verdict kind ours theirs pmatch paras linepct cparas cellpct; do
      [ "$name" = "file" ] && continue
      base_row=$(awk -F'\t' -v n="$name" '$1==n{print; exit}' "$layout_base")
      [ -z "$base_row" ] && continue
      base_verdict=$(echo "$base_row" | cut -f2)
      base_kind=$(echo "$base_row" | cut -f3)
      base_pmatch=$(echo "$base_row" | cut -f6)
      if [ "$base_kind" = "scorable" ] && [ "$kind" = "fail" ]; then
        echo "   ✗ layout 회귀: $name scorable → fail"; layout_fail=1
      fi
      if [ "$base_kind" = "scorable" ] && [ "$kind" = "unscorable" ]; then
        echo "   ✗ layout 회귀: $name scorable → unscorable"; layout_fail=1
      fi
      if [ "$base_pmatch" = "Y" ] && [ "$pmatch" = "N" ]; then
        echo "   ✗ layout 회귀: $name page_match Y → N ($ours vs $theirs)"; layout_fail=1
      fi
      if [ "$base_verdict" = "match" ] && [ "$verdict" != "match" ] && [ "$verdict" != "unscorable" ]; then
        echo "   ✗ layout 회귀: $name verdict match → $verdict"; layout_fail=1
      fi
    done < "$layout_out"
  fi
done

echo ""
echo "── 축 분리 요약 (이슈 #72) ──"
echo "   pipeline (크래시 없음): $([ "$pipeline_fail" -eq 0 ] && echo PASS || echo FAIL)"
echo "   layout-check (줄 단위 정합 · 참값 아님): $([ "$layout_fail" -eq 0 ] && echo PASS || echo FAIL)"
if [ "$pipeline_fail" -eq 0 ] && [ "$layout_fail" -eq 0 ]; then
  echo "bench-corpus: ALL PASS"
  exit 0
fi
echo "bench-corpus: FAIL 존재 (위 두 축을 따로 볼 것)"
if [ "$pipeline_fail" -ne 0 ] && [ "$layout_fail" -eq 0 ]; then
  exit 1
fi
if [ "$pipeline_fail" -eq 0 ] && [ "$layout_fail" -ne 0 ]; then
  exit 2
fi
exit 1
