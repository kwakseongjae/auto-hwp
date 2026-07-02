#!/usr/bin/env bash
#
# wasm-smoke.sh — issue 007 (P0-A): does the core compile to wasm32-unknown-unknown?
#
# This is a JUDGEMENT harness, not a feature. It runs `cargo check` for the core
# crates against wasm32-unknown-unknown and reports a per-combo verdict. The full
# writeup + architecture decision lives in docs/WASM-FEASIBILITY.md.
#
# Verdict as of 2026-07-02: A안 — ALL 11 combos pass (rhwp + krilla compile to wasm).
# Every combo below is therefore in the PASS set: the script exits non-zero if ANY
# of them regresses. If a combo ever starts failing, MOVE it out of PASS_SET into
# a commented "known-failing" note below (with the offending crate/API) rather than
# deleting it, and downgrade the architecture verdict in docs/WASM-FEASIBILITY.md.
#
# NOTE: wasm32-unknown-unknown gives std::fs a compile-time stub, so `cargo check`
# passing does NOT prove runtime works. Font loading via std::fs (hwp-typeset/src/
# shaper.rs, hwp-export/src/pdf.rs) compiles but traps at runtime on wasm — that is
# a 015 concern (inject font bytes), not a 007 compile blocker.

set -u

TARGET="wasm32-unknown-unknown"

# --- ensure the target is installed (offline-friendly: skip if already present) ---
if ! rustup target list --installed 2>/dev/null | grep -q "^${TARGET}$"; then
  echo ">> installing rust target ${TARGET}"
  rustup target add "${TARGET}" || {
    echo "!! could not add ${TARGET} (offline?). Install it and re-run." >&2
    exit 2
  }
fi

# --- PASS set: (label, cargo check args...) one per line ---
# Each entry is a full `cargo check` invocation minus the `--target` flag.
PASS_SET=(
  "-p hwp-model"
  "-p hwp-ops"
  "-p hwp-typeset"
  "-p hwp-typeset --features shaper"
  "-p hwp-render"
  "-p hwp-hwpx"
  "-p hwp-jsx"
  "-p hwp-export"
  "-p hwp-export --features pdf"
  "-p hwp-ingest"
  "-p hwp-rhwp --features rhwp"
)

# --- known-failing set (none as of A안) ---
# When a combo fails, record it here as: "  <combo>  # cause: <crate>::<api>"
# and REMOVE it from PASS_SET so exit 0 still means "the pass set is green".
FAIL_SET=(
)

fail=0
pass=0
echo "== wasm smoke (${TARGET}) =="
for combo in "${PASS_SET[@]}"; do
  printf '  %-40s ' "${combo}"
  # shellcheck disable=SC2086
  if cargo check ${combo} --target "${TARGET}" >/dev/null 2>&1; then
    echo "PASS"
    pass=$((pass + 1))
  else
    echo "FAIL  <-- regressed out of PASS_SET"
    fail=$((fail + 1))
  fi
done

echo "-- ${pass} passed, ${fail} failed (of ${#PASS_SET[@]} in PASS_SET) --"
if [ "${#FAIL_SET[@]}" -gt 0 ]; then
  echo "-- known-failing (not gated): ${#FAIL_SET[@]} --"
fi

# exit 0 only if the whole PASS set is green
[ "${fail}" -eq 0 ]
