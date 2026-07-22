#!/usr/bin/env bash
# auto-hwp 컨텍스트 복원 — 새 세션/compact 후 이 스크립트 하나로 현재 위치를 복원한다.
# (roadmap-continuity 킷. 로드맵 정본: docs/PRODUCT-DIRECTION-V2.md + docs/issues/README.md,
#  이슈 상태의 진실은 git log — 아래에서 README 표 대신 git으로 미완료를 도출한다.)
set -uo pipefail
cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

echo "════════ CURRENT STATE (단일 복원 지점) ════════"
cat docs/CURRENT_STATE.md 2>/dev/null || echo "(없음 — docs/CURRENT_STATE.md 먼저 생성 필요)"

echo ""
echo "════════ JOURNAL 최근 2개 항목 ════════"
awk '/^## /{n++} n>2{exit} n>=1{print}' docs/JOURNAL.md 2>/dev/null || echo "(없음)"

echo ""
echo "════════ GIT ════════"
git log --oneline -5 2>/dev/null || echo "(git 저장소 아님)"
DIRTY=$(git status --short 2>/dev/null | head -20)
[ -n "$DIRTY" ] && { echo "-- dirty --"; echo "$DIRTY"; }

echo ""
echo "════════ 이슈 미완료 — git 진실 기준 (README 표는 낡을 수 있음) ════════"
# 구현 커밋은 "NNN:" 또는 "NNN(v2):"로 시작, 완료 마킹은 "docs: mark ... NNN".
for f in docs/issues/[0-9]*.md; do
  n=$(basename "$f" | cut -c1-3)
  impl=$(git log --oneline -E --grep="^${n}(\(v[0-9]+\))?:" 2>/dev/null | head -1)
  marked=$(git log --oneline -E --grep="mark[^0-9]*${n}([^0-9]|$)" 2>/dev/null | head -1)
  if [ -z "$impl" ] && [ -z "$marked" ]; then
    title=$(head -1 "$f" | sed 's/^# *//')
    echo "⬜ ${title}"
  fi
done
echo "(= 구현/완료 커밋이 없는 이슈. 착수 순서·의존은 docs/PRODUCT-DIRECTION-V2.md §3,"
echo " 착수 전 docs/PRODUCT-DIRECTION.md §4 공통 계약 + 이슈 파일 '함정' 절 필독)"
