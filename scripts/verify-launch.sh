#!/usr/bin/env bash
# 오픈소스 런칭 전용 게이트. 평소 verify-local과 분리해 준비 중인 출시 항목이 개발 검증을 깨뜨리지 않게 한다.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

MODE="${1:---report}"
node --test scripts/tests/launch-readiness.test.mjs

case "$MODE" in
  --report)
    node scripts/launch-readiness.mjs
    ;;
  --strict)
    node scripts/launch-readiness.mjs --strict
    ;;
  --automated)
    node scripts/launch-readiness.mjs --automated --strict
    ;;
  --consumer)
    node scripts/launch-readiness.mjs --automated --strict
    node scripts/fresh-consumer-smoke.mjs
    ;;
  --browser)
    node scripts/launch-readiness.mjs --pre-live --strict
    pnpm -C apps/hwp-lab exec playwright test --config=playwright.launch.config.ts
    ;;
  *)
    echo "사용: scripts/verify-launch.sh [--report|--automated|--consumer|--strict|--browser]" >&2
    exit 2
    ;;
esac
