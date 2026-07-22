#!/usr/bin/env bash
# Launch the auto-hwp desktop app in dev with BOTH features on:
#   rhwp = faithful page rendering, ai = the vibe-docs chat panel.
# Auto-loads repo-root .env (OPENROUTER_API_KEY / ANTHROPIC_API_KEY / AUTO_HWP_OPENROUTER_MODEL) so the
# app gets a real provider — Tauri/cargo do NOT read .env on their own. No key → Mock (demo) provider.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"

if [ -f "$root/.env" ]; then
  set -a            # export every var defined while sourcing
  # shellcheck disable=SC1091
  . "$root/.env"
  set +a
  if [ -n "${OPENROUTER_API_KEY:-}" ]; then
    echo "[app.sh] provider: OpenRouter (model ${AUTO_HWP_OPENROUTER_MODEL:-google/gemini-2.5-flash})"
  elif [ -n "${ANTHROPIC_API_KEY:-}" ]; then
    echo "[app.sh] provider: Anthropic"
  else
    echo "[app.sh] no key in .env → Mock (demo) provider. Add OPENROUTER_API_KEY to .env."
  fi
else
  echo "[app.sh] no .env found → Mock (demo) provider."
fi

cd "$root/crates/hwp-viewer"
# ai = vibe chat · shaper = real (rustybuzz) own-render fidelity · pdf = in-app PDF export.
exec cargo tauri dev -f ai -f shaper -f pdf "$@"
