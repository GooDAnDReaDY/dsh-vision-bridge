#!/usr/bin/env bash
# dsh-vision-bridge — canonical deploy entry point.
#
# Verified delivery method for this plugin (see AGENTS.md "Deployment"):
#   install the published immutable npm version into the DSH `web` profile,
#   restart dsh-web, then run the post-deploy health checks.
# This script contains no secrets, performs no rsync/scp, no git resets and
# never touches databases or runtime configs.
#
# Usage (on the DSH host, as the DSH owner):
#   ./deploy.sh                 # install @goodandready/dsh-vision-bridge@latest
#   ./deploy.sh 0.5.30          # install an exact published version
set -euo pipefail

VERSION="${1:-latest}"
PACKAGE="@goodandready/dsh-vision-bridge"
PROFILE="web"
SERVICE="dsh-web"

echo "== deploy ${PACKAGE}@${VERSION} into profile '${PROFILE}' =="

echo "-- pre-check: profile must not reference worktrees or source paths"
if [ -f "${HOME}/.dsh/settings.yaml" ]; then
  if grep -nE '\.worktrees/|file:' "${HOME}/.dsh/settings.yaml" | grep -i "vision-bridge"; then
    echo "ERROR: profile references a worktree/file path for ${PACKAGE}; refusing to deploy." >&2
    exit 1
  fi
fi

echo "-- install"
if [ "$VERSION" = "latest" ]; then
  dsh plugin --profile "$PROFILE" add "$PACKAGE"
else
  dsh plugin --profile "$PROFILE" add "${PACKAGE}@${VERSION}"
fi

echo "-- restart ${SERVICE}"
systemctl restart "$SERVICE"
sleep 2
systemctl is-active "$SERVICE"

echo "-- post-deploy checks"
code() { curl -s -o /dev/null -w '%{http_code}' "$1"; }
echo "index:            $(code http://127.0.0.1:3080/)"
echo "/doctor:          $(code http://127.0.0.1:3080/dsh-vision-bridge/doctor)"
echo "/stats:           $(code http://127.0.0.1:3080/dsh-vision-bridge/stats)"
echo "/channels:        $(code http://127.0.0.1:3080/dsh-vision-bridge/channels)"
echo "client.js:        $(code http://127.0.0.1:3080/plugins/@goodandready/dsh-vision-bridge/client.js)"

echo "-- installed version"
dsh plugin --profile "$PROFILE" list 2>/dev/null | grep -i "vision-bridge" || true

echo "== deploy done =="
