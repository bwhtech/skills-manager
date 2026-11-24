#!/usr/bin/env bash
# Deploy a committed revision to the production checkout and restart the unit.
# Production never runs from the development checkout, so local builds and
# uncommitted edits there can't affect the live app.
#   scripts/deploy.sh            # deploy main
#   scripts/deploy.sh <rev>      # deploy a specific commit
# Settings come from .env in this checkout (see .env.example). The production
# checkout gets a symlink to it, because the server reads .env from its working dir.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ -f "$REPO/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$REPO/.env"
  set +a
fi
LIVE="${SKILLS_MANAGER_LIVE_DIR:-$REPO-live}"
UNIT="${SKILLS_MANAGER_UNIT:-skills-manager}"
PORT="${PORT:-3530}"
REV="${1:-main}"
SHA="$(git -C "$REPO" rev-parse --verify "$REV^{commit}")"

if [ ! -e "$LIVE/.git" ]; then
  git -C "$REPO" worktree add --detach "$LIVE" "$SHA"
else
  git -C "$LIVE" checkout --quiet --detach "$SHA"
fi

cd "$LIVE"
if [ -f "$REPO/.env" ]; then ln -sfn "$REPO/.env" "$LIVE/.env"; fi
bun install --frozen-lockfile
# Build next to the live dist, then swap, so the running server never serves a half-written folder.
bunx vite build --outDir dist.next --emptyOutDir
rm -rf dist.prev
if [ -d dist ]; then mv dist dist.prev; fi
mv dist.next dist

systemctl --user restart "$UNIT"
for _ in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
    echo "Deployed $(git rev-parse --short HEAD) to $LIVE${SKILLS_MANAGER_PUBLIC_URL:+ ($SKILLS_MANAGER_PUBLIC_URL)}"
    exit 0
  fi
  sleep 0.5
done
echo "Deployed $SHA but /api/health did not answer" >&2
exit 1
