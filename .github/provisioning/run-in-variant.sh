#!/usr/bin/env bash
# Runs one task command for a provisioning-comparison variant (issue #211).
# The host variant (ubuntu) runs it directly; the container variant runs it in
# the prebuilt agent image as the runner user, mounting the checkout and the
# same persisted cache directories the host variants use.
set -euo pipefail

command="$1"
if [[ "${VARIANT:?}" != container ]]; then
  exec bash -euo pipefail -c "$command"
fi

mkdir -p "$HOME/.cargo/registry" "$HOME/.cargo/git" "$HOME/.bun/install/cache"
exec docker run --rm \
  --user "$(id -u):$(id -g)" \
  --env HOME=/tmp/agent-home \
  --env BUN_INSTALL_CACHE_DIR=/cache/bun \
  --env CI=true \
  --volume "$PWD:$PWD" \
  --workdir "$PWD" \
  --volume "$HOME/.cargo/registry:/usr/local/cargo/registry" \
  --volume "$HOME/.cargo/git:/usr/local/cargo/git" \
  --volume "$HOME/.bun/install/cache:/cache/bun" \
  "${AGENT_IMAGE:?}" \
  bash -euo pipefail -c "mkdir -p \"\$HOME\"; git config --global --add safe.directory '$PWD'; $command"
