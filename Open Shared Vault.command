#!/bin/zsh
set -eu
cd "${0:A:h}"
export PATH="$HOME/.bun/bin:/opt/homebrew/bin:$PATH"
exec bun bin/shared-shell.ts --home "${SHARED_OWNER_HOME:-$HOME/Projects/bigbrain-shared-local}" --open
