#!/usr/bin/env bash
# Launch the shared HwpWorkspace desktop shell in dev. The default Tauri config intentionally keeps
# the legacy shell; tauri.workspace.conf.json is the explicit, reversible workspace-shell override.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"

# crates/hwp-viewer/ui aliases these built package outputs directly. Build them first so desktop QA
# never exercises stale editor-core/react dist files.
pnpm -C "$root/packages/editor-core" build
pnpm -C "$root/packages/react" build

# Keep this QA shell off the legacy dev server's 1420 port. cargo-tauri 2.11.2 can continue after a
# failed beforeDevCommand, so fail here before Tauri can attach its WebView to a stale listener.
node "$root/scripts/assert-port-free.mjs" 1421 127.0.0.1

cd "$root/crates/hwp-viewer"
# The override starts Vite on the isolated port with a visible `--mode workspace` process argument.
# Keep the three QA features explicit: HWP parsing, production shaping, and native PDF export.
exec cargo tauri dev --config tauri.workspace.conf.json -f rhwp -f shaper -f pdf "$@"
