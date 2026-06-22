#!/usr/bin/env bash
# Launch the tf-hwp desktop app in dev with BOTH features on:
#   rhwp = faithful page rendering, ai = the vibe-docs chat panel.
# Usage: ./scripts/app.sh   (set ANTHROPIC_API_KEY first for real AI; else Mock provider)
set -euo pipefail
cd "$(dirname "$0")/../crates/hwp-viewer"
exec cargo tauri dev -f ai "$@"
