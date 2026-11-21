#!/usr/bin/env bash
# Deploy a committed revision to the production checkout and restart the unit.
# Production never runs from the development checkout, so local builds and
# uncommitted edits there can't affect the live app.
#   scripts/deploy.sh            # deploy main
#   scripts/deploy.sh <rev>      # deploy a specific commit
set -euo pipefail
REPO=/mnt/data/skills-manager
LIVE=/mnt/data/skills-manager-live
REV="${1:-main}"
SHA="$(git -C "$REPO" rev-parse --verify "$REV^{commit}")"

if [ ! -e "$LIVE/.git" ]; then
  git -C "$REPO" worktree add --detach "$LIVE" "$SHA"
else
  git -C "$LIVE" checkout --quiet --detach "$SHA"
fi

cd "$LIVE"
bun install --frozen-lockfile
# Build next to the live dist, then swap, so the running server never serves a half-written folder.
bunx vite build --outDir dist.next --emptyOutDir
rm -rf dist.prev
if [ -d dist ]; then mv dist dist.prev; fi
mv dist.next dist

systemctl --user restart skills-manager
for _ in $(seq 1 20); do
  if curl -fsS http://127.0.0.1:3530/api/health >/dev/null 2>&1; then
    echo "Deployed $(git rev-parse --short HEAD) to $LIVE"
    exit 0
  fi
  sleep 0.5
done
echo "Deployed $SHA but /api/health did not answer" >&2
exit 1
