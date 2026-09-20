#!/usr/bin/env bash
# 쪽수 충실도 지표 — **총 쪽 격차** Σ|우리 − 한컴| (이슈 247 · 302).
#
# 왜 이진 일치가 아니라 합인가:
#   일치 개수는 **개선을 못 본다.** 실측으로 격차가 `18 → 8` 로 줄어든 변경이
#   일치로는 `31 → 32` 로만 보였다. 문서 하나가 ±3 씩 틀리는 경우가 있어서다.
#   수리의 기대값을 계산하려면 합이 필요하다.
#
# 코퍼스는 **둘이고 목적이 다르다**:
#   내부 문서  ../business_plan_k/fixtures/kstartup-forms  — 최종 목표(우리 문서 재현)
#   회귀 감시  corpus/private                              — 합성 synth-146p(−13)가 지배하므로 따로 본다
#   `corpus/hwp` · `benchmarks` 는 둘 다에 없다 — 거긴 `oracle-sweep` 이 본다.
#
# 사용:  scripts/page-delta.sh                      # 내부 문서
#        scripts/page-delta.sh corpus/private       # 회귀 감시
#        scripts/page-delta.sh <디렉터리>...
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
  set -- ../business_plan_k/fixtures/kstartup-forms
fi

TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT
find "$@" -type f \( -name '*.hwp' -o -name '*.hwpx' \) -print0 \
  | xargs -0 "$BIN" layout-check --json > "$TMP"

python3 - "$TMP" <<'PY'
import json, sys, pathlib
rows = json.load(open(sys.argv[1]))
total = scored = match = 0
gaps = []
for r in rows:
    ours, hancom = r.get("our_pages"), r.get("oracle_pages")
    # 오라클(저장 lineseg)이 없는 문서는 **0점이 아니라 채점 불가**다.
    if not ours or not hancom:
        continue
    scored += 1
    delta = ours - hancom
    total += abs(delta)
    if delta == 0:
        match += 1
    else:
        gaps.append((delta, pathlib.Path(r.get("file", "?")).name))
metrics = {r.get("metrics") for r in rows if r.get("metrics")}
print(f"메트릭 {'/'.join(sorted(metrics)) or '?'} · 채점 {scored}건 · 일치 {match} · 총 쪽 격차 {total}")
for delta, name in sorted(gaps, reverse=True):
    print(f"  {delta:+d}  {name}")
PY
