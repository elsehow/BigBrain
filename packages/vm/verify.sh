#!/bin/sh
# The maintainer's Mac, after the spike: everything only a Mac can test.
# Builds both helpers, takes the CI image for this branch (as vm:spike
# does, unless one is already unpacked), then runs:
#   - the sandbox and Harbor's macOS tests, through a Seatbelt-confined guest (Phase 1)
#   - the VM suite and the contained-desktop suite on Virtualization.framework (Phases 3-4)
# and prints one line per suite.
#
#   bun run vm:verify [--run <ci-run-id>]
set -u
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
cd "$ROOT"
[ "$(uname -s)" = Darwin ] || { echo "vm:verify is for a Mac" >&2; exit 1; }
RUN=""; [ "${1:-}" = "--run" ] && RUN=$2
case "$(uname -m)" in arm64) ARCH=arm64 ;; x86_64) ARCH=amd64 ;; esac
IMAGE=$ROOT/packages/agents/image/out

echo "== helpers"
bun run guest:build >/dev/null || { echo "the guest didn't build" >&2; exit 1; }
sh packages/vm/build.sh >/dev/null || { echo "the helper didn't build" >&2; exit 1; }

if [ ! -f "$IMAGE/rootfs.img" ] || [ -n "$RUN" ]; then
  BRANCH=$(git rev-parse --abbrev-ref HEAD)
  [ -n "$RUN" ] || RUN=$(gh run list --workflow machine.yml --branch "$BRANCH" --status success --limit 1 --json databaseId --jq '.[0].databaseId')
  echo "== image: CI run $RUN"
  rm -rf "$IMAGE" && mkdir -p "$IMAGE"
  gh run download "$RUN" -n "machine-$ARCH" -D "$IMAGE" || exit 1
  bun packages/agents/src/image.ts "$IMAGE/rootfs.img.gz" "$IMAGE/rootfs.img" || exit 1
fi

results=""
suite() { # name, command...
  name=$1; shift
  echo "== $name"
  if "$@"; then results="$results\n  pass  $name"; else results="$results\n  FAIL  $name"; fi
}
suite "sandbox (Seatbelt, through the guest)" bun test packages/agents/test/sandbox.test.ts
suite "harbor and tools (macOS discovery)" bun test packages/agents/test/agents.test.ts packages/agents/test/guests.test.ts
suite "host desktops" bun test test/codingDesktops.test.ts
suite "a machine (VZ)" env BIGBRAIN_VM_TESTS=vz bun test packages/agents/test/machine.test.ts
suite "contained desktops (VZ)" env BIGBRAIN_VM_TESTS=vz bun test packages/agents/test/contained.test.ts
printf "\n== summary%b\n" "$results"
