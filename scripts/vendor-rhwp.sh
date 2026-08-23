#!/usr/bin/env bash
# Initialize or repin the governed rhwp fork. Never deletes or rewrites a dirty checkout.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
POLICY="$ROOT/docs/rhwp-fork-policy.json"
DEST="$ROOT/external/rhwp"

node_value() {
  node -e 'const p=require(process.argv[1]); process.stdout.write(String(p[process.argv[2]]))' "$POLICY" "$1"
}

RHWP_REMOTE="$(node_value fork_repo)"
RHWP_TAG="$(node_value fork_release_tag)"
RHWP_COMMIT="$(node_value fork_commit)"

case "$RHWP_COMMIT" in
  [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]) ;;
  *) echo "error: policy fork_commit must be 40 lowercase hex" >&2; exit 1 ;;
esac

cd "$ROOT"
export GIT_LFS_SKIP_SMUDGE=1
git submodule set-url external/rhwp "$RHWP_REMOTE"
git submodule update --init external/rhwp

if [ -n "$(git -C "$DEST" status --porcelain)" ]; then
  echo "error: external/rhwp is dirty; refusing to repin" >&2
  exit 1
fi

git -C "$DEST" fetch --depth 1 origin "refs/tags/$RHWP_TAG:refs/tags/$RHWP_TAG"
TAG_COMMIT="$(git -C "$DEST" rev-list -n 1 "$RHWP_TAG")"
if [ "$TAG_COMMIT" != "$RHWP_COMMIT" ]; then
  echo "error: $RHWP_TAG resolves to $TAG_COMMIT, policy requires $RHWP_COMMIT" >&2
  exit 1
fi
git -C "$DEST" checkout --detach "$RHWP_COMMIT"

node scripts/verify-rhwp-boundary.mjs
cat <<EOF
rhwp pinned: $RHWP_REMOTE $RHWP_TAG $RHWP_COMMIT
NEXT: review the gitlink diff, update Cargo.lock if needed, then run scripts/verify-local.sh --full.
EOF
