#!/usr/bin/env bash
# bench-local.sh — 내 공문서로 조판 격차를 재는 사용자 진입로 (auto-hwp 기여 퍼널 1단계)
#
# 하는 일: benchmarks/local/ 에 넣어 둔 .hwp/.hwpx 를 전수로 `layout-check` 에 통과시켜
#          "우리 조판 vs 한컴이 파일에 저장해 둔 실제 레이아웃(lineseg)" 격차 표를 뽑는다.
#          쪽수·본문 줄수·셀 줄수 세 축이며, 격차가 큰 순으로 정렬해 이슈에 붙일 수 있는
#          마크다운 블록까지 만들어 준다.
#
# ── 프라이버시 (읽고 시작하세요) ────────────────────────────────────────────────
#   · 이 스크립트는 네트워크를 쓰지 않는다. 문서는 이 컴퓨터 밖으로 나가지 않는다.
#   · benchmarks/local/ 은 .gitignore 로 커밋에서 제외된다 (README 만 추적).
#   · 리포트(REPORT-*.tsv)도 같은 폴더에 떨어지므로 함께 무시된다.
#   · 이슈에는 **파일이 아니라 수치·구조 특징만** 올린다 — 공문서 재배포 금지 규율.
#     민감 문서는 corpus/private/ 규율을 따른다(CONTRIBUTING.md "조판 이슈 기여" 참조).
#
# 사용:
#   scripts/bench-local.sh                 # benchmarks/local/ 전수 조판 격차 스윕
#   scripts/bench-local.sh --dir <경로>     # 다른 폴더를 잰다 (예: corpus/private/bench-public/files)
#   scripts/bench-local.sh --pipeline      # 조판 격차 대신 "크래시 없이 통과하는가"를 잰다
#                                          #   (scripts/bench-corpus.sh 에 위임)
#   scripts/bench-local.sh --top N         # 이슈용 마크다운에 담을 최악 N건 (기본 5)
#
# 종료 코드: 0 = 스윕 완료(격차가 있어도 0 — 이 스크립트는 게이트가 아니라 측정 도구다)
#            1 = 실행 불가(빌드 실패 등)
set -uo pipefail
cd "$(git rev-parse --show-toplevel 2>/dev/null || echo "$(dirname "$0")/..")" || exit 1

DIR=benchmarks/local
PIPELINE=0
TOP=5
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) DIR="${2:?--dir 뒤에 경로가 필요합니다}"; shift 2 ;;
    --pipeline) PIPELINE=1; shift ;;
    --top) TOP="${2:?--top 뒤에 개수가 필요합니다}"; shift 2 ;;
    -h|--help) sed -n '2,/^set -/p' "$0" | grep '^#' | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "알 수 없는 옵션: $1 (--help)"; exit 1 ;;
  esac
done

BIN=target/release/auto-hwp

banner() {
  echo "════════════════════════════════════════════════════════════════════"
  echo " auto-hwp 로컬 벤치 — $DIR"
  echo " 문서는 이 컴퓨터를 벗어나지 않습니다 (네트워크 호출 없음 · gitignore)"
  echo "════════════════════════════════════════════════════════════════════"
}

onboard() {
  cat <<EOF

$DIR 에 잴 문서가 없습니다.

  1) 손에 있는 공문서 양식(.hwp/.hwpx)을 여기에 복사하세요:
         cp ~/Downloads/사업계획서_양식.hwp $DIR/
  2) 다시 실행하세요:
         scripts/bench-local.sh

무엇을 재나요 — 한/글은 파일 안에 "자기가 조판한 결과"(lineseg: 문단별 줄 수와 줄 좌표)를
같이 저장합니다. 이 스크립트는 그 저장값을 정답지로 삼아 auto-hwp 의 조판과 대조합니다.
한/글 설치본도, 인터넷도 필요 없습니다.

격차를 찾으면: CONTRIBUTING.md 의 "조판 이슈 기여" 절을 따라 **수치·구조 특징만**으로
이슈를 올려 주세요(문서 첨부 금지).
EOF
}

ensure_bin() {
  if [ ! -x "$BIN" ] || [ -n "$(find crates -newer "$BIN" -name '*.rs' -print -quit 2>/dev/null)" ]; then
    echo "CLI 빌드 중 (release · rhwp,shaper,pdf) — 처음 한 번은 몇 분 걸립니다…"
    cargo build --release -p auto-hwp-cli --features rhwp,shaper,pdf || {
      echo "❌ 빌드 실패 — 서브모듈이 없으면 git submodule update --init --recursive"; exit 1; }
  fi
}

banner
[ -d "$DIR" ] || mkdir -p "$DIR"

# ── --pipeline: 조판이 아니라 "파이프라인 통과" 축. bench-corpus.sh 에 위임한다. ────────
if [ "$PIPELINE" = 1 ]; then
  echo "모드: 파이프라인 통과 (detect / own-render / export-pdf / extract-text)"
  echo "      → scripts/bench-corpus.sh 에 위임합니다."
  STAGE=$(mktemp -d)
  trap 'rm -rf "$STAGE"' EXIT
  mkdir -p "$STAGE/bench-local"
  ln -s "$(cd "$DIR" && pwd)" "$STAGE/bench-local/files"
  BENCH_ROOT="$STAGE" scripts/bench-corpus.sh
  exit $?
fi

# ── 대상 수집 (빌드보다 먼저 — 빈 폴더에서 몇 분짜리 빌드를 돌리지 않는다) ────────────
FILES=$(find -L "$DIR" -type f \( -iname '*.hwp' -o -iname '*.hwpx' \) | sort)
if [ -z "$FILES" ]; then onboard; exit 0; fi
N=$(echo "$FILES" | wc -l | tr -d ' ')

ensure_bin

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
ROWS="$TMP/rows.tsv"                     # sortkey \t 판정 \t 우리쪽 \t 한컴쪽 \t Δ \t 문단 \t 줄정확 \t 줄±1 \t 셀정확 \t 구조 \t 파일
: > "$ROWS"

echo "대상 $N 건 · 정답지 = 파일에 저장된 한/글 lineseg (설치본 불필요)"
echo ""

i=0
while IFS= read -r f; do
  i=$((i + 1))
  name=$(basename "$f")
  [ -t 2 ] && printf '\r  [%d/%d] 측정 중…\033[K' "$i" "$N" >&2
  out=$("$BIN" layout-check "$f" 2>"$TMP/err") || {
    err=$(head -1 "$TMP/err" | cut -c1-70)
    printf '9999\t실패\t-\t-\t-\t-\t-\t-\t-\t%s\t%s\n' "$err" "$name" >> "$ROWS"
    continue
  }
  ours=$(echo "$out"  | grep -F '쪽수' | awk '{print $3}')
  theirs=$(echo "$out"| grep -F '쪽수' | awk '{print $6}')
  paras=$(echo "$out" | grep -F '문단' | grep -Fv '셀' | awk '{print $2}')
  exact=$(echo "$out" | grep -F '줄수 정확 일치' | grep -Fv '셀' | awk '{print $5}' | tr -d '()%')
  w1=$(echo "$out"    | grep -F '줄수 ±1 이내'  | grep -Fv '셀' | awk '{print $5}' | tr -d '()%')
  cparas=$(echo "$out"| grep -F '셀 문단' | awk '{print $3}')
  cexact=$(echo "$out"| grep -F '셀 줄수 정확 일치' | awk '{print $6}' | tr -d '()%')
  struct=$(echo "$out" | grep -F '블록 구성' | sed 's/.*블록 구성 *//')

  ours=${ours:-0}; theirs=${theirs:-0}; paras=${paras:-0}
  exact=${exact:-0}; w1=${w1:-0}; cparas=${cparas:-0}; cexact=${cexact:-0}
  # 셀 오라클이 아예 없으면 0% 로 표기하지 않는다 — "0점"과 "채점 불가"는 다르다.
  [ "$cparas" = "0" ] && cexact="-"

  # 판정 — 정답지가 없으면 점수를 꾸며내지 않는다(068 규율).
  if [ "$paras" = "0" ]; then
    verdict="오라클없음"; sort=8000
  else
    d=$((ours - theirs)); ad=${d#-}
    if [ "$ad" -eq 0 ] && awk -v e="$exact" 'BEGIN{exit !(e+0 >= 98.9)}'; then
      verdict="일치"; sort=0
    elif [ "$ad" -eq 0 ]; then
      verdict="줄격차"; sort=$(awk -v e="$exact" 'BEGIN{printf "%d", 1000 + (100-e)*10}')
    else
      verdict="쪽격차"; sort=$((5000 + ad * 10))
    fi
  fi
  d=$((ours - theirs))
  printf '%s\t%s\t%s\t%s\t%+d\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$sort" "$verdict" "$ours" "$theirs" "$d" "$paras" "$exact" "$w1" "$cexact" "$struct" "$name" >> "$ROWS"
done <<< "$FILES"
printf '\r\033[K' >&2

SORTED="$TMP/sorted.tsv"
sort -rn -k1,1 "$ROWS" > "$SORTED"

# ── 표 출력 (파일명을 마지막에 둬서 한글 폭 때문에 정렬이 깨지지 않게 한다) ───────────
printf '%-10s %6s %6s %5s %6s %8s %8s %8s  %s\n' \
  "판정" "우리쪽" "한컴쪽" "Δ쪽" "문단" "줄정확%" "줄±1%" "셀정확%" "파일"
printf '%s\n' "───────────────────────────────────────────────────────────────────────────────"
while IFS=$'\t' read -r sort verdict ours theirs d paras exact w1 cexact struct name; do
  printf '%-8s %6s %6s %5s %6s %8s %8s %8s  %s\n' \
    "$verdict" "$ours" "$theirs" "$d" "$paras" "$exact" "$w1" "$cexact" "$name"
done < "$SORTED"

n_ok=$(awk -F'\t' '$2=="일치"'     "$SORTED" | wc -l | tr -d ' ')
n_line=$(awk -F'\t' '$2=="줄격차"' "$SORTED" | wc -l | tr -d ' ')
n_page=$(awk -F'\t' '$2=="쪽격차"' "$SORTED" | wc -l | tr -d ' ')
n_noor=$(awk -F'\t' '$2=="오라클없음"' "$SORTED" | wc -l | tr -d ' ')
n_err=$(awk -F'\t' '$2=="실패"'    "$SORTED" | wc -l | tr -d ' ')

echo ""
echo "요약: 총 $N · 일치 $n_ok · 줄격차 $n_line · 쪽격차 $n_page · 오라클없음 $n_noor · 실패 $n_err"
echo ""
echo "  일치       = 쪽수 동일 + 본문 줄수 정확 일치 98.9%+ (게이트 기준선)"
echo "  줄격차     = 쪽수는 맞는데 문단 줄 나눔이 다르다 (조판 정밀도 축)"
echo "  쪽격차     = 페이지 수가 다르다 (세로 공간 계산 축 — 영향 가장 큼)"
echo "  오라클없음 = 파일에 한/글 lineseg 캐시가 없다(변환·정규화본). 점수를 매기지 않는다."
echo "  실패       = 파싱/조판 자체가 실패 — 이건 조판 이슈가 아니라 버그 리포트 감이다."

# 리포트는 --dir 가 무엇이든 항상 benchmarks/local 에 떨군다 — 그 폴더만 gitignore 가 보장되고,
# 남의 코퍼스 폴더를 산출물로 오염시키지 않는다.
mkdir -p benchmarks/local
REPORT="benchmarks/local/REPORT-$(date +%Y-%m-%d).tsv"
{
  printf '# source_dir=%s\tgenerated=%s\n' "$DIR" "$(date +%Y-%m-%dT%H:%M:%S)"
  printf 'verdict\tour_pages\thancom_pages\tdelta\tparagraphs\tline_exact_pct\tline_within1_pct\tcell_exact_pct\tblocks\tfile\n'
  cut -f2- "$SORTED"
} > "$REPORT"
echo ""
echo "리포트: $REPORT  (gitignore — 커밋되지 않습니다)"

# ── 이슈에 붙일 마크다운 (수치·구조만 — 문서 내용은 한 글자도 담지 않는다) ──────────────
GAPS=$(awk -F'\t' '$2=="쪽격차" || $2=="줄격차"' "$SORTED" | head -"$TOP")
if [ -n "$GAPS" ]; then
  echo ""
  echo "──────── 아래를 복사해 이슈(layout-gap 템플릿)에 붙이세요 ────────"
  echo ""
  echo "| # | 판정 | 우리 쪽 | 한컴 쪽 | Δ | 문단 | 줄 정확% | 줄 ±1% | 셀 정확% | 구조 |"
  echo "|---|---|---:|---:|---:|---:|---:|---:|---:|---|"
  k=0
  while IFS=$'\t' read -r sort verdict ours theirs d paras exact w1 cexact struct name; do
    k=$((k + 1))
    ext="${name##*.}"
    echo "| $k | $verdict | $ours | $theirs | $d | $paras | $exact | $w1 | $cexact | .$(echo "$ext" | tr 'A-Z' 'a-z') · $struct |"
  done <<< "$GAPS"
  echo ""
  echo "> 문서 파일은 첨부하지 마세요. 위 수치·구조 특징이면 재현 가설을 세울 수 있습니다."
  echo "> (파일명·본문 텍스트는 이 표에 들어가지 않습니다 — 확인 후 올려 주세요.)"
  echo ""
  echo "────────────────────────────────────────────────────────────────"
fi
exit 0
