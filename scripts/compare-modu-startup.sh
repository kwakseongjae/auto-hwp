#!/usr/bin/env bash
# Real-form visual oracle: render page 2 from the supplied PDF and from our HWP IR into stable PNGs.
# The files land under tmp/ (gitignored) for human/in-app-browser inspection; CI keeps the structural
# assertions in hwp-rhwp/tests/modu_startup_fidelity.rs and the source hashes below.
#
# 원본 실물 양식은 공개 재배포 금지라 corpus/private/(gitignore)에만 있다 — 부재 환경(fresh clone/CI)에서는
# 점수를 꾸며내지 않고 정직하게 안내 후 skip(exit 0)한다. 이 스크립트는 게이트가 아니라 사람이 보는
# 육안 대조 도구이므로, "자산 없음"은 실패가 아니라 미실행이다(068 corpus/private 규율 · bench-corpus.sh와 동일).
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

BENCH_DIR=corpus/private/modu-startup
if [ ! -f "$BENCH_DIR/modu-startup.hwp" ] || [ ! -f "$BENCH_DIR/modu-startup.pdf" ]; then
  echo "compare-modu-startup: $BENCH_DIR 실물 자산 부재 — skip (로컬 전용 육안 대조 도구)."
  echo "  실물 한글 양식은 공개 레포에 커밋하지 않는다. 로컬에 modu-startup.{hwp,pdf,sha256}을"
  echo "  $BENCH_DIR/ 에 두면 이 스크립트가 동작한다."
  exit 0
fi

shasum -a 256 -c "$BENCH_DIR/modu-startup.sha256"

OUT=tmp/modu-startup-compare
mkdir -p "$OUT"

pdftoppm -f 2 -singlefile -png -r 120 "$BENCH_DIR/modu-startup.pdf" "$OUT/reference-page2"
cargo run -q -p auto-hwp-cli --features "shaper rhwp" -- \
  own-render --page 1 --out "$OUT/own-page2.svg" "$BENCH_DIR/modu-startup.hwp"
rsvg-convert -w 952 -h 1347 "$OUT/own-page2.svg" -o "$OUT/own-page2.png"

if command -v montage >/dev/null 2>&1; then
  montage "$OUT/reference-page2.png" "$OUT/own-page2.png" \
    -tile 2x1 -geometry +20+0 "$OUT/reference-vs-own.png"
fi

echo "reference: $OUT/reference-page2.png"
echo "own render: $OUT/own-page2.png"
if [ -f "$OUT/reference-vs-own.png" ]; then
  echo "side by side: $OUT/reference-vs-own.png"
fi
