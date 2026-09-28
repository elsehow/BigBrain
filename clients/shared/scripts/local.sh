#!/bin/sh
# Pin the machine default rather than discovering a vault in the agent's project.
set -eu
if [ -z "${BIGBRAIN_VAULT:-}" ]; then
  BIGBRAIN_VAULT=$(cat "$HOME/.config/bigbrain/vault")
  export BIGBRAIN_VAULT
fi
case "$BIGBRAIN_VAULT" in /*) ;; *) echo 'BigBrain: connect a local vault first.' >&2; exit 1;; esac
if [ -x "$HOME/.local/bin/bigbrain" ]; then
  exec "$HOME/.local/bin/bigbrain" mcp "$@"
fi
exec bigbrain mcp "$@"
