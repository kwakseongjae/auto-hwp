#!/usr/bin/env bash
# Vendor rhwp as a *replaceable bootstrap* behind our capability traits.
# rhwp is NOT on crates.io, so we consume the Rust source via a pinned git submodule
# at external/rhwp (same pattern DanMeon/rhwp-python uses via PyO3 + submodule).
#
# Use YOUR fork so you can carry local patches (e.g. disabling the Hancom-incompatible
# HWPX serializer). Point RHWP_REMOTE at it:
#
#   RHWP_REMOTE=https://github.com/<you>/rhwp.git ./scripts/vendor-rhwp.sh
#
# Defaults to upstream edwardkim/rhwp if RHWP_REMOTE is unset.
set -euo pipefail

RHWP_REMOTE="${RHWP_REMOTE:-https://github.com/edwardkim/rhwp.git}"
RHWP_TAG="${RHWP_TAG:-v0.7.15}"
DEST="external/rhwp"

# rhwp keeps large Git-LFS test assets (pdf/, pdf-large/). We don't need them — skip the
# smudge so the clone stays small. Unset this if you later want the reference PDFs.
export GIT_LFS_SKIP_SMUDGE=1

cd "$(dirname "$0")/.."
[ -d .git ] || { echo "error: run from inside the git repo (git init first)." >&2; exit 1; }

# The placeholder dir blocks `submodule add`; clear it (keeps our README in git history).
if [ -d "$DEST" ] && [ ! -e "$DEST/.git" ]; then
  echo ">> clearing placeholder $DEST"
  git rm -r --cached "$DEST" 2>/dev/null || true
  rm -rf "$DEST"
fi

echo ">> adding submodule: $RHWP_REMOTE -> $DEST"
git submodule add --depth 1 "$RHWP_REMOTE" "$DEST"

echo ">> pinning to tag $RHWP_TAG"
git -C "$DEST" fetch --depth 1 origin "refs/tags/$RHWP_TAG:refs/tags/$RHWP_TAG"
git -C "$DEST" checkout "tags/$RHWP_TAG"

echo ">> vendored:"
git -C "$DEST" describe --tags --always 2>/dev/null || true
ls "$DEST" | head

cat <<'EOF'

NEXT (wire rhwp behind our traits):
  1. crates/hwp-rhwp/Cargo.toml: under the `rhwp` feature add path deps to the vendored
     rhwp crates (e.g. external/rhwp/crates/model, .../renderer).
  2. crates/hwp-rhwp/src/lib.rs: implement DocumentParser/LayoutEngine/Renderer under
     #[cfg(feature = "rhwp")] — translate SemanticDoc <-> rhwp Document at the model
     boundary; consume getPageLayerTree (PageLayerTree schemaVersion 1).
  3. Do NOT enable rhwp's HWPX/HWP save (issue #196). HwpxSerializer stays in hwp-hwpx.
  4. cargo build --features rhwp   (verify wasm32 build excludes native-skia).
EOF
echo ">> done."
