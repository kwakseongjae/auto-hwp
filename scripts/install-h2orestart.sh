#!/usr/bin/env bash
# Install the H2Orestart LibreOffice extension so the fidelity oracle can open modern
# HWP v5 / HWPX (the native hwpfilter only handles HWP v3).
#
# H2Orestart is GPL-3.0 and runs ONLY out-of-process inside LibreOffice — it is never
# linked into our engine (see docs/LICENSE-POLICY.md). This installs it into the local
# LibreOffice for use as a *reference oracle* only.
set -euo pipefail

VER="${H2O_VERSION:-0.7.12}"
URL="https://github.com/ebandal/H2Orestart/releases/download/v${VER}/H2Orestart.oxt"
DEST="${TMPDIR:-/tmp}/H2Orestart-${VER}.oxt"

command -v unopkg >/dev/null 2>&1 || { echo "error: unopkg not found (install LibreOffice)"; exit 1; }

echo ">> downloading H2Orestart v${VER}"
curl -fsSL "$URL" -o "$DEST"
echo ">> registering with LibreOffice (unopkg add)"
unopkg add "$DEST"
echo ">> installed extensions:"
unopkg list | grep -i -E "h2o|hwp|ebandal" || true
echo ">> done. Verify:  cargo run -p auto-hwp-cli -- oracle benchmark.hwp --out /tmp"
