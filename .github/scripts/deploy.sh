#!/usr/bin/env bash
set -euo pipefail
set +x
umask 077
for name in IMAGE_DIGEST RELEASE_VERSION DEPLOY_HOST DEPLOY_USER DEPLOY_SSH_KEY DEPLOY_KNOWN_HOSTS GH_TOKEN GITHUB_SHA GITHUB_RUN_NUMBER; do
  if [[ -z "${!name:-}" ]]; then echo "Missing deployment input: $name" >&2; exit 1; fi
done
[[ "$IMAGE_DIGEST" =~ ^sha256:[a-f0-9]{64}$ ]]
[[ "$GITHUB_SHA" =~ ^[a-f0-9]{40}$ ]]
[[ "$RELEASE_VERSION" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]
[[ "$GITHUB_RUN_NUMBER" =~ ^[1-9][0-9]{0,11}$ ]]
[[ "$DEPLOY_USER" =~ ^[a-z_][a-z0-9_-]*$ ]]
[[ "$DEPLOY_HOST" =~ ^[a-zA-Z0-9.-]+$ ]]
directory=$(mktemp -d)
trap 'rm -rf "$directory"' EXIT
printf '%s\n' "$DEPLOY_SSH_KEY" > "$directory/key"
printf '%s\n' "$DEPLOY_KNOWN_HOSTS" > "$directory/known_hosts"
printf '%s' "$GH_TOKEN" | ssh -T -i "$directory/key" \
  -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile="$directory/known_hosts" -o ConnectTimeout=15 \
  -o ServerAliveInterval=20 -o ServerAliveCountMax=6 \
  "$DEPLOY_USER@$DEPLOY_HOST" \
  "deploy $IMAGE_DIGEST $GITHUB_SHA $RELEASE_VERSION $GITHUB_RUN_NUMBER"
